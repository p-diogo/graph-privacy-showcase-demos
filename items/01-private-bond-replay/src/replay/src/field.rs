//! BN254 scalar-field conversions.
//!
//! These mirror EthSystems' wallet helpers
//! (`pocs/private-bond/custom-utxo/wallet/src/utils.rs` at the pin) on purpose.
//! The whole point of writing the replay CLI in Rust was to share their exact
//! Poseidon crate and field encoding, so a commitment we recompute cannot
//! differ from one their wallet produced for reasons of representation.

use anyhow::{bail, Context, Result};
use ff::PrimeField;
use num_bigint::BigUint;
use poseidon_rs::Fr;

/// The BN254 scalar field order, as used by PoseidonT3.sol and poseidon-rs.
pub const BN254_MODULUS_DEC: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

pub fn modulus() -> BigUint {
    BigUint::parse_bytes(BN254_MODULUS_DEC.as_bytes(), 10).expect("modulus parses")
}

/// Parse a 0x-prefixed (or bare) hex string into a field element.
///
/// Values at or above the field order are rejected rather than silently
/// reduced. The contract's PoseidonT3 reduces its inputs mod the field order,
/// so a caller who hands us an out-of-range value would get a hash that does
/// not correspond to the value they think they supplied. Reconciliation is an
/// audit; it fails loudly instead of guessing.
pub fn fr_from_hex(s: &str) -> Result<Fr> {
    let clean = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    if clean.is_empty() {
        bail!("empty hex string");
    }
    if !clean.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("not a hex string: {s}");
    }
    let n = BigUint::parse_bytes(clean.as_bytes(), 16)
        .with_context(|| format!("cannot parse hex: {s}"))?;
    fr_from_biguint(n, s)
}

pub fn fr_from_u64(v: u64) -> Fr {
    Fr::from_str(&v.to_string()).expect("u64 is always in field")
}

pub fn fr_from_dec(s: &str) -> Result<Fr> {
    let n = BigUint::parse_bytes(s.trim().as_bytes(), 10)
        .with_context(|| format!("cannot parse decimal: {s}"))?;
    fr_from_biguint(n, s)
}

fn fr_from_biguint(n: BigUint, original: &str) -> Result<Fr> {
    if n >= modulus() {
        bail!("value is not a BN254 field element (>= field order): {original}");
    }
    Fr::from_str(&n.to_str_radix(10))
        .with_context(|| format!("poseidon-rs rejected field element: {original}"))
}

/// Big-endian 32-byte encoding, matching the PoC wallet's `fr_to_bytes32`
/// and therefore the `bytes32` the contract stored.
pub fn fr_to_bytes32(f: &Fr) -> [u8; 32] {
    let repr = f.into_repr();
    let limbs: &[u64] = repr.as_ref();

    let mut bytes = [0u8; 32];
    for (i, limb) in limbs.iter().enumerate() {
        let limb_bytes = limb.to_le_bytes();
        bytes[i * 8..(i + 1) * 8].copy_from_slice(&limb_bytes);
    }
    bytes.reverse();
    bytes
}

/// Canonical lowercase `0x`-prefixed 32-byte hex.
///
/// One spelling everywhere: fixtures, reports, and comparisons against served
/// data all use this, so a mismatch is never an artefact of formatting.
pub fn fr_to_hex(f: &Fr) -> String {
    format!("0x{}", hex::encode(fr_to_bytes32(f)))
}

/// Normalise any accepted spelling of a 32-byte value to canonical form.
///
/// Accepts what the PoC wallet's own `parse_commitment` accepts — `Fr(0x..)`,
/// `0x..`, bare hex — so records their wallet wrote can be read directly.
pub fn normalize_bytes32_hex(s: &str) -> Result<String> {
    let trimmed = s.trim();
    let clean = trimmed
        .trim_start_matches("Fr(")
        .trim_end_matches(')')
        .trim();
    Ok(fr_to_hex(&fr_from_hex(clean)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_hex() {
        let f = fr_from_hex("0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864").unwrap();
        assert_eq!(
            fr_to_hex(&f),
            "0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864"
        );
    }

    #[test]
    fn pads_short_hex_to_32_bytes() {
        let f = fr_from_hex("0x01").unwrap();
        assert_eq!(
            fr_to_hex(&f),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
    }

    #[test]
    fn rejects_values_at_or_above_the_field_order() {
        let at_order = format!("0x{}", hex::encode(fr_to_bytes32(&fr_from_u64(0))));
        assert!(fr_from_hex(&at_order).is_ok(), "zero is in field");

        // field order itself, big-endian
        let order_hex = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
        assert!(
            fr_from_hex(order_hex).is_err(),
            "the field order must be rejected, not reduced to zero"
        );
    }

    #[test]
    fn accepts_the_wallets_own_fr_debug_spelling() {
        assert_eq!(
            normalize_bytes32_hex("Fr(0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864)").unwrap(),
            "0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864"
        );
    }

    #[test]
    fn decimal_and_hex_agree() {
        assert_eq!(fr_to_hex(&fr_from_dec("255").unwrap()), fr_to_hex(&fr_from_hex("0xff").unwrap()));
    }
}
