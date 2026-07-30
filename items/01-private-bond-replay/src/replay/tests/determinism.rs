//! Determinism, asserted rather than assumed (spec §7).
//!
//! An audit artifact that differs between two runs over identical inputs is
//! not evidence — a reviewer cannot tell a meaningful change from noise. These
//! tests pin that property at the two places it could break: fixture
//! generation, and the reconciliation report.

mod support;

use std::collections::BTreeMap;

use bond_replay::anchors;
use bond_replay::attestation::{self, DomainConfig};
use bond_replay::gateway::AuditBundle;
use bond_replay::reconcile::{self, ReconcileInputs};
use bond_replay::records::DisclosedRecord;

use support::{fixtures, served_anchor_set, CONTRACT, DEPLOYMENT};

fn bundle_over(response: &str, domain: &DomainConfig) -> AuditBundle {
    let signer = alloy::signers::local::PrivateKeySigner::from_bytes(
        &alloy::primitives::b256!(
            "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"
        ),
    )
    .unwrap();
    let request = "the-request";

    AuditBundle {
        schema: AuditBundle::SCHEMA.to_string(),
        request: request.to_string(),
        response: response.to_string(),
        attestation: thegraph_core::attestation::create(
            &domain.eip712(),
            &signer,
            &DEPLOYMENT.parse().unwrap(),
            request,
            response,
        ),
        deployment: DEPLOYMENT.to_string(),
        endpoint: "test://determinism".to_string(),
        routed_indexer: None,
    }
}

fn loaded_records(
    f: &bond_replay::fixtures::GeneratedFixtures,
) -> BTreeMap<u64, DisclosedRecord> {
    let mut out = BTreeMap::new();
    for entry in &f.manifest.entries {
        let Some(file) = &entry.record_file else { continue };
        let (_, record) = f.records.iter().find(|(n, _)| n == file).unwrap();
        out.insert(entry.leaf_index, record.clone());
    }
    out
}

#[test]
fn fixture_generation_is_byte_identical_across_runs() {
    let a = fixtures();
    let b = fixtures();

    assert_eq!(
        serde_json::to_string_pretty(&a.manifest).unwrap(),
        serde_json::to_string_pretty(&b.manifest).unwrap()
    );
    assert_eq!(
        serde_json::to_string_pretty(&a.lifecycle).unwrap(),
        serde_json::to_string_pretty(&b.lifecycle).unwrap()
    );

    for ((name_a, rec_a), (name_b, rec_b)) in a.records.iter().zip(b.records.iter()) {
        assert_eq!(name_a, name_b);
        assert_eq!(
            serde_json::to_string_pretty(rec_a).unwrap(),
            serde_json::to_string_pretty(rec_b).unwrap()
        );
    }
}

#[tokio::test]
async fn the_same_bundle_reconciles_to_a_byte_identical_report_twice() {
    let f = fixtures();
    let body = served_anchor_set(&f);
    let domain = DomainConfig::default();
    let bundle = bundle_over(&body, &domain);
    let set = anchors::parse_anchor_set(&bundle.response).unwrap();
    let records = loaded_records(&f);

    let run = || async {
        reconcile::reconcile(
            ReconcileInputs {
                anchor_set: &set,
                manifest: &f.manifest,
                records: &records,
                attestation: attestation::verify_offline(&bundle, &domain).unwrap(),
                deployment: DEPLOYMENT.to_string(),
                contract: CONTRACT.to_string(),
            },
            None,
            false,
        )
        .await
        .unwrap()
        .to_json()
        .unwrap()
    };

    let first = run().await;
    let second = run().await;

    assert_eq!(first, second, "reconcile reports must be byte-identical");

    // A wall-clock field is the usual way this property is lost, so pin its
    // absence explicitly rather than relying on nobody adding one.
    for banned in ["timestamp\":", "generatedAt", "\"now\"", "elapsed"] {
        assert!(
            !first.contains(banned),
            "report contains a non-reproducible field: {banned}"
        );
    }
}

#[tokio::test]
async fn reordered_served_entities_produce_the_same_report() {
    // graph-node's ordering is stable, but a consumer must not depend on
    // arrival order for its conclusions: the leaf index is the authority.
    let f = fixtures();
    let domain = DomainConfig::default();

    let ordered = served_anchor_set(&f);
    let mut value: serde_json::Value = serde_json::from_str(&ordered).unwrap();
    value["data"]["commitments"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let reversed = value.to_string();

    let records = loaded_records(&f);

    async fn report_for(
        body: String,
        domain: &DomainConfig,
        manifest: &bond_replay::records::RecordsManifest,
        records: &BTreeMap<u64, DisclosedRecord>,
    ) -> reconcile::ReconcileReport {
        let bundle = bundle_over(&body, domain);
        let set = anchors::parse_anchor_set(&bundle.response).unwrap();
        reconcile::reconcile(
            ReconcileInputs {
                anchor_set: &set,
                manifest,
                records,
                attestation: attestation::verify_offline(&bundle, domain).unwrap(),
                deployment: DEPLOYMENT.to_string(),
                contract: CONTRACT.to_string(),
            },
            None,
            false,
        )
        .await
        .unwrap()
    }

    let a = report_for(ordered, &domain, &f.manifest, &records).await;
    let b = report_for(reversed, &domain, &f.manifest, &records).await;

    assert_eq!(
        a.records.len(),
        b.records.len(),
        "record checks must not depend on arrival order"
    );
    for (x, y) in a.records.iter().zip(b.records.iter()) {
        assert_eq!(x.leaf_index, y.leaf_index);
        assert_eq!(x.recomputed_commitment, y.recomputed_commitment);
        assert_eq!(x.served_commitment, y.served_commitment);
        assert_eq!(x.outcome, y.outcome);
    }
    for (x, y) in a.root_replay.iter().zip(b.root_replay.iter()) {
        assert_eq!(
            x.rebuilt_root, y.rebuilt_root,
            "rebuilt roots must not depend on arrival order"
        );
    }
}
