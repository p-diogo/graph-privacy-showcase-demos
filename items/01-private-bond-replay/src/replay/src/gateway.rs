//! Talking to the gateway, and reconstructing exactly what it signed over.
//!
//! The client never sees the bytes the indexer attested to. It sees its own
//! POST body and the response body. The `requestCID` in the attestation is a
//! hash of a *third* string: the one the gateway rebuilt after parsing the
//! client's request. Verifying an attestation therefore means reproducing the
//! gateway's parse-and-re-serialize step, and this module is that step.
//!
//! Verified against `edgeandnode/gateway@1a4aa86`, `src/client_query.rs`:
//!
//! ```ignore
//! let variables_json = client_request.variables.as_ref()
//!     .map(ToString::to_string).unwrap_or_default();
//! let variables = parse_variables(&variables_json)?;
//! let indexer_query = serde_json::to_string(&json!({
//!     "query": client_request.query,
//!     "variables": variables,
//! })).unwrap();
//! ```

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use thegraph_core::attestation::Attestation;

/// The response header carrying the attestation
/// (`toolshed/thegraph-headers/src/graph_attestation.rs`).
pub const ATTESTATION_HEADER: &str = "graph-attestation";

/// Rebuild the string the gateway forwards to indexers, for a query with no
/// variables.
///
/// Restricted to the no-variable case on purpose. `parse_variables` yields a
/// `graphql::QueryVariables`, which wraps a `HashMap`; its serializer iterates
/// that map directly, so with two or more variables the byte order of the
/// forwarded string is whatever the gateway's hasher happened to produce that
/// run. A client cannot reproduce it, and an unreproducible `requestCID` is an
/// unverifiable attestation. Inlining arguments into the query text is not a
/// style preference here — it is the only way the check is sound.
///
/// `parse_variables` maps `""`, `"null"` and `"{}"` alike to the default
/// (empty) map, so all three client spellings converge on the same string.
pub fn canonical_request_string_no_variables(query: &str) -> String {
    serde_json::to_string(&serde_json::json!({
        "query": query,
        "variables": {},
    }))
    .expect("serializing a string and an empty map cannot fail")
}

/// The body the client POSTs. Distinct from the string above: the gateway
/// re-serializes rather than forwarding these bytes.
pub fn client_post_body(query: &str) -> String {
    serde_json::to_string(&serde_json::json!({ "query": query }))
        .expect("serializing a string cannot fail")
}

/// A captured, self-contained audit bundle.
///
/// Holds everything a third party needs to re-verify without trusting us or
/// the gateway: the exact request string that was hashed, the response bytes
/// verbatim as received, and the attestation over both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditBundle {
    pub schema: String,
    /// The gateway-canonical request string, i.e. the `requestCID` preimage.
    pub request: String,
    /// The response body exactly as received. Any re-encoding breaks
    /// `responseCID`, so this is stored as a string and never reformatted.
    pub response: String,
    pub attestation: Attestation,
    /// Subgraph deployment (Qm... form) the query was routed to.
    pub deployment: String,
    /// Endpoint the bundle came from, for provenance. Not trusted by any check.
    pub endpoint: String,
    /// Indexer address, when the bundle came from the targeted per-indexer
    /// route. Self-reported routing metadata — the attestation signer is the
    /// authority on who actually answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routed_indexer: Option<String>,
}

impl AuditBundle {
    pub const SCHEMA: &'static str = "bond-replay/audit-bundle/1";
}

/// Parse the `graph-attestation` header value.
pub fn parse_attestation_header(value: &str) -> Result<Attestation> {
    serde_json::from_str(value).context("graph-attestation header is not a valid attestation")
}

pub struct GatewayClient {
    http: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
}

impl GatewayClient {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Result<Self> {
        Ok(GatewayClient {
            http: reqwest::Client::builder()
                .user_agent("bond-replay/0.1")
                .build()
                .context("cannot build HTTP client")?,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
        })
    }

    pub fn deployment_url(&self, deployment: &str) -> String {
        format!("{}/api/deployments/id/{}", self.base_url, deployment)
    }

    /// The targeted per-indexer route (gateway `src/main.rs` L210-213). This
    /// is the only route that can support a k-distinct-signer claim, because
    /// it is the only one where the client chooses who answers.
    pub fn indexer_url(&self, deployment: &str, indexer: &str) -> String {
        format!(
            "{}/api/deployments/id/{}/indexers/id/{}",
            self.base_url, deployment, indexer
        )
    }

    /// POST a query and capture the attested bundle.
    ///
    /// Fails closed when the `graph-attestation` header is absent. An
    /// unattested response is not evidence of anything, and silently
    /// downgrading to "we got an answer" is exactly the failure this item
    /// exists to make impossible.
    pub async fn fetch(
        &self,
        url: &str,
        query: &str,
        deployment: &str,
        routed_indexer: Option<String>,
    ) -> Result<AuditBundle> {
        let mut request = self
            .http
            .post(url)
            .header("content-type", "application/json")
            .body(client_post_body(query));

        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("request to {url} failed"))?;

        let status = response.status();
        let attestation_header = response
            .headers()
            .get(ATTESTATION_HEADER)
            .map(|v| v.to_str().map(str::to_owned))
            .transpose()
            .context("graph-attestation header is not valid UTF-8")?;

        // Read as bytes, then interpret as UTF-8 exactly once. `responseCID`
        // is keccak over these bytes; any lossy conversion would silently
        // change the hash.
        let body_bytes = response.bytes().await.context("cannot read response body")?;
        let body = String::from_utf8(body_bytes.to_vec())
            .context("response body is not valid UTF-8")?;

        if !status.is_success() {
            bail!("gateway returned HTTP {status}: {body}");
        }

        let Some(header) = attestation_header else {
            bail!(
                "response from {url} carries no `{ATTESTATION_HEADER}` header. \
                 An unattested response cannot back any claim in this item; failing closed."
            );
        };

        Ok(AuditBundle {
            schema: AuditBundle::SCHEMA.to_string(),
            request: canonical_request_string_no_variables(query),
            response: body,
            attestation: parse_attestation_header(&header)?,
            deployment: deployment.to_string(),
            endpoint: url.to_string(),
            routed_indexer,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference implementation of the gateway's serialization, transcribed
    /// from `client_query.rs` at the pinned SHA. If our builder ever drifts
    /// from the transcription, this fails.
    ///
    /// This is the load-bearing gate the spec names for §4.4 step 2: the
    /// reconstruction is tested, not assumed.
    fn gateway_reference_serialization(query: &str, client_variables: Option<&str>) -> String {
        // variables_json = client_request.variables.map(ToString::to_string).unwrap_or_default()
        let variables_json = client_variables.unwrap_or("").to_string();

        // parse_variables: "{}" | "null" | "" all collapse to the default map
        let variables: serde_json::Value = {
            let vars = variables_json.trim();
            if ["{}", "null", ""].contains(&vars) {
                serde_json::json!({})
            } else {
                serde_json::from_str(vars).expect("test only passes parseable variables")
            }
        };

        serde_json::to_string(&serde_json::json!({
            "query": query,
            "variables": variables,
        }))
        .unwrap()
    }

    #[test]
    fn request_string_matches_the_gateway_serialization_byte_for_byte() {
        for query in [
            "{_meta{block{number hash}}}",
            crate::anchors::audit_query(&crate::anchors::BlockPinValue::Number(1234)).as_str(),
            crate::anchors::audit_query(&crate::anchors::BlockPinValue::Hash("0xabcdef".into()))
                .as_str(),
        ] {
            assert_eq!(
                canonical_request_string_no_variables(query),
                gateway_reference_serialization(query, None),
                "reconstruction drifted from the gateway's serialization"
            );
        }
    }

    #[test]
    fn all_three_empty_variable_spellings_converge() {
        let query = "{_meta{block{number}}}";
        let ours = canonical_request_string_no_variables(query);

        for spelling in [None, Some(""), Some("{}"), Some("null")] {
            assert_eq!(
                ours,
                gateway_reference_serialization(query, spelling),
                "client spelling {spelling:?} should not change the forwarded bytes"
            );
        }
    }

    #[test]
    fn request_string_has_query_before_variables() {
        // Field order is part of the preimage; serde_json::json! preserves
        // literal order, and the gateway's literal is query-then-variables.
        let s = canonical_request_string_no_variables("{x}");
        assert_eq!(s, r#"{"query":"{x}","variables":{}}"#);
    }

    #[test]
    fn the_posted_body_is_not_the_attested_string() {
        // A client that hashed its own POST body would compute the wrong
        // requestCID. Keeping these visibly different guards against that.
        let query = "{x}";
        assert_ne!(
            client_post_body(query),
            canonical_request_string_no_variables(query)
        );
    }

    #[test]
    fn attestation_header_parses_the_documented_wire_format() {
        let header = r#"{"requestCID":"0x41b1a0649752af1b28b3dc29a1556eee781e4a4c3a1f7f53f90fa834de098c4d",
            "responseCID":"0x435cd288e3694b535549c3af56ad805c149f92961bf84a1c647f7d86fc2431b4",
            "subgraphDeploymentID":"0xd0bc0f2f1b5e5f5b0e5b4a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
            "r":"0xe1fb47e7f0b278d4c88564c3a3b46180e476edcb2b783f253f3eec3b36f8fd4f",
            "s":"0x467a881937edf2faf76e2e497085caf370c9689a1d83b245030757f70a1f64de",
            "v":28}"#;
        let attestation = parse_attestation_header(header).unwrap();
        assert_eq!(attestation.v, 28);
    }
}
