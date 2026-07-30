//! Cross-operator agreement at a pinned block.
//!
//! The claim this mode can support is narrow and worth stating precisely:
//! *k distinct GRT-staked indexers signed byte-identical answers to the same
//! query at the same block.* That is agreement, not verification. Indexers
//! that collude, or that share a deterministic bug, agree on a wrong answer
//! just as readily — agreement raises the cost of a lie without making one
//! impossible.
//!
//! Two routes can produce the evidence, and they are not equivalent:
//!
//! * the **targeted per-indexer route** lets the client choose who answers, so
//!   collecting k distinct signers is something the client controls. This is
//!   the only path from which a k-of-n coverage claim may be made.
//! * the **main route** returns the first success from up to three selected
//!   indexers, with selection favouring fast ones. Re-issuing a query may
//!   return the same indexer every time. It is best-effort only, and the CLI
//!   refuses to describe its output as k-of-n coverage.
//!
//! Distinctness is decided by the attestation signer, resolved to an indexer —
//! never by which indexer the client asked for. Identity here is proof-carried.

use std::collections::BTreeMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::attestation::ResolvedSigner;
use crate::gateway::AuditBundle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteKind {
    /// `/api/deployments/id/{deployment}/indexers/id/{indexer}`
    TargetedPerIndexer,
    /// `/api/deployments/id/{deployment}`, re-issued
    BestEffortMainRoute,
}

impl RouteKind {
    pub fn supports_coverage_claim(&self) -> bool {
        matches!(self, RouteKind::TargetedPerIndexer)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgreementClass {
    /// Byte-identical response bodies. The headline result.
    ByteIdentical,
    /// Bodies differ, but parse to equal JSON. Reported separately because it
    /// is a serialization difference, not a disagreement about the data — and
    /// because `responseCID` is over bytes, so the attestations differ.
    SerializationLevelDivergence,
    /// The served data itself differs. This is the dispute-grade case.
    DataDivergence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignerObservation {
    pub allocation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staked_tokens: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocation_status: Option<String>,
    pub response_cid: String,
    pub response_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsistencyReport {
    pub schema: String,
    pub deployment: String,
    pub pinned_block_number: u64,
    pub pinned_block_hash: String,
    pub route: RouteKind,
    /// Whether this run's route can support a k-distinct-signer claim at all.
    pub coverage_claim_supported: bool,
    pub min_signers_requested: usize,
    pub distinct_signers_observed: usize,
    pub observations: Vec<SignerObservation>,
    pub agreement: AgreementClass,
    pub result: crate::attestation::CheckOutcome,
    pub failures: Vec<String>,
    pub means: String,
}

impl ConsistencyReport {
    pub const SCHEMA: &'static str = "bond-replay/consistency-report/1";

    pub fn to_json(&self) -> Result<String> {
        let mut s = serde_json::to_string_pretty(self)?;
        s.push('\n');
        Ok(s)
    }
}

/// One collected answer: a verified bundle plus whatever the network subgraph
/// said about its signer.
pub struct Collected {
    pub bundle: AuditBundle,
    pub allocation: String,
    pub resolved: Option<ResolvedSigner>,
}

/// Classify a set of answers. Pure, so the interesting cases are unit-testable
/// without a network.
pub fn classify(collected: &[Collected]) -> AgreementClass {
    let bodies: Vec<&str> = collected.iter().map(|c| c.bundle.response.as_str()).collect();

    if bodies.windows(2).all(|w| w[0] == w[1]) {
        return AgreementClass::ByteIdentical;
    }

    let parsed: Vec<Option<serde_json::Value>> = bodies
        .iter()
        .map(|b| serde_json::from_str::<serde_json::Value>(b).ok())
        .collect();

    if parsed.iter().all(Option::is_some) && parsed.windows(2).all(|w| w[0] == w[1]) {
        return AgreementClass::SerializationLevelDivergence;
    }

    AgreementClass::DataDivergence
}

/// Distinct signing *indexers*, not distinct allocations: one indexer holding
/// two allocations counts once. Falls back to the allocation address only when
/// the signer could not be resolved, and that case is reported as unresolved
/// rather than silently counted as an independent party.
pub fn distinct_indexers(collected: &[Collected]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for c in collected {
        let key = match &c.resolved {
            Some(r) => r.indexer.to_lowercase(),
            None => format!("unresolved-allocation:{}", c.allocation.to_lowercase()),
        };
        *counts.entry(key).or_insert(0) += 1;
    }
    counts
}

pub fn build_report(
    deployment: String,
    pinned_block_number: u64,
    pinned_block_hash: String,
    route: RouteKind,
    min_signers: usize,
    collected: &[Collected],
) -> ConsistencyReport {
    let agreement = classify(collected);
    let by_indexer = distinct_indexers(collected);
    let distinct = by_indexer.len();

    let mut failures = Vec::new();

    if distinct < min_signers {
        failures.push(format!(
            "collected answers from {distinct} distinct signer(s), below the requested minimum \
             of {min_signers}"
        ));
    }

    match agreement {
        AgreementClass::ByteIdentical => {}
        AgreementClass::SerializationLevelDivergence => failures.push(
            "responses differ in bytes but parse to equal JSON: a serialization-level \
             divergence. The data agrees; the attestations do not cover the same bytes."
                .to_string(),
        ),
        AgreementClass::DataDivergence => failures.push(
            "responses disagree about the data at the same pinned block. Each bundle carries its \
             own attestation, so this is non-repudiable, dispute-grade evidence. Filing an \
             on-chain dispute is out of scope for this item."
                .to_string(),
        ),
    }

    let unresolved = collected.iter().filter(|c| c.resolved.is_none()).count();
    if unresolved > 0 {
        failures.push(format!(
            "{unresolved} answer(s) had a signature that recovered but did not resolve to a \
             staked allocation; they are not counted as independent parties"
        ));
    }

    let observations = collected
        .iter()
        .map(|c| SignerObservation {
            allocation: c.allocation.to_lowercase(),
            indexer: c.resolved.as_ref().map(|r| r.indexer.clone()),
            staked_tokens: c.resolved.as_ref().map(|r| r.staked_tokens.clone()),
            allocation_status: c.resolved.as_ref().map(|r| r.status.clone()),
            response_cid: format!("0x{}", hex::encode(c.bundle.attestation.response_cid)),
            response_bytes: c.bundle.response.len(),
        })
        .collect();

    let means = if route.supports_coverage_claim() {
        format!(
            "{distinct} distinct staked indexer(s) signed answers to the identical query at the \
             identical block. Agreement is not correctness: colluding or identically-buggy \
             indexers agree too."
        )
    } else {
        "Best-effort sampling of the main route. The gateway returns the first success from up to \
         three selected indexers and favours fast ones, so this sample carries NO distinctness \
         guarantee and must not be described as k-of-n coverage."
            .to_string()
    };

    ConsistencyReport {
        schema: ConsistencyReport::SCHEMA.to_string(),
        deployment,
        pinned_block_number,
        pinned_block_hash,
        route,
        coverage_claim_supported: route.supports_coverage_claim(),
        min_signers_requested: min_signers,
        distinct_signers_observed: distinct,
        observations,
        agreement,
        result: if failures.is_empty() {
            crate::attestation::CheckOutcome::Pass
        } else {
            crate::attestation::CheckOutcome::Fail
        },
        failures,
        means,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attestation::CheckOutcome;
    use thegraph_core::attestation::Attestation;

    fn bundle(response: &str) -> AuditBundle {
        AuditBundle {
            schema: AuditBundle::SCHEMA.to_string(),
            request: "req".to_string(),
            response: response.to_string(),
            attestation: Attestation {
                request_cid: alloy::primitives::keccak256("req"),
                response_cid: alloy::primitives::keccak256(response),
                deployment: Default::default(),
                r: Default::default(),
                s: Default::default(),
                v: 27,
            },
            deployment: "QmDeploy".to_string(),
            endpoint: "test://".to_string(),
            routed_indexer: None,
        }
    }

    fn collected(response: &str, allocation: &str, indexer: Option<&str>) -> Collected {
        Collected {
            bundle: bundle(response),
            allocation: allocation.to_string(),
            resolved: indexer.map(|i| ResolvedSigner {
                allocation: allocation.to_string(),
                indexer: i.to_string(),
                staked_tokens: "100000".to_string(),
                allocated_tokens: "500".to_string(),
                status: "Active".to_string(),
                deployment: "QmDeploy".to_string(),
            }),
        }
    }

    #[test]
    fn identical_bytes_are_byte_identical() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected(r#"{"a":1}"#, "0xa2", Some("0xi2")),
        ];
        assert_eq!(classify(&c), AgreementClass::ByteIdentical);
    }

    #[test]
    fn reordered_whitespace_is_a_serialization_divergence_not_a_data_one() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected("{ \"a\" : 1 }", "0xa2", Some("0xi2")),
        ];
        assert_eq!(classify(&c), AgreementClass::SerializationLevelDivergence);
    }

    #[test]
    fn different_data_is_a_data_divergence() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected(r#"{"a":2}"#, "0xa2", Some("0xi2")),
        ];
        assert_eq!(classify(&c), AgreementClass::DataDivergence);
    }

    #[test]
    fn two_allocations_of_one_indexer_count_as_one_party() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xSAME")),
            collected(r#"{"a":1}"#, "0xa2", Some("0xsame")),
        ];
        assert_eq!(distinct_indexers(&c).len(), 1);

        let report = build_report(
            "QmDeploy".into(),
            100,
            "0xhash".into(),
            RouteKind::TargetedPerIndexer,
            2,
            &c,
        );
        assert_eq!(report.distinct_signers_observed, 1);
        assert_eq!(report.result, CheckOutcome::Fail);
    }

    #[test]
    fn agreeing_distinct_signers_pass() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected(r#"{"a":1}"#, "0xa2", Some("0xi2")),
        ];
        let report = build_report(
            "QmDeploy".into(),
            100,
            "0xhash".into(),
            RouteKind::TargetedPerIndexer,
            2,
            &c,
        );
        assert_eq!(report.result, CheckOutcome::Pass);
        assert!(report.coverage_claim_supported);
        assert!(report.failures.is_empty());
    }

    #[test]
    fn divergence_fails_and_keeps_both_attestations() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected(r#"{"a":2}"#, "0xa2", Some("0xi2")),
        ];
        let report = build_report(
            "QmDeploy".into(),
            100,
            "0xhash".into(),
            RouteKind::TargetedPerIndexer,
            2,
            &c,
        );
        assert_eq!(report.result, CheckOutcome::Fail);
        assert_eq!(report.agreement, AgreementClass::DataDivergence);
        assert_eq!(report.observations.len(), 2);
        assert_ne!(
            report.observations[0].response_cid,
            report.observations[1].response_cid
        );
    }

    #[test]
    fn the_main_route_never_claims_coverage() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected(r#"{"a":1}"#, "0xa2", Some("0xi2")),
        ];
        let report = build_report(
            "QmDeploy".into(),
            100,
            "0xhash".into(),
            RouteKind::BestEffortMainRoute,
            2,
            &c,
        );
        assert!(!report.coverage_claim_supported);
        assert!(report.means.contains("NO distinctness guarantee"));
    }

    #[test]
    fn unresolved_signers_are_flagged_not_silently_counted() {
        let c = vec![
            collected(r#"{"a":1}"#, "0xa1", Some("0xi1")),
            collected(r#"{"a":1}"#, "0xa2", None),
        ];
        let report = build_report(
            "QmDeploy".into(),
            100,
            "0xhash".into(),
            RouteKind::TargetedPerIndexer,
            2,
            &c,
        );
        assert_eq!(report.result, CheckOutcome::Fail);
        assert!(report.failures.iter().any(|f| f.contains("did not resolve")));
    }
}
