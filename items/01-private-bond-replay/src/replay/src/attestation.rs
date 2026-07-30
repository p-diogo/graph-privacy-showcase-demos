//! Attestation verification and signer resolution.
//!
//! What an attestation is, precisely: an EIP-712 **signature** by the key of a
//! staked allocation, over `keccak(request) || keccak(response) ||
//! deploymentID`. It makes a wrong answer attributable and slashable. It is
//! **not** a validity proof — nothing here establishes that the served data is
//! correct, only that a identifiable, staked party is on the hook for it.
//! Every message this module emits is worded to that standard.
//!
//! Verification runs `thegraph-core`'s own code — the same crate the gateway
//! uses — rather than a local EIP-712 reimplementation, so there is no second
//! implementation to drift.

use alloy::primitives::{Address, ChainId, B256};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use thegraph_core::{
    attestation::{self},
    DeploymentId,
};

use crate::gateway::AuditBundle;

/// Arbitrum One, where the protocol contracts live.
pub const DEFAULT_CHAIN_ID: ChainId = 42161;

/// DisputeManager on Arbitrum One, from graphprotocol/contracts
/// `packages/contracts/addresses.json`.
///
/// The production gateway's attestation-domain config is not published. The
/// CLI uses these values and treats successful allocation resolution as
/// confirmation that the domain was right; if recovery succeeds but the signer
/// resolves to nothing, it says exactly that rather than asserting a signer.
pub const DEFAULT_DISPUTE_MANAGER: &str = "0x0Ab2B043138352413Bb02e67E626a70320E3BD46";

#[derive(Debug, Clone)]
pub struct DomainConfig {
    pub chain_id: ChainId,
    pub dispute_manager: Address,
}

impl Default for DomainConfig {
    fn default() -> Self {
        DomainConfig {
            chain_id: DEFAULT_CHAIN_ID,
            dispute_manager: DEFAULT_DISPUTE_MANAGER
                .parse()
                .expect("built-in dispute manager address parses"),
        }
    }
}

impl DomainConfig {
    pub fn eip712(&self) -> alloy::sol_types::Eip712Domain {
        attestation::eip712_domain(self.chain_id, self.dispute_manager)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckOutcome {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub step: String,
    pub outcome: CheckOutcome,
    pub detail: String,
}

impl CheckResult {
    fn pass(step: &str, detail: impl Into<String>) -> Self {
        CheckResult {
            step: step.to_string(),
            outcome: CheckOutcome::Pass,
            detail: detail.into(),
        }
    }
    fn fail(step: &str, detail: impl Into<String>) -> Self {
        CheckResult {
            step: step.to_string(),
            outcome: CheckOutcome::Fail,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineVerification {
    pub checks: Vec<CheckResult>,
    /// The recovered allocation ID, when recovery succeeded. This is an
    /// address derived from a signature, not an identity anyone asserted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_allocation: Option<String>,
    pub result: CheckOutcome,
    /// Restates the limit of what a passing result means, so no downstream
    /// artifact can quote the report as proof of correctness.
    pub means: String,
}

impl OfflineVerification {
    pub fn passed(&self) -> bool {
        self.result == CheckOutcome::Pass
    }
}

/// What passing the four offline checks does and does not establish.
///
/// Deliberately does not say "a staked allocation signed this". Offline
/// verification recovers an address; whether that address is an allocation
/// with stake behind it is established only by step 5, resolution against the
/// network subgraph, which is a separate check that can be skipped or fail.
/// Asserting stake here would be the easiest overclaim in the whole tool.
const MEANS: &str = "The recovered address signed these exact request and response bytes for this \
deployment. Whether it is an allocation with stake behind it is established only by signer \
resolution against the network subgraph; without that step this is a well-formed signature by an \
unidentified key. Even fully resolved it is attribution, not validation: it does not establish \
that the served data is correct, only that an identifiable party is answerable for it.";

/// Steps 1-4 of spec §4.4, all offline.
///
/// Runs every check before returning rather than short-circuiting: an auditor
/// looking at a failure wants to know which of the four bindings broke, and
/// "responseCID mismatched" versus "signature would not recover" are very
/// different findings.
pub fn verify_offline(bundle: &AuditBundle, domain: &DomainConfig) -> Result<OfflineVerification> {
    let mut checks = Vec::new();
    let attestation = &bundle.attestation;

    // 1 — responseCID binds the response bytes exactly as received.
    let response_cid = alloy::primitives::keccak256(bundle.response.as_bytes());
    if attestation.response_cid == response_cid {
        checks.push(CheckResult::pass(
            "responseCID",
            format!("keccak256(response bytes) == {response_cid}"),
        ));
    } else {
        checks.push(CheckResult::fail(
            "responseCID",
            format!(
                "attestation binds {}, but the stored response bytes hash to {response_cid}. \
                 The response was altered after it was signed, or these bytes are not the ones \
                 that were served.",
                attestation.response_cid
            ),
        ));
    }

    // 2 — requestCID binds the string the gateway forwarded, which is not the
    //     client's POST body. See gateway.rs.
    let request_cid = alloy::primitives::keccak256(bundle.request.as_bytes());
    if attestation.request_cid == request_cid {
        checks.push(CheckResult::pass(
            "requestCID",
            format!("keccak256(gateway-canonical request) == {request_cid}"),
        ));
    } else {
        checks.push(CheckResult::fail(
            "requestCID",
            format!(
                "attestation binds {}, but the reconstructed request string hashes to \
                 {request_cid}. Either the query differed, or the reconstruction of the \
                 gateway's parse-and-re-serialize step is wrong for this request shape.",
                attestation.request_cid
            ),
        ));
    }

    // 3 — the attestation is for the deployment we asked about, not another.
    match bundle.deployment.parse::<DeploymentId>() {
        Ok(deployment) => {
            let expected: B256 = deployment.into();
            if attestation.deployment == expected {
                checks.push(CheckResult::pass(
                    "subgraphDeploymentID",
                    format!("{} == {expected}", bundle.deployment),
                ));
            } else {
                checks.push(CheckResult::fail(
                    "subgraphDeploymentID",
                    format!(
                        "attestation is for deployment {}, but this bundle claims {} ({expected}). \
                         An attestation over a different deployment says nothing about this one.",
                        attestation.deployment, bundle.deployment
                    ),
                ));
            }
        }
        Err(e) => checks.push(CheckResult::fail(
            "subgraphDeploymentID",
            format!("bundle deployment {:?} is not a deployment ID: {e}", bundle.deployment),
        )),
    }

    // 4 — EIP-712 recovery. The recovered address *is* the allocation ID.
    let eip712 = domain.eip712();
    let recovered = attestation::recover_allocation(&eip712, attestation);
    let recovered_allocation = match &recovered {
        Ok(allocation) => {
            checks.push(CheckResult::pass(
                "eip712Recovery",
                format!(
                    "recovered allocation {allocation} under domain \
                     (chainId {}, disputeManager {})",
                    domain.chain_id, domain.dispute_manager
                ),
            ));
            Some(allocation.to_string())
        }
        Err(e) => {
            checks.push(CheckResult::fail(
                "eip712Recovery",
                format!(
                    "signature did not recover under domain (chainId {}, disputeManager {}): {e}. \
                     The domain parameters may be wrong for this gateway, or the signature is \
                     malformed.",
                    domain.chain_id, domain.dispute_manager
                ),
            ));
            None
        }
    };

    let result = if checks.iter().all(|c| c.outcome == CheckOutcome::Pass) {
        CheckOutcome::Pass
    } else {
        CheckOutcome::Fail
    };

    Ok(OfflineVerification {
        checks,
        recovered_allocation,
        result,
        means: MEANS.to_string(),
    })
}

/// Full verification against a known expected signer, using the crate's own
/// `verify` entry point.
pub fn verify_against_signer(
    bundle: &AuditBundle,
    domain: &DomainConfig,
    expected_signer: &Address,
) -> Result<()> {
    attestation::verify(
        &domain.eip712(),
        &bundle.attestation,
        expected_signer,
        &bundle.request,
        &bundle.response,
    )
    .map_err(|e| anyhow::anyhow!("attestation verification failed: {e}"))
}

// ---------------------------------------------------------------------------
// Step 5 — signer resolution against the network subgraph.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedSigner {
    pub allocation: String,
    pub indexer: String,
    pub staked_tokens: String,
    pub allocated_tokens: String,
    pub status: String,
    pub deployment: String,
}

/// The network-subgraph query that turns a recovered address into an indexer.
///
/// No variables, for the same reason the audit query has none: if this query
/// is ever routed through the gateway, its request string has to be
/// reproducible.
pub fn allocation_query(allocation: &str) -> String {
    format!(
        "{{allocation(id:\"{}\"){{id status allocatedTokens indexer{{id stakedTokens}} \
subgraphDeployment{{ipfsHash}}}}}}",
        allocation.to_lowercase()
    )
}

/// Parse an allocation lookup and enforce what makes it meaningful.
///
/// A recovered address is only evidence if it belongs to a real allocation, on
/// the deployment we queried, backed by nonzero stake. Each of those failing
/// is reported as its own condition.
pub fn parse_allocation_response(
    body: &str,
    expected_deployment: &str,
) -> Result<ResolvedSigner> {
    let envelope: serde_json::Value =
        serde_json::from_str(body).context("network-subgraph response is not valid JSON")?;

    if let Some(errors) = envelope.get("errors") {
        if !errors.is_null() && errors.as_array().map(|a| !a.is_empty()).unwrap_or(true) {
            bail!("network-subgraph response carries GraphQL errors: {errors}");
        }
    }

    let allocation = envelope
        .pointer("/data/allocation")
        .context("network-subgraph response has no data.allocation field")?;

    if allocation.is_null() {
        bail!(
            "signature recovered but unresolvable: no allocation exists with that id. \
             The signature is well-formed, but nothing ties it to a staked indexer."
        );
    }

    let get = |path: &str| -> Result<String> {
        allocation
            .pointer(path)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .with_context(|| format!("allocation is missing {path}"))
    };

    let deployment = get("/subgraphDeployment/ipfsHash")?;
    if deployment != expected_deployment {
        bail!(
            "allocation belongs to deployment {deployment}, not the queried {expected_deployment}. \
             The signer is staked, but not on the deployment that answered."
        );
    }

    let staked_tokens = get("/indexer/stakedTokens")?;
    if staked_tokens.trim_start_matches('0').is_empty() {
        bail!(
            "allocation resolves to an indexer with zero stake: there is nothing slashable \
             behind this answer."
        );
    }

    Ok(ResolvedSigner {
        allocation: get("/id")?,
        indexer: get("/indexer/id")?,
        staked_tokens,
        allocated_tokens: get("/allocatedTokens")?,
        status: get("/status")?,
        deployment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{address, b256};
    use alloy::signers::local::PrivateKeySigner;
    use thegraph_core::attestation::Attestation;

    // thegraph-core's own published vector: an attestation produced by the
    // TypeScript indexer implementation. Using their vector rather than one we
    // generated means a round-trip that only passes because our signing and
    // our verification agree cannot pass here.
    const VECTOR_CHAIN_ID: ChainId = 1337;
    const VECTOR_DISPUTE_MANAGER: Address = address!("16def7e0108a5467a106DBd7537F8591F470342e");
    const VECTOR_ALLOCATION: Address = address!("90f8bf6a479f320ead074411a4b0e7944ea8c9c1");
    const VECTOR_DEPLOYMENT: &str = "QmeVg9Da6uyBvjUEy5JqCgw2VKdkTxjPvcYuE5riGpkqw1";

    fn vector_domain() -> DomainConfig {
        DomainConfig {
            chain_id: VECTOR_CHAIN_ID,
            dispute_manager: VECTOR_DISPUTE_MANAGER,
        }
    }

    fn vector_bundle() -> AuditBundle {
        AuditBundle {
            schema: AuditBundle::SCHEMA.to_string(),
            request: "foo".to_string(),
            response: "bar".to_string(),
            attestation: Attestation {
                request_cid: b256!(
                    "41b1a0649752af1b28b3dc29a1556eee781e4a4c3a1f7f53f90fa834de098c4d"
                ),
                response_cid: b256!(
                    "435cd288e3694b535549c3af56ad805c149f92961bf84a1c647f7d86fc2431b4"
                ),
                deployment: VECTOR_DEPLOYMENT.parse::<DeploymentId>().unwrap().into(),
                r: b256!("e1fb47e7f0b278d4c88564c3a3b46180e476edcb2b783f253f3eec3b36f8fd4f"),
                s: b256!("467a881937edf2faf76e2e497085caf370c9689a1d83b245030757f70a1f64de"),
                v: 28,
            },
            deployment: VECTOR_DEPLOYMENT.to_string(),
            endpoint: "test://vector".to_string(),
            routed_indexer: None,
        }
    }

    #[test]
    fn verifies_the_published_vector_and_recovers_its_allocation() {
        let v = verify_offline(&vector_bundle(), &vector_domain()).unwrap();
        assert!(v.passed(), "checks: {:#?}", v.checks);
        assert_eq!(
            v.recovered_allocation.unwrap().to_lowercase(),
            VECTOR_ALLOCATION.to_string().to_lowercase()
        );
    }

    #[test]
    fn verify_against_signer_accepts_the_known_allocation() {
        verify_against_signer(&vector_bundle(), &vector_domain(), &VECTOR_ALLOCATION).unwrap();
    }

    #[test]
    fn a_single_altered_response_byte_breaks_response_cid() {
        let mut bundle = vector_bundle();
        bundle.response = "baR".to_string();

        let v = verify_offline(&bundle, &vector_domain()).unwrap();
        assert!(!v.passed());

        let failed: Vec<&str> = v
            .checks
            .iter()
            .filter(|c| c.outcome == CheckOutcome::Fail)
            .map(|c| c.step.as_str())
            .collect();
        // The failure must isolate to responseCID: recovery still succeeds,
        // because the signature is over the *original* hashes.
        assert_eq!(failed, vec!["responseCID"]);
    }

    #[test]
    fn an_altered_request_breaks_request_cid_only() {
        let mut bundle = vector_bundle();
        bundle.request = "foo ".to_string();

        let v = verify_offline(&bundle, &vector_domain()).unwrap();
        let failed: Vec<&str> = v
            .checks
            .iter()
            .filter(|c| c.outcome == CheckOutcome::Fail)
            .map(|c| c.step.as_str())
            .collect();
        assert_eq!(failed, vec!["requestCID"]);
    }

    #[test]
    fn the_wrong_domain_recovers_a_different_address() {
        // Recovery still "succeeds" arithmetically under a wrong domain — it
        // just yields an address nobody staked. This is why step 5 exists and
        // why the CLI reports "recovered but unresolvable" rather than
        // asserting a signer.
        let wrong = DomainConfig {
            chain_id: 1,
            dispute_manager: VECTOR_DISPUTE_MANAGER,
        };
        let v = verify_offline(&vector_bundle(), &wrong).unwrap();
        let recovered = v.recovered_allocation.unwrap().to_lowercase();
        assert_ne!(recovered, VECTOR_ALLOCATION.to_string().to_lowercase());
    }

    #[test]
    fn verify_against_signer_rejects_the_wrong_expected_signer() {
        let err = verify_against_signer(
            &vector_bundle(),
            &vector_domain(),
            &address!("0000000000000000000000000000000000000001"),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("recovered signer is not expected"), "{err}");
    }

    #[test]
    fn attestation_over_a_different_deployment_is_rejected() {
        let mut bundle = vector_bundle();
        bundle.deployment = "QmTgiJXAtDPRTqBHzHQmDTzsGXLBQGZKBHCbLxxCTQvDcS".to_string();

        let v = verify_offline(&bundle, &vector_domain()).unwrap();
        assert!(!v.passed());
        assert!(v
            .checks
            .iter()
            .any(|c| c.step == "subgraphDeploymentID" && c.outcome == CheckOutcome::Fail));
    }

    #[test]
    fn a_freshly_signed_attestation_over_altered_data_still_verifies() {
        // The tripwire-3 property: a lying serving layer that re-signs its own
        // altered body produces a perfectly valid attestation. Attestations
        // bind an answer to a signer; they do not make the answer true. This
        // is precisely why reconciliation is anchored to the chain.
        let signer = PrivateKeySigner::random();
        let expected = signer.address();
        let domain = vector_domain();
        let deployment: DeploymentId = VECTOR_DEPLOYMENT.parse().unwrap();

        let altered_response = r#"{"data":{"commitments":[{"value":"0xdeadbeef"}]}}"#;
        let attestation = attestation::create(
            &domain.eip712(),
            &signer,
            &deployment,
            "the-request",
            altered_response,
        );

        let bundle = AuditBundle {
            schema: AuditBundle::SCHEMA.to_string(),
            request: "the-request".to_string(),
            response: altered_response.to_string(),
            attestation,
            deployment: VECTOR_DEPLOYMENT.to_string(),
            endpoint: "test://liar".to_string(),
            routed_indexer: None,
        };

        let v = verify_offline(&bundle, &domain).unwrap();
        assert!(v.passed(), "a re-signed altered body verifies as attested");
        assert_eq!(
            v.recovered_allocation.unwrap().to_lowercase(),
            expected.to_string().to_lowercase()
        );
    }

    #[test]
    fn allocation_query_lowercases_the_address_and_has_no_variables() {
        let q = allocation_query("0xAbCdEf0000000000000000000000000000000001");
        assert!(q.contains("0xabcdef0000000000000000000000000000000001"));
        assert!(!q.contains('$'));
    }

    fn allocation_body(deployment: &str, staked: &str) -> String {
        format!(
            r#"{{"data":{{"allocation":{{"id":"0xalloc","status":"Active","allocatedTokens":"5000",
            "indexer":{{"id":"0xindexer","stakedTokens":"{staked}"}},
            "subgraphDeployment":{{"ipfsHash":"{deployment}"}}}}}}}}"#
        )
    }

    #[test]
    fn resolves_a_well_formed_allocation() {
        let r = parse_allocation_response(&allocation_body("QmDeploy", "100000"), "QmDeploy").unwrap();
        assert_eq!(r.indexer, "0xindexer");
        assert_eq!(r.staked_tokens, "100000");
    }

    #[test]
    fn rejects_an_allocation_on_a_different_deployment() {
        let err = parse_allocation_response(&allocation_body("QmOther", "100000"), "QmDeploy")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not the queried"), "{err}");
    }

    #[test]
    fn rejects_a_zero_stake_indexer() {
        let err = parse_allocation_response(&allocation_body("QmDeploy", "0"), "QmDeploy")
            .unwrap_err()
            .to_string();
        assert!(err.contains("zero stake"), "{err}");
    }

    #[test]
    fn reports_an_unresolvable_signature_distinctly() {
        let err = parse_allocation_response(r#"{"data":{"allocation":null}}"#, "QmDeploy")
            .unwrap_err()
            .to_string();
        assert!(err.contains("recovered but unresolvable"), "{err}");
    }
}
