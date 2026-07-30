//! The disclosed off-chain records and the manifest that accounts for them.
//!
//! These are the "log" side of the pattern's step 6: *replay the log against
//! the anchored roots*. On-chain there are only commitments; a disclosure is
//! the set of plaintext note records whose commitments should reproduce them.
//!
//! Scope, stated plainly: reconciling these proves the disclosed records match
//! what was **anchored on chain**. It says nothing about off-chain reality — a
//! trade the issuer never anchored is invisible here. No proof-of-reserves
//! reading of this file is supportable.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::field::{fr_from_hex, fr_to_hex, normalize_bytes32_hex};
use crate::poseidon::note_commitment;

/// A disclosed note record.
///
/// Field-for-field the `Bond` struct EthSystems' wallet writes to
/// `wallet/data/*.json` (`wallet/src/utils.rs` at the pin), so records their
/// wallet produced can be reconciled without translation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisclosedRecord {
    pub commitment: String,
    pub nullifier: String,
    pub value: u64,
    pub salt: u64,
    pub owner: String,
    pub asset_id: u64,
    pub maturity_date: u64,
    pub created_at: String,
}

impl DisclosedRecord {
    /// Recompute the commitment from the plaintext fields.
    ///
    /// The `commitment` field in the file is the issuer's *claim*; this is the
    /// value an auditor derives independently. Reconciliation compares the
    /// derived value against the served anchor log, never the claimed one.
    pub fn recompute_commitment(&self) -> Result<String> {
        let owner = fr_from_hex(&self.owner)
            .with_context(|| format!("record owner is not a field element: {}", self.owner))?;
        Ok(fr_to_hex(&note_commitment(
            self.value,
            self.salt,
            owner,
            self.asset_id,
            self.maturity_date,
        )))
    }

    /// Whether the file's own `commitment` field agrees with the recomputation.
    ///
    /// A mismatch means the disclosure is internally inconsistent, which is
    /// reported separately from "absent from the anchor set": they are
    /// different findings for an auditor.
    pub fn claim_is_self_consistent(&self) -> Result<bool> {
        Ok(normalize_bytes32_hex(&self.commitment)? == self.recompute_commitment()?)
    }
}

/// How a served anchor is accounted for.
///
/// Completeness is checked in both directions, so every commitment the
/// indexer served must fall into exactly one of these classes. An anchor in
/// neither fails reconciliation — that is the point of the class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccountingClass {
    /// A real note record, disclosed to the auditor as a file.
    Disclosed,
    /// One of the two zero-value commitments a `burn` appends to keep the
    /// tree's 2-in/2-out shape. A structural artefact of the contract, not a
    /// disclosed record, and no file backs it.
    BurnOutputZero,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// Global leaf index this entry claims in the commitment array.
    pub leaf_index: u64,
    pub class: AccountingClass,
    /// Record file, relative to the records directory. Present for
    /// `disclosed` entries, absent for `burn-output-zero`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_file: Option<String>,
    /// Expected commitment. For `disclosed` entries this is cross-checked
    /// against the recomputation from the record file, so a manifest cannot
    /// paper over an altered record.
    pub commitment: String,
    /// Which entry point appended this leaf.
    pub source_function: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordsManifest {
    pub schema: String,
    pub bond_id: String,
    pub bond_id_string: String,
    pub maturity_date: u64,
    /// Running leaf total after each anchor-appending call, in call order.
    /// Determines which roots must appear in `knownRoots`.
    pub leaf_counts_after_each_call: Vec<usize>,
    pub call_order: Vec<String>,
    pub entries: Vec<ManifestEntry>,
}

impl RecordsManifest {
    pub const SCHEMA: &'static str = "bond-replay/records-manifest/1";

    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read manifest: {}", path.display()))?;
        let manifest: RecordsManifest = serde_json::from_str(&raw)
            .with_context(|| format!("cannot parse manifest: {}", path.display()))?;
        if manifest.schema != Self::SCHEMA {
            bail!(
                "unexpected manifest schema {:?}, expected {:?}",
                manifest.schema,
                Self::SCHEMA
            );
        }
        manifest.check_internal_consistency()?;
        Ok(manifest)
    }

    fn check_internal_consistency(&self) -> Result<()> {
        let mut seen = BTreeMap::new();
        for entry in &self.entries {
            if seen.insert(entry.leaf_index, ()).is_some() {
                bail!("manifest lists leaf index {} twice", entry.leaf_index);
            }
            match entry.class {
                AccountingClass::Disclosed if entry.record_file.is_none() => {
                    bail!("disclosed entry at leaf {} has no record file", entry.leaf_index)
                }
                AccountingClass::BurnOutputZero if entry.record_file.is_some() => bail!(
                    "burn-output-zero entry at leaf {} must not name a record file",
                    entry.leaf_index
                ),
                _ => {}
            }
        }

        for (position, leaf_index) in seen.keys().enumerate() {
            if *leaf_index != position as u64 {
                bail!(
                    "manifest leaf indices must be contiguous from 0; found {leaf_index} at position {position}"
                );
            }
        }

        Ok(())
    }

    /// Load every disclosed record file named by the manifest.
    pub fn load_records(&self, records_dir: &Path) -> Result<BTreeMap<u64, DisclosedRecord>> {
        let mut out = BTreeMap::new();
        for entry in &self.entries {
            let Some(file) = &entry.record_file else {
                continue;
            };
            let path = records_dir.join(file);
            let raw = std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read disclosed record: {}", path.display()))?;
            let record: DisclosedRecord = serde_json::from_str(&raw)
                .with_context(|| format!("cannot parse disclosed record: {}", path.display()))?;
            out.insert(entry.leaf_index, record);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::fr_to_hex;
    use crate::poseidon::owner_from_private_key;

    fn sample() -> DisclosedRecord {
        let owner = owner_from_private_key(crate::field::fr_from_u64(999));
        let commitment = fr_to_hex(&note_commitment(100, 123, owner, 1, 1893456000));
        DisclosedRecord {
            commitment,
            nullifier: "0x00".to_string(),
            value: 100,
            salt: 123,
            owner: fr_to_hex(&owner),
            asset_id: 1,
            maturity_date: 1893456000,
            created_at: "2026-07-29T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn recomputation_matches_a_consistent_record() {
        let record = sample();
        assert!(record.claim_is_self_consistent().unwrap());
        assert_eq!(
            record.recompute_commitment().unwrap(),
            normalize_bytes32_hex(&record.commitment).unwrap()
        );
    }

    #[test]
    fn altering_value_changes_the_recomputed_commitment() {
        let original = sample();
        let mut tampered = original.clone();
        tampered.value += 1;

        assert_ne!(
            original.recompute_commitment().unwrap(),
            tampered.recompute_commitment().unwrap()
        );
        // The claimed commitment is now a lie about the plaintext, and the
        // record no longer checks out on its own.
        assert!(!tampered.claim_is_self_consistent().unwrap());
    }
}
