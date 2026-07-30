//! Replay the log against the anchored roots.
//!
//! This is the executable form of step 6 of the map's
//! `pattern-l2-encrypted-offchain-audit`: *"Replay the log against the
//! anchored roots to confirm that no record has been rewritten after the
//! fact."* The pattern names no party to serve the anchor set; this item is
//! that party, and this module is the check the auditor runs.
//!
//! What a PASS means, exactly:
//!
//! * every disclosed record's commitment, recomputed from its plaintext,
//!   appears in the served anchor log at the leaf index it claims;
//! * the served log contains nothing the disclosure cannot account for;
//! * every root rebuilt from the served log is a root the chain recorded.
//!
//! What a PASS does **not** mean: that the disclosure is complete with respect
//! to the world. Completeness here is with respect to on-chain anchors only. A
//! transaction the issuer never anchored is invisible to every check below.
//! This is not, and cannot be turned into, a proof of reserves.

use std::collections::BTreeMap;

use alloy::primitives::B256;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::anchors::AnchorSet;
use crate::attestation::{CheckOutcome, OfflineVerification};
use crate::field::{fr_from_hex, fr_to_hex, normalize_bytes32_hex};
use crate::merkle::root_history;
use crate::onchain::ChainReader;
use crate::records::{AccountingClass, DisclosedRecord, RecordsManifest};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordCheck {
    pub leaf_index: u64,
    pub record_file: String,
    pub value: u64,
    pub owner: String,
    pub recomputed_commitment: String,
    pub served_commitment: Option<String>,
    pub outcome: CheckOutcome,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnchorAccounting {
    pub served_leaf_count: usize,
    pub disclosed_count: usize,
    pub burn_output_zero_count: usize,
    pub unaccounted_leaf_indices: Vec<u64>,
    pub missing_leaf_indices: Vec<u64>,
    pub outcome: CheckOutcome,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootCheck {
    pub after_call: String,
    pub leaf_count: usize,
    pub rebuilt_root: String,
    pub known_on_chain: Option<bool>,
    pub outcome: CheckOutcome,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnChainCrossCheck {
    pub leaf_index: u64,
    pub served: String,
    pub on_chain: String,
    pub outcome: CheckOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileReport {
    pub schema: String,
    pub deployment: String,
    pub contract: String,
    pub bond_id: String,
    pub bond_id_string: String,
    pub pinned_block_number: u64,
    pub pinned_block_hash: String,
    pub attestation: OfflineVerification,
    pub records: Vec<RecordCheck>,
    pub anchor_accounting: AnchorAccounting,
    pub root_replay: Vec<RootCheck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_chain_cross_check: Option<Vec<OnChainCrossCheck>>,
    pub result: CheckOutcome,
    pub failures: Vec<String>,
    pub scope: Vec<String>,
}

impl ReconcileReport {
    pub const SCHEMA: &'static str = "bond-replay/reconcile-report/1";

    pub fn passed(&self) -> bool {
        self.result == CheckOutcome::Pass
    }

    /// Deterministic rendering. No wall-clock field appears anywhere in the
    /// report, by design: §7 requires that reconciling the same bundle twice
    /// produces byte-identical output, and a timestamp would defeat that while
    /// adding nothing an auditor can check.
    pub fn to_json(&self) -> Result<String> {
        let mut s = serde_json::to_string_pretty(self)?;
        s.push('\n');
        Ok(s)
    }
}

/// The wording that travels with every report, so no downstream artifact can
/// quote a PASS as more than it is.
fn scope_notes() -> Vec<String> {
    vec![
        "Completeness is with respect to on-chain anchors, never off-chain reality: a record \
         the issuer never anchored is invisible to this check. This is not a proof of reserves."
            .to_string(),
        "The attestation is a signature, not a validity proof. Where the signer resolves to a \
         staked allocation it makes a wrong answer attributable and slashable; it never makes an \
         answer correct. A run that did not resolve the signer has not established stake at all."
            .to_string(),
        "Root agreement is anchored in the chain, read from the operator's own RPC endpoint. \
         A serving layer that alters the anchor log fails this check even when its response \
         carries a perfectly valid attestation."
            .to_string(),
        "This run leaks its own subject: the gateway and each serving indexer observe which \
         deployment was audited, the full query text, and when. Read privacy does not exist \
         today; see item 06."
            .to_string(),
    ]
}

pub struct ReconcileInputs<'a> {
    pub anchor_set: &'a AnchorSet,
    pub manifest: &'a RecordsManifest,
    pub records: &'a BTreeMap<u64, DisclosedRecord>,
    pub attestation: OfflineVerification,
    pub deployment: String,
    pub contract: String,
}

/// Run every check. Nothing short-circuits: an auditor needs the full picture
/// of what broke, not just the first thing that did.
pub async fn reconcile(
    inputs: ReconcileInputs<'_>,
    chain: Option<&ChainReader>,
    verify_onchain_commitments: bool,
) -> Result<ReconcileReport> {
    let set = inputs.anchor_set;
    let manifest = inputs.manifest;
    let mut failures = Vec::new();

    if !inputs.attestation.passed() {
        failures.push("attestation verification failed".to_string());
    }

    let ordered = set.ordered_commitments()?;
    let served_by_index: BTreeMap<u64, String> = ordered
        .iter()
        .enumerate()
        .map(|(i, c)| Ok((i as u64, normalize_bytes32_hex(&c.value)?)))
        .collect::<Result<_>>()?;

    // ---- per-record: recompute, then look for it where it claims to be ----
    let mut record_checks = Vec::new();
    for entry in &manifest.entries {
        let Some(file) = &entry.record_file else { continue };
        let record = inputs
            .records
            .get(&entry.leaf_index)
            .with_context(|| format!("no loaded record for leaf {}", entry.leaf_index))?;

        let recomputed = record.recompute_commitment()?;
        let served = served_by_index.get(&entry.leaf_index).cloned();

        let (outcome, detail) = match &served {
            Some(value) if *value == recomputed => (
                CheckOutcome::Pass,
                "recomputed commitment matches the served anchor at this leaf index".to_string(),
            ),
            Some(value) => (
                CheckOutcome::Fail,
                format!(
                    "record does not reconcile: its plaintext hashes to {recomputed}, but leaf \
                     {} was anchored as {value}. Either this record was altered after anchoring, \
                     or it does not belong at this index.",
                    entry.leaf_index
                ),
            ),
            None => (
                CheckOutcome::Fail,
                format!(
                    "no anchor was served at leaf index {}, so the record has nothing to \
                     reconcile against",
                    entry.leaf_index
                ),
            ),
        };

        // A manifest that disagrees with the record it points at is its own
        // finding, reported even when the anchor matches.
        let detail = if entry.commitment != recomputed {
            failures.push(format!(
                "manifest/record mismatch at leaf {}: manifest claims {}, record hashes to {recomputed}",
                entry.leaf_index, entry.commitment
            ));
            format!("{detail} (manifest also disagrees with the record file)")
        } else {
            detail
        };

        if outcome == CheckOutcome::Fail {
            failures.push(format!("leaf {} — {}", entry.leaf_index, file));
        }

        record_checks.push(RecordCheck {
            leaf_index: entry.leaf_index,
            record_file: file.clone(),
            value: record.value,
            owner: record.owner.clone(),
            recomputed_commitment: recomputed,
            served_commitment: served,
            outcome,
            detail,
        });
    }

    // ---- completeness, in both directions ----
    let mut expected: BTreeMap<u64, String> = BTreeMap::new();
    for entry in &manifest.entries {
        let value = match entry.class {
            AccountingClass::Disclosed => inputs
                .records
                .get(&entry.leaf_index)
                .with_context(|| format!("no loaded record for leaf {}", entry.leaf_index))?
                .recompute_commitment()?,
            // A structural burn output has no record file; the manifest's
            // stated value is what accounts for it.
            AccountingClass::BurnOutputZero => normalize_bytes32_hex(&entry.commitment)?,
        };
        expected.insert(entry.leaf_index, value);
    }

    let unaccounted: Vec<u64> = served_by_index
        .iter()
        .filter(|(idx, served)| expected.get(idx) != Some(served))
        .map(|(idx, _)| *idx)
        .collect();
    let missing: Vec<u64> = expected
        .keys()
        .filter(|idx| !served_by_index.contains_key(idx))
        .copied()
        .collect();

    let accounting_ok = unaccounted.is_empty() && missing.is_empty();
    if !accounting_ok {
        failures.push(format!(
            "anchor accounting failed: {} served anchor(s) the disclosure cannot account for, \
             {} disclosed leaf/leaves absent from the served log",
            unaccounted.len(),
            missing.len()
        ));
    }

    let anchor_accounting = AnchorAccounting {
        served_leaf_count: served_by_index.len(),
        disclosed_count: manifest
            .entries
            .iter()
            .filter(|e| e.class == AccountingClass::Disclosed)
            .count(),
        burn_output_zero_count: manifest
            .entries
            .iter()
            .filter(|e| e.class == AccountingClass::BurnOutputZero)
            .count(),
        unaccounted_leaf_indices: unaccounted,
        missing_leaf_indices: missing,
        outcome: if accounting_ok { CheckOutcome::Pass } else { CheckOutcome::Fail },
        detail: if accounting_ok {
            "every served anchor is either a disclosed record's recomputed commitment or a \
             manifest-listed structural burn output, and every disclosed leaf was served"
                .to_string()
        } else {
            "the served anchor set and the disclosure do not cover each other".to_string()
        },
    };

    // ---- root replay against the chain ----
    let served_leaves = ordered
        .iter()
        .map(|c| fr_from_hex(&c.value))
        .collect::<Result<Vec<_>>>()?;

    // Prefer the call boundaries the indexer served; fall back to the
    // manifest's when the served lifecycle log is empty (Fallback A shapes).
    let served_counts = set.leaf_counts_after_each_call()?;
    let counts = if served_counts.is_empty() {
        manifest.leaf_counts_after_each_call.clone()
    } else {
        served_counts
    };

    let roots = root_history(&served_leaves, &counts)?;
    let mut root_checks = Vec::new();

    for (i, root) in roots.iter().enumerate() {
        let rebuilt = fr_to_hex(root);
        let label = manifest
            .call_order
            .get(i)
            .cloned()
            .unwrap_or_else(|| format!("call#{i}"));

        let (known, outcome, detail) = match chain {
            Some(reader) => {
                let bytes: B256 = rebuilt.parse().context("rebuilt root is not 32 bytes")?;
                let known = reader.is_known_root(bytes).await?;
                if known {
                    (
                        Some(true),
                        CheckOutcome::Pass,
                        "root rebuilt from the served log is recorded in knownRoots on chain"
                            .to_string(),
                    )
                } else {
                    (
                        Some(false),
                        CheckOutcome::Fail,
                        format!(
                            "root rebuilt from the served log after `{label}` is NOT in \
                             knownRoots. The served anchor log does not reproduce what the \
                             contract anchored."
                        ),
                    )
                }
            }
            None => (
                None,
                CheckOutcome::Fail,
                "no RPC endpoint supplied, so this root could not be checked against the chain. \
                 Root replay is the check that anchors trust in the chain rather than the \
                 serving layer; without it the run proves nothing about anchoring."
                    .to_string(),
            ),
        };

        if outcome == CheckOutcome::Fail {
            failures.push(format!("root replay after `{label}` ({} leaves)", counts[i]));
        }

        root_checks.push(RootCheck {
            after_call: label,
            leaf_count: counts[i],
            rebuilt_root: rebuilt,
            known_on_chain: known,
            outcome,
            detail,
        });
    }

    // ---- optional: served anchors vs contract storage, leaf by leaf ----
    let on_chain_cross_check = match (chain, verify_onchain_commitments) {
        (Some(reader), true) => {
            let mut checks = Vec::new();
            for (idx, served) in &served_by_index {
                let stored = reader.commitment_at(*idx).await?;
                let stored_hex = format!("0x{}", hex::encode(stored));
                let outcome = if stored_hex == *served {
                    CheckOutcome::Pass
                } else {
                    failures.push(format!(
                        "leaf {idx} served as {served} but stored on chain as {stored_hex}"
                    ));
                    CheckOutcome::Fail
                };
                checks.push(OnChainCrossCheck {
                    leaf_index: *idx,
                    served: served.clone(),
                    on_chain: stored_hex,
                    outcome,
                });
            }
            Some(checks)
        }
        _ => None,
    };

    let result = if failures.is_empty() { CheckOutcome::Pass } else { CheckOutcome::Fail };

    Ok(ReconcileReport {
        schema: ReconcileReport::SCHEMA.to_string(),
        deployment: inputs.deployment,
        contract: inputs.contract,
        bond_id: manifest.bond_id.clone(),
        bond_id_string: manifest.bond_id_string.clone(),
        pinned_block_number: set.meta.block.number,
        pinned_block_hash: set.meta.block.hash.clone(),
        attestation: inputs.attestation,
        records: record_checks,
        anchor_accounting,
        root_replay: root_checks,
        on_chain_cross_check,
        result,
        failures,
        scope: scope_notes(),
    })
}
