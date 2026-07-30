//! Deterministic generation of the seed lifecycle and its disclosed records.
//!
//! Poseidon lives in exactly one implementation in this item — this crate —
//! so the Foundry seed scripts are handed finished calldata rather than
//! computing commitments in Solidity (PoseidonT3 hashes pairs only; there is
//! no 5-input Poseidon on chain).
//!
//! Everything here is a pure function of the constants below. No wall clock,
//! no randomness: the determinism test re-runs generation and requires
//! byte-identical output, and the seeded chain uses a fixed genesis timestamp
//! so the anchor log is reproducible from zero.

use std::path::Path;

use alloy::primitives::keccak256;
use anyhow::{Context, Result};
use poseidon_rs::Fr;
use serde::Serialize;

use crate::field::{fr_from_u64, fr_to_hex};
use crate::merkle::build_merkle_root;
use crate::poseidon::{note_commitment, nullifier, owner_from_private_key};
use crate::records::{AccountingClass, DisclosedRecord, ManifestEntry, RecordsManifest};

/// Fixed chain genesis for the local fixture. Anvil is started with
/// `--timestamp` set to this, so maturity is a constant rather than
/// deploy-time + 1h, and the whole anchor log is byte-reproducible.
///
/// On a public testnet the spec's rule applies instead (maturity ~ deploy +
/// 1 hour); that leg is not run in this tranche.
pub const FIXTURE_GENESIS_TS: u64 = 1_893_456_000; // 2030-01-01T00:00:00Z
pub const MATURITY_OFFSET_SECS: u64 = 3_600;
pub const MATURITY_DATE: u64 = FIXTURE_GENESIS_TS + MATURITY_OFFSET_SECS;

/// A deliberately fictional ISIN-format identifier. "XF" is not an ISO 3166-1
/// alpha-2 country code, so this cannot collide with an issued ISIN. The PoC's
/// own script hardcodes a real one (Apple's US0378331005); we do not deploy
/// anything carrying a real security's identifier.
pub const BOND_ID_STRING: &str = "XF0000000001";

pub const ASSET_ID: u64 = 1;

const ISSUER_PK: u64 = 1_001;
const INVESTOR_A_PK: u64 = 2_002;
const INVESTOR_B_PK: u64 = 3_003;

/// Fixed `created_at` for generated records. Deliberately not `now()`:
/// a wall-clock field would defeat the byte-identical determinism assertion.
const FIXTURE_CREATED_AT: &str = "2030-01-01T00:00:00Z";

/// Placeholder bytes for the contract's `proof` parameter.
///
/// NOT A PROOF, and nothing may present it as one. Under the spec's
/// MockVerifier default (§4.2) the argument is never inspected. It is
/// non-empty so the subgraph's proof-digest decode path sees real calldata.
pub const PROOF_PLACEHOLDER_HEX: &str =
    "0x6e6f742d612d70726f6f662d706c616365686f6c6465722d666f722d6d6f636b566572696669657200";

struct Actor {
    private_key: Fr,
    owner: Fr,
}

impl Actor {
    fn new(pk: u64) -> Self {
        let private_key = fr_from_u64(pk);
        Actor {
            owner: owner_from_private_key(private_key),
            private_key,
        }
    }
}

struct Leaf {
    index: u64,
    value: u64,
    salt: u64,
    owner: Fr,
    owner_label: &'static str,
    source_function: &'static str,
    class: AccountingClass,
    note: &'static str,
}

impl Leaf {
    fn commitment(&self, maturity_date: u64) -> Fr {
        note_commitment(self.value, self.salt, self.owner, ASSET_ID, maturity_date)
    }
}

#[derive(Serialize)]
struct MintArgs {
    commitment: String,
}

#[derive(Serialize)]
struct MintBatchArgs {
    commitments: Vec<String>,
}

#[derive(Serialize)]
struct JoinSplitArgs {
    root: String,
    #[serde(rename = "nullifiersIn")]
    nullifiers_in: Vec<String>,
    #[serde(rename = "commitmentsOut")]
    commitments_out: Vec<String>,
}

#[derive(Serialize)]
struct AtomicSwapArgs {
    #[serde(rename = "publicInputsA")]
    public_inputs_a: Vec<String>,
    #[serde(rename = "publicInputsB")]
    public_inputs_b: Vec<String>,
}

#[derive(Serialize)]
pub struct Lifecycle {
    pub schema: String,
    #[serde(rename = "bondIdString")]
    pub bond_id_string: String,
    #[serde(rename = "bondId")]
    pub bond_id: String,
    #[serde(rename = "maturityDate")]
    pub maturity_date: u64,
    #[serde(rename = "fixtureGenesisTimestamp")]
    pub fixture_genesis_timestamp: u64,
    #[serde(rename = "proofPlaceholder")]
    pub proof_placeholder: String,
    #[serde(rename = "proofBytesArePlaceholders")]
    pub proof_bytes_are_placeholders: bool,
    mint: MintArgs,
    #[serde(rename = "mintBatch")]
    mint_batch: MintBatchArgs,
    transfer: JoinSplitArgs,
    #[serde(rename = "atomicSwap")]
    atomic_swap: AtomicSwapArgs,
    burn: JoinSplitArgs,
    #[serde(rename = "expectedRoots")]
    pub expected_roots: Vec<String>,
}

impl Lifecycle {
    pub const SCHEMA: &'static str = "bond-replay/lifecycle/1";
}

pub struct GeneratedFixtures {
    pub lifecycle: Lifecycle,
    pub manifest: RecordsManifest,
    pub records: Vec<(String, DisclosedRecord)>,
}

/// The eight-leaf lifecycle of spec §4.2, exercising all five anchor-writing
/// entry points. Eight leaves is the circuit's own cap; the contract has no
/// cap, but the demo stays inside the PoC's stated envelope.
fn leaves(issuer: &Actor, a: &Actor, b: &Actor) -> Vec<Leaf> {
    vec![
        Leaf {
            index: 0,
            value: 100_000_000,
            salt: 1_000_001,
            owner: issuer.owner,
            owner_label: "issuer",
            source_function: "MINT",
            class: AccountingClass::Disclosed,
            note: "Global note tranche, 100,000,000 par. Minted by the issuer.",
        },
        Leaf {
            index: 1,
            value: 0,
            salt: 1_000_002,
            owner: issuer.owner,
            owner_label: "issuer",
            source_function: "MINT_BATCH",
            class: AccountingClass::Disclosed,
            note: "Zero-value auxiliary note; the second join-split input the \
                   contract's 2-in shape requires.",
        },
        Leaf {
            index: 2,
            value: 10_000_000,
            salt: 2_000_001,
            owner: a.owner,
            owner_label: "investor-a",
            source_function: "TRANSFER",
            class: AccountingClass::Disclosed,
            note: "Investor A's holding after the primary allocation.",
        },
        Leaf {
            index: 3,
            value: 90_000_000,
            salt: 2_000_002,
            owner: issuer.owner,
            owner_label: "issuer",
            source_function: "TRANSFER",
            class: AccountingClass::Disclosed,
            note: "Issuer change note from the primary allocation.",
        },
        Leaf {
            index: 4,
            value: 10_000_000,
            salt: 3_000_001,
            owner: b.owner,
            owner_label: "investor-b",
            source_function: "ATOMIC_SWAP",
            class: AccountingClass::Disclosed,
            note: "Investor B's holding after the secondary trade leg.",
        },
        Leaf {
            index: 5,
            value: 90_000_000,
            salt: 3_000_002,
            owner: issuer.owner,
            owner_label: "issuer",
            source_function: "ATOMIC_SWAP",
            class: AccountingClass::Disclosed,
            note: "Issuer change note refreshed by the swap's second leg.",
        },
        Leaf {
            index: 6,
            value: 0,
            salt: 4_000_001,
            owner: b.owner,
            owner_label: "investor-b",
            source_function: "BURN",
            class: AccountingClass::BurnOutputZero,
            note: "Zero-value burn output. Structural artefact of the 2-out \
                   shape, not a disclosed record.",
        },
        Leaf {
            index: 7,
            value: 0,
            salt: 4_000_002,
            owner: issuer.owner,
            owner_label: "issuer",
            source_function: "BURN",
            class: AccountingClass::BurnOutputZero,
            note: "Zero-value burn output. Structural artefact of the 2-out \
                   shape, not a disclosed record.",
        },
    ]
}

/// The local fixture set, at the fixed `MATURITY_DATE`.
pub fn generate() -> Result<GeneratedFixtures> {
    generate_with_maturity(MATURITY_DATE)
}

/// The same lifecycle at a caller-chosen maturity.
///
/// Maturity is an input to every note commitment, so changing it changes the
/// whole anchor log — which is why the local path pins it to a constant and
/// asserts byte-identical regeneration. A public chain cannot have its clock
/// warped, and the contract requires maturity to be in the *future* when
/// `atomicSwap` runs and in the *past* when `burn` runs. A canonical testnet
/// deployment therefore has to pick a real wall-clock maturity shortly after
/// deploy and wait for it. Determinism is not claimed across different
/// maturities; it is claimed for a given one.
pub fn generate_with_maturity(maturity_date: u64) -> Result<GeneratedFixtures> {
    let issuer = Actor::new(ISSUER_PK);
    let investor_a = Actor::new(INVESTOR_A_PK);
    let investor_b = Actor::new(INVESTOR_B_PK);

    let leaves = leaves(&issuer, &investor_a, &investor_b);
    let commitments: Vec<Fr> = leaves.iter().map(|l| l.commitment(maturity_date)).collect();

    // Roots the contract records, one per anchor-appending call.
    let leaf_counts_after_each_call = vec![1usize, 2, 4, 6, 8];
    let roots: Vec<Fr> = leaf_counts_after_each_call
        .iter()
        .map(|&n| build_merkle_root(&commitments[..n]))
        .collect::<Result<_>>()?;

    // Which note each call spends, and whose key nullifies it.
    let spend = |leaf: &Leaf, actor: &Actor| fr_to_hex(&nullifier(leaf.salt, actor.private_key));

    let transfer = JoinSplitArgs {
        // Cites the root as it stood after mintBatch: the contract requires
        // knownRoots[root].
        root: fr_to_hex(&roots[1]),
        nullifiers_in: vec![
            spend(&leaves[0], &issuer),
            spend(&leaves[1], &issuer),
        ],
        commitments_out: vec![fr_to_hex(&commitments[2]), fr_to_hex(&commitments[3])],
    };

    let maturity_hex = fr_to_hex(&fr_from_u64(maturity_date));
    let atomic_swap = AtomicSwapArgs {
        // Layout [0]=root, [1]=nullifier, [2]=commitment, [3]=maturity, per
        // EthSystems' own tests for this entry point.
        public_inputs_a: vec![
            fr_to_hex(&roots[2]),
            spend(&leaves[2], &investor_a),
            fr_to_hex(&commitments[4]),
            maturity_hex.clone(),
        ],
        public_inputs_b: vec![
            fr_to_hex(&roots[2]),
            spend(&leaves[3], &issuer),
            fr_to_hex(&commitments[5]),
            maturity_hex.clone(),
        ],
    };

    let burn = JoinSplitArgs {
        root: fr_to_hex(&roots[3]),
        nullifiers_in: vec![
            spend(&leaves[4], &investor_b),
            spend(&leaves[5], &issuer),
        ],
        commitments_out: vec![fr_to_hex(&commitments[6]), fr_to_hex(&commitments[7])],
    };

    let bond_id = keccak256(BOND_ID_STRING.as_bytes());

    let lifecycle = Lifecycle {
        schema: Lifecycle::SCHEMA.to_string(),
        bond_id_string: BOND_ID_STRING.to_string(),
        bond_id: format!("0x{}", hex::encode(bond_id)),
        maturity_date,
        // Kept self-consistent with maturity rather than pinned to the local
        // constant: on a public chain there is no genesis we control, and this
        // field is only ever the clock reference maturity was derived from.
        fixture_genesis_timestamp: maturity_date - MATURITY_OFFSET_SECS,
        proof_placeholder: PROOF_PLACEHOLDER_HEX.to_string(),
        proof_bytes_are_placeholders: true,
        mint: MintArgs {
            commitment: fr_to_hex(&commitments[0]),
        },
        mint_batch: MintBatchArgs {
            commitments: vec![fr_to_hex(&commitments[1])],
        },
        transfer,
        atomic_swap,
        burn,
        expected_roots: roots.iter().map(fr_to_hex).collect(),
    };

    // Each note's own nullifier, under its owner's key.
    let actor_for = |label: &str| match label {
        "issuer" => &issuer,
        "investor-a" => &investor_a,
        "investor-b" => &investor_b,
        other => unreachable!("unknown owner label {other}"),
    };

    let mut entries = Vec::new();
    let mut records = Vec::new();

    for leaf in &leaves {
        let commitment_hex = fr_to_hex(&leaf.commitment(maturity_date));
        let owner_actor = actor_for(leaf.owner_label);

        let record_file = match leaf.class {
            AccountingClass::Disclosed => {
                let file = format!("bond_{}_{}.json", leaf.owner_label, leaf.salt);
                records.push((
                    file.clone(),
                    DisclosedRecord {
                        commitment: commitment_hex.clone(),
                        nullifier: fr_to_hex(&nullifier(leaf.salt, owner_actor.private_key)),
                        value: leaf.value,
                        salt: leaf.salt,
                        owner: fr_to_hex(&leaf.owner),
                        asset_id: ASSET_ID,
                        maturity_date,
                        created_at: FIXTURE_CREATED_AT.to_string(),
                    },
                ));
                Some(file)
            }
            AccountingClass::BurnOutputZero => None,
        };

        entries.push(ManifestEntry {
            leaf_index: leaf.index,
            class: leaf.class,
            record_file,
            commitment: commitment_hex,
            source_function: leaf.source_function.to_string(),
            note: leaf.note.to_string(),
        });
    }

    let manifest = RecordsManifest {
        schema: RecordsManifest::SCHEMA.to_string(),
        bond_id: format!("0x{}", hex::encode(bond_id)),
        bond_id_string: BOND_ID_STRING.to_string(),
        maturity_date,
        leaf_counts_after_each_call,
        call_order: ["mint", "mintBatch", "transfer", "atomicSwap", "burn"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        entries,
    };

    Ok(GeneratedFixtures {
        lifecycle,
        manifest,
        records,
    })
}

/// Write the generated fixtures. Output is deterministic and safe to diff.
pub fn write_to(build_dir: &Path, fixtures: &GeneratedFixtures) -> Result<()> {
    let records_dir = build_dir.join("records");
    std::fs::create_dir_all(&records_dir)
        .with_context(|| format!("cannot create {}", records_dir.display()))?;

    for (file, record) in &fixtures.records {
        let path = records_dir.join(file);
        std::fs::write(&path, to_pretty_json(record)?)
            .with_context(|| format!("cannot write {}", path.display()))?;
    }

    std::fs::write(
        build_dir.join("records-manifest.json"),
        to_pretty_json(&fixtures.manifest)?,
    )?;
    std::fs::write(
        build_dir.join("lifecycle.json"),
        to_pretty_json(&fixtures.lifecycle)?,
    )?;

    Ok(())
}

fn to_pretty_json<T: Serialize>(value: &T) -> Result<String> {
    let mut s = serde_json::to_string_pretty(value)?;
    s.push('\n');
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_is_deterministic() {
        let a = generate().unwrap();
        let b = generate().unwrap();

        assert_eq!(
            serde_json::to_string(&a.lifecycle).unwrap(),
            serde_json::to_string(&b.lifecycle).unwrap()
        );
        assert_eq!(
            serde_json::to_string(&a.manifest).unwrap(),
            serde_json::to_string(&b.manifest).unwrap()
        );
        assert_eq!(a.records, b.records);
    }

    #[test]
    fn produces_eight_leaves_six_disclosed_two_structural() {
        let f = generate().unwrap();
        assert_eq!(f.manifest.entries.len(), 8);
        assert_eq!(f.records.len(), 6);
        assert_eq!(
            f.manifest
                .entries
                .iter()
                .filter(|e| e.class == AccountingClass::BurnOutputZero)
                .count(),
            2
        );
    }

    #[test]
    fn every_disclosed_record_recomputes_to_its_manifest_commitment() {
        let f = generate().unwrap();
        for entry in &f.manifest.entries {
            let Some(file) = &entry.record_file else { continue };
            let (_, record) = f.records.iter().find(|(n, _)| n == file).unwrap();
            assert_eq!(record.recompute_commitment().unwrap(), entry.commitment);
            assert!(record.claim_is_self_consistent().unwrap());
        }
    }

    #[test]
    fn all_nullifiers_are_distinct() {
        // The contract rejects identical nullifiers within a call, and a
        // repeat across calls would revert as already spent.
        let f = generate().unwrap();
        let json = serde_json::to_value(&f.lifecycle).unwrap();
        let mut all = Vec::new();
        for key in ["transfer", "burn"] {
            for n in json[key]["nullifiersIn"].as_array().unwrap() {
                all.push(n.as_str().unwrap().to_string());
            }
        }
        for key in ["publicInputsA", "publicInputsB"] {
            all.push(json["atomicSwap"][key][1].as_str().unwrap().to_string());
        }

        let mut sorted = all.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), all.len(), "nullifiers must all differ");
        assert_eq!(all.len(), 6);
    }

    #[test]
    fn cited_roots_are_the_roots_of_the_preceding_prefix() {
        let f = generate().unwrap();
        let json = serde_json::to_value(&f.lifecycle).unwrap();
        let roots = &f.lifecycle.expected_roots;

        // transfer cites the root after mintBatch (2 leaves)
        assert_eq!(json["transfer"]["root"].as_str().unwrap(), roots[1]);
        // atomicSwap cites the root after transfer (4 leaves)
        assert_eq!(json["atomicSwap"]["publicInputsA"][0].as_str().unwrap(), roots[2]);
        assert_eq!(json["atomicSwap"]["publicInputsB"][0].as_str().unwrap(), roots[2]);
        // burn cites the root after atomicSwap (6 leaves)
        assert_eq!(json["burn"]["root"].as_str().unwrap(), roots[3]);
    }
}
