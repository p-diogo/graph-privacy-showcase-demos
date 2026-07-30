//! `bond-replay` — the auditor's replay CLI for item 01.
//!
//! Makes step 6 of the map's `pattern-l2-encrypted-offchain-audit` executable:
//! fetch the complete anchor set from the network, verify the response's
//! attestation offline, reconcile a disclosed set of off-chain bond records
//! against the served anchors and the on-chain anchored roots, and fail loudly
//! when any of it has been rewritten.
//!
//! Bounds that hold everywhere in this crate, and in everything it prints:
//!
//! * The Graph indexes public chain state. It is not a privacy technology, and
//!   nothing here provides one. The bond's confidentiality comes from the
//!   PoC's own design; this is the read and audit path over its public surface.
//! * Attestations are signatures, not validity proofs. They make a wrong
//!   answer attributable and slashable — never "verified".
//! * Completeness is with respect to on-chain emissions, never off-chain
//!   reality. No proof-of-reserves reading is supportable.
//! * Read privacy does not exist here. An audit run tells the gateway and each
//!   serving indexer exactly what is being audited, and when.

pub mod anchors;
pub mod attestation;
pub mod consistency;
pub mod field;
pub mod fixtures;
pub mod gateway;
pub mod merkle;
pub mod mock_gateway;
pub mod onchain;
pub mod poseidon;
pub mod reconcile;
pub mod records;
pub mod tamper;
