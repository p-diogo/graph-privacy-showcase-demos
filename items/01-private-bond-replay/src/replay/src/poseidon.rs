//! Note commitments, nullifiers, and the pairwise tree hash.
//!
//! Every function here is a direct counterpart of code in EthSystems' PoC, and
//! the crate doing the hashing (`poseidon-rs` 0.0.10) is the one their wallet
//! pins. The correspondence is asserted against their own published vectors in
//! `tests/poc_vectors.rs`, and against the deployed contract in
//! `tests/root_ground_truth.rs`.

use std::sync::OnceLock;

use poseidon_rs::{Fr, Poseidon};

use crate::field::fr_from_u64;

/// `Poseidon::new()` rebuilds the full round-constant and MDS tables on every
/// call, which dominates runtime when hashing a tree. The instance is
/// stateless, so one shared copy gives identical results at a fraction of the
/// cost — this is a caching change only, not a change to the hash.
fn hasher() -> &'static Poseidon {
    static HASHER: OnceLock<Poseidon> = OnceLock::new();
    HASHER.get_or_init(Poseidon::new)
}

/// `commitment = Poseidon(value, salt, owner, asset_id, maturity_date)`
///
/// Counterpart of `CircuitNote::commitment` in
/// `wallet/src/prover.rs` and of `note_commit` in `circuits/src/main.nr`.
/// Argument order is load-bearing and matches both.
pub fn note_commitment(value: u64, salt: u64, owner: Fr, asset_id: u64, maturity_date: u64) -> Fr {
    hasher()
        .hash(vec![
            fr_from_u64(value),
            fr_from_u64(salt),
            owner,
            fr_from_u64(asset_id),
            fr_from_u64(maturity_date),
        ])
        .expect("poseidon hash of 5 inputs")
}

/// `nullifier = Poseidon(salt, private_key)`
///
/// Counterpart of `Note::nullifer` in `wallet/src/notes.rs` and
/// `note_nullifier` in the circuit.
pub fn nullifier(salt: u64, private_key: Fr) -> Fr {
    hasher()
        .hash(vec![fr_from_u64(salt), private_key])
        .expect("poseidon hash of 2 inputs")
}

/// `owner = Poseidon(private_key)`
///
/// The circuit constrains `input_owner == hash_1([private_key])`, so an owner
/// field is a public spending key derived this way.
pub fn owner_from_private_key(private_key: Fr) -> Fr {
    hasher()
        .hash(vec![private_key])
        .expect("poseidon hash of 1 input")
}

/// The tree's pairwise hash.
///
/// Counterpart of `PrivateBond.poseidonHash`, which calls the deployed
/// `PoseidonT3` library. `tests/root_ground_truth.rs` asserts this agrees with
/// the contract on vectors the contract itself produced.
pub fn hash_pair(left: Fr, right: Fr) -> Fr {
    hasher()
        .hash(vec![left, right])
        .expect("poseidon hash of 2 inputs")
}
