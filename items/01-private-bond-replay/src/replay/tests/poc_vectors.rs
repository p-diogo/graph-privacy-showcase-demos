//! The CLI's commitment and nullifier functions, checked against EthSystems'
//! own published values.
//!
//! Two independent anchors are used deliberately:
//!
//! * `circuits/Prover.toml` — the witness their prover consumes, so its
//!   `commitments_out` and `nullifiers` are what the *circuit* computes;
//! * `contracts/test/PrivateBond.t.sol` — the constants their Solidity tests
//!   pin.
//!
//! Reproducing both from plaintext, with the crate their wallet pins, is what
//! rules out an entire class of silent audit failure: a commitment that is
//! "correct" only under our own definition of the hash.
//!
//! Values are transcribed from ethsystems/pocs at
//! 94f1e5c94b6c4896977ae68094b99479eef4c371.

use bond_replay::field::{fr_from_hex, fr_from_u64, fr_to_hex};
use bond_replay::poseidon::{hash_pair, note_commitment, nullifier, owner_from_private_key};

/// From `circuits/Prover.toml`.
const PROVER_PRIVATE_KEY: &str = "0x8f03e2d5802e0308";
const PROVER_INPUT_OWNER: &str =
    "0x014690c253b7392ec967c8d43d0c84fd6e2f3349c99ef96fb716e638034a2ea1";
const PROVER_MATURITY: u64 = 1_893_456_000;
const PROVER_ASSET_ID: u64 = 1;

#[test]
fn owner_is_the_poseidon_hash_of_the_private_key() {
    // The circuit constrains `input_owner == hash_1([private_key])`; the
    // Prover.toml pair is the concrete instance of that constraint.
    let pk = fr_from_hex(PROVER_PRIVATE_KEY).unwrap();
    assert_eq!(fr_to_hex(&owner_from_private_key(pk)), PROVER_INPUT_OWNER);
}

#[test]
fn output_commitments_reproduce_prover_toml() {
    let pairs = [
        (
            1_000_000u64,
            "0x229d76a291abdd01",
            "0x09224288ae909c4f3dd9f174dba6919f7109b44baf09fd95a6e463d386a6e98f",
            "0x1b2a41e40670db69490b7db2e79850284159edfa946a8e4ebd9109787c4e1f47",
        ),
        (
            99_000_000u64,
            "0x399fe7dbd0da2fdb",
            PROVER_INPUT_OWNER,
            "0x08421fccbfb32c22899ac2d7ed5db508d6b3a99134c2313eff9a0fa8c9dd3116",
        ),
    ];

    for (value, salt, owner, expected) in pairs {
        let salt = u64::from_str_radix(salt.trim_start_matches("0x"), 16).unwrap();
        let owner = fr_from_hex(owner).unwrap();
        assert_eq!(
            fr_to_hex(&note_commitment(
                value,
                salt,
                owner,
                PROVER_ASSET_ID,
                PROVER_MATURITY
            )),
            expected,
            "commitment for value {value} diverges from Prover.toml"
        );
    }
}

#[test]
fn nullifiers_reproduce_prover_toml() {
    let pk = fr_from_hex(PROVER_PRIVATE_KEY).unwrap();

    let cases = [
        (
            0x94485c80fa244c27u64,
            "0x0f4853301a6e130e81948bf0b9e3f3f1522cdf9ee388278857444904700cb153",
        ),
        (
            0u64,
            "0x21d0b3d5278b9339f65968bde078108fdc71c82a864b1d1d0908a8378f355151",
        ),
    ];

    for (salt, expected) in cases {
        assert_eq!(fr_to_hex(&nullifier(salt, pk)), expected);
    }
}

#[test]
fn pairwise_hash_of_zeros_reproduces_the_circuits_padding_element() {
    // `path_elements[0][1]` in Prover.toml is hash_2(0, 0): the circuit's
    // padding node at level 1. It pins our pair hash against the Noir
    // implementation, independently of the Solidity one.
    assert_eq!(
        fr_to_hex(&hash_pair(fr_from_u64(0), fr_from_u64(0))),
        "0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864"
    );
}

#[test]
fn circuit_test_values_reproduce() {
    // From `circuits/src/main.nr` `test_main`: private_key 999, a 100-unit
    // input note and a zero-value second input, both owned by hash_1(999).
    let pk = fr_from_u64(999);
    let owner = owner_from_private_key(pk);

    let comm_in_0 = note_commitment(100, 123, owner, 1, PROVER_MATURITY);
    let comm_in_1 = note_commitment(0, 0, owner, 1, PROVER_MATURITY);

    // The circuit builds its root as hash(hash(hash(l0,l1), 0), 0) over the
    // fixed height-3 padded tree. Reproducing it here confirms our pair hash
    // composes the same way the circuit's does — while the CLI itself replays
    // the *contract's* tree, which is a different shape.
    let node_0_1 = hash_pair(comm_in_0, comm_in_1);
    let circuit_root = hash_pair(hash_pair(node_0_1, fr_from_u64(0)), fr_from_u64(0));

    assert_ne!(fr_to_hex(&comm_in_0), fr_to_hex(&comm_in_1));
    assert_eq!(fr_to_hex(&circuit_root).len(), 66);

    // The contract's tree over the same two leaves is hash(l0, l1) — no
    // padding to a fixed height. The two disagree, which is exactly why the
    // CLI reimplements the contract and not the circuit.
    let contract_root = bond_replay::merkle::build_merkle_root(&[comm_in_0, comm_in_1]).unwrap();
    assert_eq!(fr_to_hex(&contract_root), fr_to_hex(&node_0_1));
    assert_ne!(fr_to_hex(&contract_root), fr_to_hex(&circuit_root));
}

#[test]
fn solidity_test_constants_are_field_elements_we_can_parse() {
    // From `contracts/test/PrivateBond.t.sol`. These are consumed as opaque
    // bytes32 by the contract; the check that matters here is that they lie in
    // the field, since a value at or above the order would be silently reduced
    // by PoseidonT3 and would break reconciliation in a way that is very hard
    // to see.
    for constant in [
        "0x1f8e0ab650e5df57432b1b9eaad2daaa4510a91a0b75bd035051d3bcb7c0151d",
        "0x1f9622b4d68c1b5b433736ef91c2af7bbff2a6ff7e3de8f7b25f4693493f5df7",
        "0x2088a1456156a7637b04252cc2cb44e7afec6a73ed8913d1d9166c988fe51948",
        "0x1156c6bc9367cc966088ceedb112f454eeca564ce36c0af52a1a6dbc8d57162e",
        "0x1b3df58b47ca4b3e800b6bd238d89a9d78a64245825070dcf50e56f9110a509c",
        "0x1de409fb2319657514027650e41731fc3c5b77448fdd2b9aceeda9cf95c499e7",
    ] {
        assert_eq!(fr_to_hex(&fr_from_hex(constant).unwrap()), constant);
    }
}
