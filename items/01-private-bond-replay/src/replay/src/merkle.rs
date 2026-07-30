//! The contract's Merkle root algorithm, reimplemented exactly.
//!
//! This is a port of `PrivateBond.buildMerkleRoot()`, not of the Noir
//! circuit's tree. The two differ: the circuit uses a fixed height-3 tree
//! padded with zeros, while the contract rebuilds over exactly the leaves it
//! holds and duplicates an unpaired node as its own sibling. `knownRoots` is
//! populated by the *contract's* algorithm, so replaying "against the anchored
//! roots" means reproducing this one.
//!
//! Root reconstruction lives here, in the CLI, rather than in the subgraph:
//! there is no vetted Poseidon-BN254 implementation for AssemblyScript, and
//! writing one is product-grade cryptographic work that honesty rule 6 stops.

use anyhow::{bail, Result};
use poseidon_rs::Fr;

use crate::poseidon::hash_pair;

/// Rebuild the root over `leaves`, in the contract's exact shape.
///
/// Mirrors the Solidity line for line, including the `commitments.length > 0`
/// precondition, which the contract enforces with a require.
pub fn build_merkle_root(leaves: &[Fr]) -> Result<Fr> {
    if leaves.is_empty() {
        bail!("No commitments provided");
    }

    let mut current: Vec<Fr> = leaves.to_vec();

    while current.len() > 1 {
        let mut next: Vec<Fr> = Vec::with_capacity(current.len().div_ceil(2));

        let mut i = 0;
        while i < current.len() {
            let left = current[i];
            // The odd-node rule: an unpaired node is hashed with itself, never
            // with a zero sibling. Asserted against the contract in
            // src/contracts/test/RootGroundTruth.t.sol.
            let right = if i + 1 < current.len() { current[i + 1] } else { left };
            next.push(hash_pair(left, right));
            i += 2;
        }

        current = next;
    }

    Ok(current[0])
}

/// The root as it stood after each anchor-appending call.
///
/// `leaf_counts_after_each_call` is the running total of leaves once each call
/// returned. The contract recomputes and records a root at the end of every
/// such call, so this yields exactly the set of roots that must be present in
/// `knownRoots` — the plural in "replay the log against the anchored roots".
pub fn root_history(leaves: &[Fr], leaf_counts_after_each_call: &[usize]) -> Result<Vec<Fr>> {
    let mut roots = Vec::with_capacity(leaf_counts_after_each_call.len());

    for &count in leaf_counts_after_each_call {
        if count == 0 || count > leaves.len() {
            bail!(
                "leaf count {count} out of range for a served log of {} leaves",
                leaves.len()
            );
        }
        roots.push(build_merkle_root(&leaves[..count])?);
    }

    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::fr_from_u64;

    #[test]
    fn single_leaf_root_is_the_leaf() {
        // The Solidity while-loop body never runs for one leaf.
        let leaf = fr_from_u64(42);
        assert_eq!(build_merkle_root(&[leaf]).unwrap(), leaf);
    }

    #[test]
    fn empty_input_is_rejected_like_the_contract() {
        let err = build_merkle_root(&[]).unwrap_err().to_string();
        assert_eq!(err, "No commitments provided");
    }

    #[test]
    fn odd_leaf_duplicates_itself() {
        let a = fr_from_u64(1);
        let b = fr_from_u64(2);
        let c = fr_from_u64(3);

        let expected = hash_pair(hash_pair(a, b), hash_pair(c, c));
        assert_eq!(build_merkle_root(&[a, b, c]).unwrap(), expected);

        let zero_padded = hash_pair(hash_pair(a, b), hash_pair(c, fr_from_u64(0)));
        assert_ne!(build_merkle_root(&[a, b, c]).unwrap(), zero_padded);
    }

    #[test]
    fn root_history_tracks_prefixes() {
        let leaves: Vec<Fr> = (1..=6).map(fr_from_u64).collect();
        let roots = root_history(&leaves, &[1, 2, 4, 6]).unwrap();

        assert_eq!(roots.len(), 4);
        assert_eq!(roots[0], build_merkle_root(&leaves[..1]).unwrap());
        assert_eq!(roots[3], build_merkle_root(&leaves[..6]).unwrap());
    }

    #[test]
    fn root_history_rejects_counts_beyond_the_served_log() {
        let leaves: Vec<Fr> = (1..=3).map(fr_from_u64).collect();
        assert!(root_history(&leaves, &[1, 5]).is_err());
    }
}
