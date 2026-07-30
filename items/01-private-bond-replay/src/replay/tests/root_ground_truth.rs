//! The CLI's Merkle implementation, checked against the deployed contract.
//!
//! The vectors are produced by `PrivateBond.buildMerkleRoot()` itself, in
//! `src/contracts/test/RootGroundTruth.t.sol`. The contract is the authority:
//! `knownRoots` contains whatever *it* computed, so a root the CLI rebuilds is
//! only useful if it matches the contract's, not if it matches a
//! reimplementation of the paper design.
//!
//! Regenerate with:
//!   cd src/contracts && forge test --match-contract RootGroundTruth

use std::path::Path;

use bond_replay::field::{fr_from_dec, fr_from_hex, fr_to_hex};
use bond_replay::merkle::build_merkle_root;
use bond_replay::poseidon::hash_pair;

/// Foundry's `vm.serializeUint` emits small values as JSON numbers and large
/// ones as decimal strings, so vectors carry both spellings.
fn as_decimal(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => panic!("expected a uint, found {other}"),
    }
}

fn load(name: &str) -> serde_json::Value {
    let path = Path::new("../../build/fixtures").join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\n\
             Generate the ground-truth vectors first:\n  \
             cd src/contracts && forge test --match-contract RootGroundTruth",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("ground-truth fixture is valid JSON")
}

#[test]
fn rust_poseidon_matches_the_contracts_poseidon_t3() {
    // Isolates the hash from the tree: if this passes and the tree test fails,
    // the bug is in the tree shape, not in the hash.
    let vectors = load("poseidon-pair-vectors.json");
    let cases = vectors.as_object().expect("object of cases");
    assert!(!cases.is_empty(), "no pair vectors found");

    for (name, case) in cases {
        let left = fr_from_dec(&as_decimal(&case["left"])).unwrap();
        let right = fr_from_dec(&as_decimal(&case["right"])).unwrap();
        let expected = fr_from_dec(&as_decimal(&case["hash"])).unwrap();

        assert_eq!(
            fr_to_hex(&hash_pair(left, right)),
            fr_to_hex(&expected),
            "pair vector {name} diverges from PoseidonT3.sol"
        );
    }
}

#[test]
fn rust_root_matches_the_contract_for_every_leaf_count() {
    let vectors = load("root-vectors.json");
    let cases = vectors.as_object().expect("object of cases");
    assert!(cases.len() >= 12, "expected vectors for 1..12 leaves");

    for (name, case) in cases {
        let leaves: Vec<_> = case["leaves"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| fr_from_hex(v.as_str().unwrap()).unwrap())
            .collect();
        let expected = case["root"].as_str().unwrap();

        assert_eq!(
            fr_to_hex(&build_merkle_root(&leaves).unwrap()),
            expected.to_lowercase(),
            "root for {name} leaf/leaves diverges from PrivateBond.buildMerkleRoot()"
        );
    }
}

#[test]
fn odd_leaf_counts_are_covered_by_the_vectors() {
    // The duplication rule only shows up at odd widths, and it is the single
    // easiest thing to get wrong when porting the algorithm. Assert the
    // fixture actually exercises it rather than trusting the range.
    let vectors = load("root-vectors.json");
    let odd = vectors
        .as_object()
        .unwrap()
        .values()
        .filter(|c| as_decimal(&c["leafCount"]).parse::<u64>().unwrap() % 2 == 1)
        .count();
    assert!(odd >= 5, "expected several odd-width vectors, found {odd}");
}
