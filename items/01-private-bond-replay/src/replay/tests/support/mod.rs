//! Shared helpers for the hermetic integration tests.

use bond_replay::fixtures::{self, GeneratedFixtures};
use bond_replay::records::AccountingClass;

pub const DEPLOYMENT: &str = "QmeVg9Da6uyBvjUEy5JqCgw2VKdkTxjPvcYuE5riGpkqw1";
pub const BLOCK_NUMBER: u64 = 9;
pub const BLOCK_HASH: &str = "0xeedbc72bf210a3f01008573f7b9c7357be1357a471eafce69bce688f8a123da1";
pub const CONTRACT: &str = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";

/// Build a served anchor-set body in graph-node's response shape, from the
/// same fixture generator the seed script uses.
///
/// The shape here was taken from a real local graph-node answering the real
/// audit query (see BUILD-REPORT.md); keeping it fixture-derived rather than
/// hand-written means these tests exercise the values that would actually be
/// anchored, not values chosen to make them pass.
pub fn served_anchor_set(fixtures: &GeneratedFixtures) -> String {
    let manifest = &fixtures.manifest;

    let commitments: Vec<serde_json::Value> = manifest
        .entries
        .iter()
        .map(|entry| {
            serde_json::json!({
                "id": format!("{:012}", entry.leaf_index),
                "leafIndex": entry.leaf_index.to_string(),
                "value": entry.commitment,
                "sourceFunction": entry.source_function,
                "txHash": "0x00",
                "blockNumber": "1",
                "timestamp": fixtures.lifecycle.fixture_genesis_timestamp.to_string(),
                "caller": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
            })
        })
        .collect();

    let lifecycle_calls: Vec<serde_json::Value> = manifest
        .leaf_counts_after_each_call
        .iter()
        .enumerate()
        .map(|(i, count)| {
            serde_json::json!({
                "id": format!("{i:012}"),
                "function": manifest.call_order[i].to_uppercase(),
                "leafCountAfter": count.to_string(),
                "proofHash": "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                "proofLength": "0",
                "txHash": "0x00",
                "blockNumber": "1",
                "timestamp": fixtures.lifecycle.fixture_genesis_timestamp.to_string(),
                "caller": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
            })
        })
        .collect();

    let disclosed = manifest
        .entries
        .iter()
        .filter(|e| e.class == AccountingClass::Disclosed)
        .count();

    serde_json::to_string(&serde_json::json!({
        "data": {
            "_meta": {
                "block": {"number": BLOCK_NUMBER, "hash": BLOCK_HASH},
                "deployment": DEPLOYMENT,
                "hasIndexingErrors": false
            },
            "bonds": [{
                "id": "bond",
                "address": CONTRACT,
                "bondId": manifest.bond_id,
                "leafCount": manifest.entries.len().to_string(),
                "nullifierCount": disclosed.to_string(),
            }],
            "commitments": commitments,
            "nullifiers": [],
            "rootClaimeds": [],
            "lifecycleCalls": lifecycle_calls,
        }
    }))
    .expect("anchor set serializes")
}

pub fn fixtures() -> GeneratedFixtures {
    fixtures::generate().expect("fixture generation")
}
