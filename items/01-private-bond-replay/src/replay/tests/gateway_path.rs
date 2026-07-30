//! The HTTP audit path, end to end against the gateway shim.
//!
//! Hermetic: no chain, no Docker, no network. What these cover is everything
//! between "issue a query" and "hold a verified bundle", plus the reconciliation
//! checks that do not need an RPC endpoint.
//!
//! The chain-backed legs — root replay against `knownRoots` and the
//! `--verify-onchain` storage cross-check — are exercised by
//! tests/integration/run-local-e2e.sh against the real stack, because a root
//! check with no chain behind it would be theatre.

mod support;

use std::collections::BTreeMap;

use bond_replay::anchors::{self, BlockPinValue};
use bond_replay::attestation::{self, CheckOutcome, DomainConfig};
use bond_replay::consistency::{self, Collected, RouteKind};
use bond_replay::gateway::GatewayClient;
use bond_replay::mock_gateway::{MockGateway, MockIndexer};
use bond_replay::reconcile::{self, ReconcileInputs};
use bond_replay::records::DisclosedRecord;
use bond_replay::tamper;

use support::{fixtures, served_anchor_set, BLOCK_HASH, CONTRACT, DEPLOYMENT};

fn query() -> String {
    anchors::audit_query(&BlockPinValue::Hash(BLOCK_HASH.to_string()))
}

fn records(f: &bond_replay::fixtures::GeneratedFixtures) -> BTreeMap<u64, DisclosedRecord> {
    let mut out = BTreeMap::new();
    for entry in &f.manifest.entries {
        let Some(file) = &entry.record_file else { continue };
        let (_, record) = f.records.iter().find(|(n, _)| n == file).unwrap();
        out.insert(entry.leaf_index, record.clone());
    }
    out
}

#[tokio::test]
async fn fetch_then_verify_passes_against_an_honest_indexer() {
    let f = fixtures();
    let body = served_anchor_set(&f);
    let domain = DomainConfig::default();

    let indexer = MockIndexer::honest(body);
    let expected_signer = indexer.signer.address();
    let gateway = MockGateway::new(domain.clone(), DEPLOYMENT, indexer).unwrap();
    let running = gateway.serve().await.unwrap();

    let client = GatewayClient::new(&running.base_url, None).unwrap();
    let url = client.deployment_url(DEPLOYMENT);
    let bundle = client.fetch(&url, &query(), DEPLOYMENT, None).await.unwrap();

    let verification = attestation::verify_offline(&bundle, &domain).unwrap();
    assert!(verification.passed(), "checks: {:#?}", verification.checks);
    assert_eq!(
        verification.recovered_allocation.unwrap().to_lowercase(),
        expected_signer.to_string().to_lowercase(),
        "the recovered signer must be the indexer that actually answered"
    );

    // The request the CLI reconstructs is the one the shim hashed, which is
    // the property the whole attestation check rests on.
    assert_eq!(
        bundle.request,
        bond_replay::gateway::canonical_request_string_no_variables(&query())
    );

    running.shutdown();
}

#[tokio::test]
async fn an_unattested_response_fails_closed() {
    let f = fixtures();
    let gateway = MockGateway::new(
        DomainConfig::default(),
        DEPLOYMENT,
        MockIndexer::unattested(served_anchor_set(&f)),
    )
    .unwrap();
    let running = gateway.serve().await.unwrap();

    let client = GatewayClient::new(&running.base_url, None).unwrap();
    let url = client.deployment_url(DEPLOYMENT);
    let err = client
        .fetch(&url, &query(), DEPLOYMENT, None)
        .await
        .unwrap_err()
        .to_string();

    assert!(
        err.contains("graph-attestation"),
        "an answer without an attestation must be refused, not accepted: {err}"
    );
    running.shutdown();
}

#[tokio::test]
async fn records_and_accounting_reconcile_against_the_served_anchor_set() {
    let f = fixtures();
    let body = served_anchor_set(&f);
    let domain = DomainConfig::default();

    let gateway = MockGateway::new(domain.clone(), DEPLOYMENT, MockIndexer::honest(body)).unwrap();
    let running = gateway.serve().await.unwrap();
    let client = GatewayClient::new(&running.base_url, None).unwrap();
    let url = client.deployment_url(DEPLOYMENT);
    let bundle = client.fetch(&url, &query(), DEPLOYMENT, None).await.unwrap();

    let set = anchors::parse_anchor_set(&bundle.response).unwrap();
    let loaded = records(&f);

    let report = reconcile::reconcile(
        ReconcileInputs {
            anchor_set: &set,
            manifest: &f.manifest,
            records: &loaded,
            attestation: attestation::verify_offline(&bundle, &domain).unwrap(),
            deployment: DEPLOYMENT.to_string(),
            contract: CONTRACT.to_string(),
        },
        None,
        false,
    )
    .await
    .unwrap();

    assert_eq!(report.records.len(), 6);
    for record in &report.records {
        assert_eq!(
            record.outcome,
            CheckOutcome::Pass,
            "leaf {} did not reconcile: {}",
            record.leaf_index,
            record.detail
        );
    }
    assert_eq!(report.anchor_accounting.outcome, CheckOutcome::Pass);
    assert_eq!(report.anchor_accounting.burn_output_zero_count, 2);
    assert!(report.anchor_accounting.unaccounted_leaf_indices.is_empty());
    assert!(report.anchor_accounting.missing_leaf_indices.is_empty());

    // With no RPC endpoint the run must NOT be green: root replay is the check
    // that anchors trust in the chain, and skipping it silently would be the
    // single most dangerous way this tool could fail.
    assert!(!report.passed());
    for root in &report.root_replay {
        assert_eq!(root.outcome, CheckOutcome::Fail);
        assert!(root.detail.contains("no RPC endpoint"));
    }

    running.shutdown();
}

#[tokio::test]
async fn an_anchor_the_disclosure_cannot_account_for_fails_reconciliation() {
    let f = fixtures();
    let domain = DomainConfig::default();

    // A ninth leaf nobody disclosed: the "issuer anchored something it did not
    // tell the auditor about" case.
    let mut body: serde_json::Value = serde_json::from_str(&served_anchor_set(&f)).unwrap();
    let extra = serde_json::json!({
        "id": "000000000008",
        "leafIndex": "8",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000abc",
        "sourceFunction": "MINT",
        "txHash": "0x00", "blockNumber": "1", "timestamp": "1", "caller": "0x00"
    });
    body["data"]["commitments"].as_array_mut().unwrap().push(extra);

    let set = anchors::parse_anchor_set(&body.to_string()).unwrap();
    let loaded = records(&f);

    let bundle = bond_replay::gateway::AuditBundle {
        schema: bond_replay::gateway::AuditBundle::SCHEMA.to_string(),
        request: "r".into(),
        response: "x".into(),
        attestation: thegraph_core::attestation::create(
            &domain.eip712(),
            &alloy::signers::local::PrivateKeySigner::random(),
            &DEPLOYMENT.parse().unwrap(),
            "r",
            "x",
        ),
        deployment: DEPLOYMENT.to_string(),
        endpoint: "test://".into(),
        routed_indexer: None,
    };

    let report = reconcile::reconcile(
        ReconcileInputs {
            anchor_set: &set,
            manifest: &f.manifest,
            records: &loaded,
            attestation: attestation::verify_offline(&bundle, &domain).unwrap(),
            deployment: DEPLOYMENT.to_string(),
            contract: CONTRACT.to_string(),
        },
        None,
        false,
    )
    .await
    .unwrap();

    assert_eq!(report.anchor_accounting.outcome, CheckOutcome::Fail);
    assert_eq!(report.anchor_accounting.unaccounted_leaf_indices, vec![8]);
    assert!(!report.passed());
}

#[tokio::test]
async fn a_tampered_record_is_named_in_the_failure() {
    let f = fixtures();
    let domain = DomainConfig::default();
    let set = anchors::parse_anchor_set(&served_anchor_set(&f)).unwrap();

    let mut loaded = records(&f);
    let original = loaded.get(&2).unwrap().clone();
    let altered = tamper::alter_record(&original, tamper::RecordField::Value).unwrap();
    loaded.insert(2, altered);

    let bundle = bond_replay::gateway::AuditBundle {
        schema: bond_replay::gateway::AuditBundle::SCHEMA.to_string(),
        request: "r".into(),
        response: "x".into(),
        attestation: thegraph_core::attestation::create(
            &domain.eip712(),
            &alloy::signers::local::PrivateKeySigner::random(),
            &DEPLOYMENT.parse().unwrap(),
            "r",
            "x",
        ),
        deployment: DEPLOYMENT.to_string(),
        endpoint: "test://".into(),
        routed_indexer: None,
    };

    let report = reconcile::reconcile(
        ReconcileInputs {
            anchor_set: &set,
            manifest: &f.manifest,
            records: &loaded,
            attestation: attestation::verify_offline(&bundle, &domain).unwrap(),
            deployment: DEPLOYMENT.to_string(),
            contract: CONTRACT.to_string(),
        },
        None,
        false,
    )
    .await
    .unwrap();

    let failed: Vec<&reconcile::RecordCheck> = report
        .records
        .iter()
        .filter(|r| r.outcome == CheckOutcome::Fail)
        .collect();

    assert_eq!(failed.len(), 1, "exactly the altered record should fail");
    assert_eq!(failed[0].leaf_index, 2);
    assert!(
        report.failures.iter().any(|f| f.contains(&failed[0].record_file)),
        "the failure list must name the offending file: {:?}",
        report.failures
    );
}

#[tokio::test]
async fn consistency_reports_agreement_across_distinct_signers() {
    let f = fixtures();
    let body = served_anchor_set(&f);
    let domain = DomainConfig::default();

    let a = MockIndexer::honest(body.clone());
    let b = MockIndexer::honest(body.clone());
    let (addr_a, addr_b) = (a.address(), b.address());

    let gateway = MockGateway::new(domain.clone(), DEPLOYMENT, MockIndexer::honest(body))
        .unwrap()
        .with_indexers(vec![a, b]);
    let running = gateway.serve().await.unwrap();
    let client = GatewayClient::new(&running.base_url, None).unwrap();

    let mut collected = Vec::new();
    for address in [&addr_a, &addr_b] {
        let url = client.indexer_url(DEPLOYMENT, address);
        let bundle = client
            .fetch(&url, &query(), DEPLOYMENT, Some(address.clone()))
            .await
            .unwrap();
        let verification = attestation::verify_offline(&bundle, &domain).unwrap();
        assert!(verification.passed());
        collected.push(Collected {
            allocation: verification.recovered_allocation.clone().unwrap(),
            resolved: Some(attestation::ResolvedSigner {
                allocation: verification.recovered_allocation.unwrap(),
                indexer: address.clone(),
                staked_tokens: "100000".into(),
                allocated_tokens: "500".into(),
                status: "Active".into(),
                deployment: DEPLOYMENT.into(),
            }),
            bundle,
        });
    }

    let report = consistency::build_report(
        DEPLOYMENT.into(),
        9,
        BLOCK_HASH.into(),
        RouteKind::TargetedPerIndexer,
        2,
        &collected,
    );

    assert_eq!(report.agreement, consistency::AgreementClass::ByteIdentical);
    assert_eq!(report.distinct_signers_observed, 2);
    assert!(report.coverage_claim_supported);
    assert_eq!(report.result, CheckOutcome::Pass);
    assert_ne!(
        report.observations[0].allocation, report.observations[1].allocation,
        "two different keys must produce two different signers"
    );

    running.shutdown();
}

#[tokio::test]
async fn consistency_catches_a_lying_indexer_and_keeps_both_attestations() {
    let f = fixtures();
    let honest_body = served_anchor_set(&f);

    // A serving layer that alters an anchor and signs its own alteration. Its
    // attestation is perfectly valid; only the data is wrong.
    let altered = tamper::alter_one_response_byte(&honest_body).unwrap();
    let domain = DomainConfig::default();

    let good = MockIndexer::honest(honest_body.clone());
    let liar = MockIndexer::lying(altered);
    let (addr_good, addr_liar) = (good.address(), liar.address());

    let gateway = MockGateway::new(domain.clone(), DEPLOYMENT, MockIndexer::honest(honest_body))
        .unwrap()
        .with_indexers(vec![good, liar]);
    let running = gateway.serve().await.unwrap();
    let client = GatewayClient::new(&running.base_url, None).unwrap();

    let mut collected = Vec::new();
    for address in [&addr_good, &addr_liar] {
        let url = client.indexer_url(DEPLOYMENT, address);
        let bundle = client
            .fetch(&url, &query(), DEPLOYMENT, Some(address.clone()))
            .await
            .unwrap();
        let verification = attestation::verify_offline(&bundle, &domain).unwrap();

        // Both verify. That is the point: attestation alone cannot separate
        // these two answers.
        assert!(
            verification.passed(),
            "both the honest and the lying answer are validly attested"
        );

        collected.push(Collected {
            allocation: verification.recovered_allocation.clone().unwrap(),
            resolved: Some(attestation::ResolvedSigner {
                allocation: verification.recovered_allocation.unwrap(),
                indexer: address.clone(),
                staked_tokens: "100000".into(),
                allocated_tokens: "500".into(),
                status: "Active".into(),
                deployment: DEPLOYMENT.into(),
            }),
            bundle,
        });
    }

    let report = consistency::build_report(
        DEPLOYMENT.into(),
        9,
        BLOCK_HASH.into(),
        RouteKind::TargetedPerIndexer,
        2,
        &collected,
    );

    assert_eq!(report.agreement, consistency::AgreementClass::DataDivergence);
    assert_eq!(report.result, CheckOutcome::Fail);
    assert_ne!(
        report.observations[0].response_cid, report.observations[1].response_cid,
        "divergent answers must carry divergent, individually attributable CIDs"
    );

    running.shutdown();
}

#[tokio::test]
async fn a_missing_targeted_route_is_detectable_rather_than_silent() {
    // Mirrors spec §9.5: the route exists at source but may not be exposed for
    // a given key tier. The CLI must be able to tell, because the best-effort
    // fallback cannot support a coverage claim.
    let f = fixtures();
    let indexer = MockIndexer::honest(served_anchor_set(&f));
    let address = indexer.address();

    let gateway = MockGateway::new(
        DomainConfig::default(),
        DEPLOYMENT,
        MockIndexer::honest(served_anchor_set(&f)),
    )
    .unwrap()
    .with_indexers(vec![indexer])
    .without_targeted_route();

    let running = gateway.serve().await.unwrap();
    let client = GatewayClient::new(&running.base_url, None).unwrap();

    let targeted = client
        .fetch(
            &client.indexer_url(DEPLOYMENT, &address),
            &query(),
            DEPLOYMENT,
            None,
        )
        .await;
    assert!(targeted.is_err(), "targeted route should be unavailable here");

    // The main route still answers, which is exactly the situation where a
    // coverage claim must not be made.
    let main = client
        .fetch(&client.deployment_url(DEPLOYMENT), &query(), DEPLOYMENT, None)
        .await;
    assert!(main.is_ok());

    running.shutdown();
}
