//! The three tripwires, as transformations that must make the audit fail.
//!
//! Each one isolates a different trust boundary, and the point of running all
//! three is that they fail in *different places*:
//!
//! 1. **Altered disclosed record** — the issuer's story changed. Caught by
//!    recomputation: the commitment no longer matches the anchor.
//! 2. **Altered served bytes** — the response was modified in flight. Caught
//!    by the attestation: `responseCID` no longer binds.
//! 3. **Lying serving layer** — the operator altered the anchor log *and*
//!    signed the alteration with its own valid key. The attestation check
//!    passes, and the failure lands on root replay against the chain.
//!
//! Tripwire 3 is the one that matters, and it only demonstrates anything
//! because of the re-signature. Without it, a tampered body would trip
//! tripwire 2 and the demo would prove nothing beyond "we can detect edited
//! bytes". With it, the claim stands on its own: the chain, not the serving
//! layer, is the root of trust.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use thegraph_core::{attestation, DeploymentId};

use crate::attestation::DomainConfig;
use crate::gateway::AuditBundle;
use crate::records::DisclosedRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tripwire {
    AlteredRecord,
    AlteredResponseByte,
    ResignedAlteredAnchors,
}

impl Tripwire {
    /// Where this tampering is expected to be caught. Asserted in tests, so a
    /// tripwire that starts failing for the wrong reason is a test failure and
    /// not a quietly weakened demo.
    pub fn expected_detector(&self) -> &'static str {
        match self {
            Tripwire::AlteredRecord => "reconciliation (recomputed commitment absent from the served anchor set)",
            Tripwire::AlteredResponseByte => "attestation verification (responseCID mismatch)",
            Tripwire::ResignedAlteredAnchors => "root replay against on-chain knownRoots",
        }
    }
}

/// Which field of a disclosed record to alter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum RecordField {
    Value,
    Salt,
    Owner,
    MaturityDate,
    AssetId,
}

/// Alter one field of a disclosed record.
///
/// The alteration is deliberately minimal — the smallest change that still
/// changes the commitment — because the demo's point is sensitivity, not
/// spectacle. A single dollar on a ten-million-dollar note is enough.
pub fn alter_record(record: &DisclosedRecord, field: RecordField) -> Result<DisclosedRecord> {
    let mut out = record.clone();
    match field {
        RecordField::Value => out.value = record.value.wrapping_add(1),
        RecordField::Salt => out.salt = record.salt.wrapping_add(1),
        RecordField::AssetId => out.asset_id = record.asset_id.wrapping_add(1),
        RecordField::MaturityDate => out.maturity_date = record.maturity_date.wrapping_add(1),
        RecordField::Owner => {
            // Flip the low bit of the owner field, staying inside the field.
            let owner = crate::field::fr_from_hex(&record.owner)?;
            let bumped = crate::poseidon::owner_from_private_key(owner);
            out.owner = crate::field::fr_to_hex(&bumped);
        }
    }

    if out == *record {
        bail!("tampering produced an identical record; the demo would prove nothing");
    }
    Ok(out)
}

/// Flip one byte of the saved response body.
///
/// Chooses a byte inside a hex value rather than in punctuation, so the result
/// is still well-formed JSON. A tampering that broke the JSON would be caught
/// by the parser and would not demonstrate what the attestation binds.
pub fn alter_one_response_byte(response: &str) -> Result<String> {
    let bytes = response.as_bytes();

    // Find a hex digit inside a quoted 0x value and rotate it.
    let marker = "\"0x";
    let start = response
        .find(marker)
        .context("response contains no 0x-prefixed value to alter")?
        + marker.len();

    let target = (start..bytes.len())
        .find(|&i| bytes[i].is_ascii_hexdigit())
        .context("response contains no hex digit to alter")?;

    let mut out = bytes.to_vec();
    out[target] = match out[target] {
        b'0' => b'1',
        b'f' => b'e',
        c if c.is_ascii_digit() => c + 1,
        c => c - 1,
    };

    let altered = String::from_utf8(out).context("altered response is not valid UTF-8")?;
    if altered == response {
        bail!("byte alteration was a no-op");
    }
    Ok(altered)
}

/// Alter one served *commitment value*, leaving the rest of the response
/// structurally intact.
///
/// Tripwire 3 needs the alteration to land on an anchor, not on incidental
/// metadata. A flipped byte in, say, the `_meta` block hash would sail through
/// root replay and the demo would silently prove nothing — so this targets the
/// anchor log explicitly and fails loudly if it cannot find one.
pub fn alter_a_served_commitment(response: &str) -> Result<String> {
    let mut value: serde_json::Value =
        serde_json::from_str(response).context("served response is not JSON")?;

    let commitments = value
        .pointer_mut("/data/commitments")
        .and_then(|c| c.as_array_mut())
        .context("served response has no data.commitments array to alter")?;

    let first = commitments
        .first_mut()
        .context("served anchor set is empty; there is nothing to tamper with")?;

    let original = first
        .get("value")
        .and_then(|v| v.as_str())
        .context("served commitment has no value field")?
        .to_string();

    let altered = alter_one_response_byte(&format!("\"{original}\""))?
        .trim_matches('"')
        .to_string();

    if altered == original {
        bail!("commitment alteration was a no-op");
    }
    first["value"] = serde_json::Value::String(altered);

    serde_json::to_string(&value).context("cannot re-serialize the altered response")
}

/// Rewrite a served anchor value and re-sign the result with a throwaway key.
///
/// This produces a bundle whose attestation is genuinely valid over genuinely
/// wrong data — the simulated lying serving layer. The signer here is a fresh
/// random key with no allocation behind it, which is itself part of the
/// lesson: signer resolution (step 5) would also reject it, but the demo
/// deliberately shows the *root replay* catching the data itself.
pub fn resign_altered_anchors(
    bundle: &AuditBundle,
    domain: &DomainConfig,
    signer: &alloy::signers::local::PrivateKeySigner,
) -> Result<AuditBundle> {
    let altered_response = alter_a_served_commitment(&bundle.response)?;
    let deployment: DeploymentId = bundle
        .deployment
        .parse()
        .with_context(|| format!("bundle deployment is not a deployment ID: {}", bundle.deployment))?;

    let fresh = attestation::create(
        &domain.eip712(),
        signer,
        &deployment,
        &bundle.request,
        &altered_response,
    );

    Ok(AuditBundle {
        schema: bundle.schema.clone(),
        request: bundle.request.clone(),
        response: altered_response,
        attestation: fresh,
        deployment: bundle.deployment.clone(),
        endpoint: format!("{} (tampered: re-signed)", bundle.endpoint),
        routed_indexer: bundle.routed_indexer.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attestation::verify_offline;
    use alloy::signers::local::PrivateKeySigner;

    fn record() -> DisclosedRecord {
        DisclosedRecord {
            commitment: "0x00".to_string(),
            nullifier: "0x00".to_string(),
            value: 10_000_000,
            salt: 2_000_001,
            owner: crate::field::fr_to_hex(&crate::poseidon::owner_from_private_key(
                crate::field::fr_from_u64(2002),
            )),
            asset_id: 1,
            maturity_date: 1_893_459_600,
            created_at: "2030-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn one_dollar_changes_the_commitment() {
        let original = record();
        let tampered = alter_record(&original, RecordField::Value).unwrap();

        assert_eq!(tampered.value, original.value + 1);
        assert_ne!(
            original.recompute_commitment().unwrap(),
            tampered.recompute_commitment().unwrap()
        );
    }

    #[test]
    fn every_alterable_field_changes_the_commitment() {
        let original = record();
        for field in [
            RecordField::Value,
            RecordField::Salt,
            RecordField::Owner,
            RecordField::MaturityDate,
            RecordField::AssetId,
        ] {
            let tampered = alter_record(&original, field).unwrap();
            assert_ne!(
                original.recompute_commitment().unwrap(),
                tampered.recompute_commitment().unwrap(),
                "{field:?} must be commitment-bearing"
            );
        }
    }

    #[test]
    fn byte_alteration_keeps_the_response_parseable() {
        let response = r#"{"data":{"commitments":[{"value":"0x1de409fb23196575"}]}}"#;
        let altered = alter_one_response_byte(response).unwrap();

        assert_ne!(altered, response);
        assert_eq!(altered.len(), response.len());
        serde_json::from_str::<serde_json::Value>(&altered)
            .expect("altered response must still parse, or the demo shows the wrong failure");
    }

    #[test]
    fn commitment_alteration_targets_the_anchor_log_not_the_metadata() {
        // The failure mode this guards: a byte flip that lands on _meta would
        // leave every anchor intact, root replay would pass, and tripwire 3
        // would look like it fired when it had not.
        let response = r#"{"data":{"_meta":{"block":{"number":9,"hash":"0xaabbcc"}},
            "commitments":[{"leafIndex":"0","value":"0x1de409fb23196575"}]}}"#;

        let altered = alter_a_served_commitment(response).unwrap();
        let before: serde_json::Value = serde_json::from_str(response).unwrap();
        let after: serde_json::Value = serde_json::from_str(&altered).unwrap();

        assert_eq!(
            before["data"]["_meta"], after["data"]["_meta"],
            "metadata must be untouched"
        );
        assert_ne!(
            before["data"]["commitments"][0]["value"],
            after["data"]["commitments"][0]["value"],
            "an anchor value must actually change"
        );
    }

    #[test]
    fn commitment_alteration_needs_an_anchor_to_alter() {
        let empty = r#"{"data":{"commitments":[]}}"#;
        assert!(alter_a_served_commitment(empty).is_err());
    }

    #[test]
    fn resigned_bundle_verifies_but_carries_different_data() {
        let domain = DomainConfig::default();
        let signer = PrivateKeySigner::random();
        let deployment = "QmeVg9Da6uyBvjUEy5JqCgw2VKdkTxjPvcYuE5riGpkqw1";

        let response = r#"{"data":{"commitments":[{"value":"0x1de409fb23196575"}]}}"#;
        let honest = AuditBundle {
            schema: AuditBundle::SCHEMA.to_string(),
            request: "the-request".to_string(),
            response: response.to_string(),
            attestation: attestation::create(
                &domain.eip712(),
                &signer,
                &deployment.parse().unwrap(),
                "the-request",
                response,
            ),
            deployment: deployment.to_string(),
            endpoint: "test://honest".to_string(),
            routed_indexer: None,
        };

        assert!(verify_offline(&honest, &domain).unwrap().passed());

        let liar = resign_altered_anchors(&honest, &domain, &signer).unwrap();

        // The whole point: the tampered bundle is *validly attested*.
        assert!(
            verify_offline(&liar, &domain).unwrap().passed(),
            "tripwire 3 requires the re-signed bundle to pass attestation, so that the failure \
             isolates to root replay rather than collapsing into tripwire 2"
        );
        assert_ne!(liar.response, honest.response);
        assert_ne!(
            liar.attestation.response_cid,
            honest.attestation.response_cid
        );
    }

    #[test]
    fn without_resigning_the_same_tampering_trips_the_attestation_instead() {
        // Guards the distinction the spec draws between tripwires 2 and 3.
        let domain = DomainConfig::default();
        let signer = PrivateKeySigner::random();
        let deployment = "QmeVg9Da6uyBvjUEy5JqCgw2VKdkTxjPvcYuE5riGpkqw1";
        let response = r#"{"data":{"commitments":[{"value":"0x1de409fb23196575"}]}}"#;

        let mut bundle = AuditBundle {
            schema: AuditBundle::SCHEMA.to_string(),
            request: "the-request".to_string(),
            response: response.to_string(),
            attestation: attestation::create(
                &domain.eip712(),
                &signer,
                &deployment.parse().unwrap(),
                "the-request",
                response,
            ),
            deployment: deployment.to_string(),
            endpoint: "test://".to_string(),
            routed_indexer: None,
        };

        bundle.response = alter_one_response_byte(response).unwrap();

        let v = verify_offline(&bundle, &domain).unwrap();
        assert!(!v.passed());
        let failed: Vec<&str> = v
            .checks
            .iter()
            .filter(|c| c.outcome == crate::attestation::CheckOutcome::Fail)
            .map(|c| c.step.as_str())
            .collect();
        assert_eq!(failed, vec!["responseCID"]);
    }

    #[test]
    fn tripwires_name_distinct_detectors() {
        let detectors: Vec<&str> = [
            Tripwire::AlteredRecord,
            Tripwire::AlteredResponseByte,
            Tripwire::ResignedAlteredAnchors,
        ]
        .iter()
        .map(|t| t.expected_detector())
        .collect();

        let mut sorted = detectors.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "each tripwire must fail somewhere different");
    }
}
