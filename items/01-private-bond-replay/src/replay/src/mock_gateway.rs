//! A gateway shim that implements the parts of the real gateway's contract
//! the replay CLI depends on.
//!
//! TEST AND DEMO INFRASTRUCTURE. This is not a gateway, it serves no real
//! traffic, and its attestations are signed by throwaway keys with no
//! allocation and no stake behind them. Nothing it produces is evidence of
//! anything about the decentralized network.
//!
//! Its purpose is to let the whole audit path — fetch, attestation
//! verification, reconciliation, tamper detection, cross-signer comparison —
//! be exercised end to end without spending funds or touching the production
//! gateway. It reproduces three behaviours that the CLI's correctness depends
//! on, and getting them wrong here would make the tests prove nothing:
//!
//! 1. it re-serializes the request the way the gateway does, rather than
//!    forwarding the client's bytes, so `requestCID` is computed over the
//!    same preimage the real path uses;
//! 2. it returns the upstream response body verbatim, so `responseCID` binds
//!    real bytes;
//! 3. it puts the attestation in the `graph-attestation` response header.
//!
//! It can also be told to lie, which is how the tamper and divergence cases
//! are exercised against a serving layer that signs its own alterations.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use thegraph_core::{attestation, DeploymentId};

use crate::attestation::DomainConfig;
use crate::gateway::ATTESTATION_HEADER;

/// How a given mock indexer answers.
#[derive(Clone)]
pub enum Behaviour {
    /// Serve the configured body verbatim and attest it honestly.
    Honest(String),
    /// Serve a different body, and sign *that* body correctly.
    ///
    /// This is the lying serving layer: the attestation is valid, the data is
    /// not. It is the only way to demonstrate that the chain rather than the
    /// signature is what catches altered anchors.
    LyingButValidlySigned(String),
    /// Serve a body with no attestation header at all. The CLI must fail
    /// closed rather than treat it as an answer.
    Unattested(String),
    /// Forward the query to a real graph-node and attest whatever it answers.
    ///
    /// This is what makes a local run genuinely end-to-end: the bytes being
    /// reconciled are real indexer output, not a fixture written to pass.
    Proxy { upstream: String },
}

impl Behaviour {
    /// Resolve to the bytes this indexer will return for `query_body`.
    async fn body(&self, query_body: &[u8]) -> Result<String> {
        match self {
            Behaviour::Honest(b)
            | Behaviour::LyingButValidlySigned(b)
            | Behaviour::Unattested(b) => Ok(b.clone()),
            Behaviour::Proxy { upstream } => {
                let response = reqwest::Client::new()
                    .post(upstream)
                    .header("content-type", "application/json")
                    .body(query_body.to_vec())
                    .send()
                    .await
                    .with_context(|| format!("cannot reach upstream {upstream}"))?;
                response.text().await.context("cannot read upstream body")
            }
        }
    }
}

#[derive(Clone)]
pub struct MockIndexer {
    pub signer: PrivateKeySigner,
    pub behaviour: Behaviour,
}

impl MockIndexer {
    pub fn honest(body: impl Into<String>) -> Self {
        MockIndexer {
            signer: PrivateKeySigner::random(),
            behaviour: Behaviour::Honest(body.into()),
        }
    }

    pub fn lying(body: impl Into<String>) -> Self {
        MockIndexer {
            signer: PrivateKeySigner::random(),
            behaviour: Behaviour::LyingButValidlySigned(body.into()),
        }
    }

    pub fn unattested(body: impl Into<String>) -> Self {
        MockIndexer {
            signer: PrivateKeySigner::random(),
            behaviour: Behaviour::Unattested(body.into()),
        }
    }

    pub fn proxying(upstream: impl Into<String>) -> Self {
        MockIndexer {
            signer: PrivateKeySigner::random(),
            behaviour: Behaviour::Proxy {
                upstream: upstream.into(),
            },
        }
    }

    pub fn address(&self) -> String {
        self.signer.address().to_string().to_lowercase()
    }
}

struct Inner {
    domain: DomainConfig,
    deployment: DeploymentId,
    /// Answers the main route, which returns "whatever indexer won".
    default_indexer: MockIndexer,
    /// Answers the targeted per-indexer route, keyed by lowercase address.
    by_indexer: HashMap<String, MockIndexer>,
    /// When false, the targeted route 404s — the case where production has not
    /// exposed it for this key tier (spec §9.5).
    targeted_route_enabled: bool,
}

#[derive(Clone)]
pub struct MockGateway {
    inner: Arc<Inner>,
}

pub struct RunningMockGateway {
    pub base_url: String,
    handle: tokio::task::JoinHandle<()>,
}

impl RunningMockGateway {
    pub fn shutdown(self) {
        self.handle.abort();
    }
}

impl MockGateway {
    pub fn new(domain: DomainConfig, deployment: &str, default_indexer: MockIndexer) -> Result<Self> {
        Ok(MockGateway {
            inner: Arc::new(Inner {
                domain,
                deployment: deployment.parse().context("deployment id")?,
                default_indexer,
                by_indexer: HashMap::new(),
                targeted_route_enabled: true,
            }),
        })
    }

    pub fn with_indexers(mut self, indexers: Vec<MockIndexer>) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("no clones yet");
        for indexer in indexers {
            inner.by_indexer.insert(indexer.address(), indexer);
        }
        self
    }

    pub fn without_targeted_route(mut self) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("no clones yet")
            .targeted_route_enabled = false;
        self
    }

    pub fn indexer_addresses(&self) -> Vec<String> {
        let mut addresses: Vec<String> = self.inner.by_indexer.keys().cloned().collect();
        addresses.sort();
        addresses
    }

    pub async fn serve(self) -> Result<RunningMockGateway> {
        self.serve_on(0).await
    }

    /// Bind a specific port. Port 0 asks the OS for a free one, which is what
    /// the in-process tests use so they can run concurrently.
    pub async fn serve_on(self, port: u16) -> Result<RunningMockGateway> {
        let app = Router::new()
            .route("/api/deployments/id/{deployment}", post(handle_main))
            .route(
                "/api/deployments/id/{deployment}/indexers/id/{indexer}",
                post(handle_targeted),
            )
            .with_state(self);

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
            .await
            .context("cannot bind mock gateway")?;
        let addr = listener.local_addr()?;

        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        Ok(RunningMockGateway {
            base_url: format!("http://{addr}"),
            handle,
        })
    }
}

/// Reproduce the gateway's parse-and-re-serialize step.
///
/// Transcribed from `client_query.rs` at the pinned SHA. If this drifted from
/// the real thing, every attestation the mock produces would bind a preimage
/// the CLI does not reconstruct, and the tests would fail — which is the
/// intended safety property, not a hazard.
fn canonical_request(body: &[u8]) -> Result<String> {
    let parsed: serde_json::Value =
        serde_json::from_slice(body).context("client body is not JSON")?;

    let query = parsed
        .get("query")
        .and_then(|q| q.as_str())
        .context("client body has no query")?;

    let variables_json = parsed
        .get("variables")
        .map(|v| v.to_string())
        .unwrap_or_default();

    let variables: serde_json::Value = {
        let vars = variables_json.trim();
        if ["{}", "null", ""].contains(&vars) {
            serde_json::json!({})
        } else {
            serde_json::from_str(vars).context("variables are not JSON")?
        }
    };

    Ok(serde_json::to_string(&serde_json::json!({
        "query": query,
        "variables": variables,
    }))?)
}

async fn answer(gateway: &MockGateway, indexer: &MockIndexer, request_body: &[u8]) -> Response {
    let request = match canonical_request(request_body) {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("{e:#}")).into_response(),
    };

    let body = match indexer.behaviour.body(request_body).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
    };

    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));

    if !matches!(indexer.behaviour, Behaviour::Unattested(_)) {
        // Signed over the body actually being returned. For the lying
        // indexer that means a valid signature over wrong data, which is the
        // whole point of that behaviour.
        let attestation = attestation::create(
            &gateway.inner.domain.eip712(),
            &indexer.signer,
            &gateway.inner.deployment,
            &request,
            &body,
        );
        let encoded = serde_json::to_string(&attestation).expect("attestation serializes");
        headers.insert(
            ATTESTATION_HEADER,
            HeaderValue::from_str(&encoded).expect("attestation header is ASCII"),
        );
    }

    (StatusCode::OK, headers, body).into_response()
}

async fn handle_main(
    State(gateway): State<MockGateway>,
    Path(_deployment): Path<String>,
    body: Bytes,
) -> Response {
    let indexer = gateway.inner.default_indexer.clone();
    answer(&gateway, &indexer, &body).await
}

async fn handle_targeted(
    State(gateway): State<MockGateway>,
    Path((_deployment, indexer_address)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    if !gateway.inner.targeted_route_enabled {
        // Mirrors the production uncertainty in spec §9.5: the route exists at
        // source, but may not be exposed for a given key tier.
        return (StatusCode::NOT_FOUND, "no route").into_response();
    }

    match gateway.inner.by_indexer.get(&indexer_address.to_lowercase()) {
        Some(indexer) => {
            let indexer = indexer.clone();
            answer(&gateway, &indexer, &body).await
        }
        None => (StatusCode::NOT_FOUND, "unknown indexer").into_response(),
    }
}

/// A stub network subgraph, so signer resolution can be exercised without
/// querying the real one.
///
/// It answers `allocation(id:)` and `allocations(where:)` for a fixed set of
/// mock indexers. The stake figures are fictional and mean nothing.
pub async fn serve_network_subgraph_stub(
    indexers: Vec<(String, String)>,
    deployment: String,
) -> Result<RunningMockGateway> {
    let state = Arc::new((indexers, deployment));

    let app = Router::new()
        .route(
            "/",
            post(
                |State(state): State<Arc<(Vec<(String, String)>, String)>>, body: Bytes| async move {
                    let (indexers, deployment) = &*state;
                    let parsed: serde_json::Value =
                        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
                    let query = parsed.get("query").and_then(|q| q.as_str()).unwrap_or("");

                    if query.contains("allocations(") {
                        let allocations: Vec<serde_json::Value> = indexers
                            .iter()
                            .map(|(allocation, indexer)| {
                                serde_json::json!({
                                    "id": allocation,
                                    "indexer": {"id": indexer, "stakedTokens": "100000000000000000000000"}
                                })
                            })
                            .collect();
                        return axum::Json(serde_json::json!({
                            "data": {"allocations": allocations}
                        }));
                    }

                    // allocation(id:"0x..") — pull the id out of the query text.
                    let wanted = query
                        .split("id:\"")
                        .nth(1)
                        .and_then(|rest| rest.split('"').next())
                        .unwrap_or("")
                        .to_lowercase();

                    let found = indexers
                        .iter()
                        .find(|(allocation, _)| allocation.to_lowercase() == wanted);

                    match found {
                        Some((allocation, indexer)) => axum::Json(serde_json::json!({
                            "data": {"allocation": {
                                "id": allocation,
                                "status": "Active",
                                "allocatedTokens": "5000000000000000000000",
                                "indexer": {"id": indexer, "stakedTokens": "100000000000000000000000"},
                                "subgraphDeployment": {"ipfsHash": deployment}
                            }}
                        })),
                        None => axum::Json(serde_json::json!({"data": {"allocation": null}})),
                    }
                },
            ),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok(RunningMockGateway {
        base_url: format!("http://{addr}"),
        handle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_request_matches_the_cli_reconstruction() {
        // If these two ever diverge, every attestation the mock signs would
        // bind a preimage the CLI cannot reproduce. Asserting it here means a
        // green end-to-end test cannot be hiding that.
        let query = "{_meta{block{number}}}";
        let client_body = crate::gateway::client_post_body(query);

        assert_eq!(
            canonical_request(client_body.as_bytes()).unwrap(),
            crate::gateway::canonical_request_string_no_variables(query)
        );
    }
}
