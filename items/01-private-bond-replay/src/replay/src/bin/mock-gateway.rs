//! Run the gateway shim in front of a local graph-node.
//!
//! TEST AND DEMO INFRASTRUCTURE ONLY. Its attestations are signed by a
//! throwaway key with no allocation, no stake, and no dispute path behind it.
//! A green `bond-replay` run against this proves that the audit path works; it
//! proves nothing whatsoever about the decentralized network, and no artifact
//! may present it as network evidence.
//!
//! It exists so the whole local flow — fetch, verify, reconcile, tamper — can
//! be run with the real CLI, against real graph-node output, without a gateway
//! API key and without spending anything.

use anyhow::Result;
use bond_replay::attestation::DomainConfig;
use bond_replay::mock_gateway::{MockGateway, MockIndexer};
use clap::Parser;

#[derive(Parser)]
#[command(
    name = "mock-gateway",
    about = "Local gateway shim for item-01 integration runs (NOT a gateway)"
)]
struct Cli {
    /// graph-node GraphQL endpoint to forward queries to.
    #[arg(long, default_value = "http://127.0.0.1:8000/subgraphs/name/private-bond-anchors")]
    upstream: String,
    /// Deployment ID to attest under. Must match what the CLI is told.
    #[arg(long)]
    deployment: String,
    /// Port to listen on.
    #[arg(long, default_value_t = 8999)]
    port: u16,
    /// Number of distinct mock indexers to expose on the targeted route.
    #[arg(long, default_value_t = 2)]
    indexers: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    eprintln!(
        "mock-gateway: THIS IS NOT A GATEWAY. Attestations below are signed by throwaway keys \
         with no stake behind them and are not evidence about the network."
    );

    // Every mock indexer proxies to the same graph-node, so they agree by
    // construction and the bytes being reconciled are real indexer output.
    // Divergence is produced explicitly by the test harness, never here.
    let domain = DomainConfig::default();
    let default_indexer = MockIndexer::proxying(&cli.upstream);
    let extra: Vec<MockIndexer> = (0..cli.indexers)
        .map(|_| MockIndexer::proxying(&cli.upstream))
        .collect();

    let gateway = MockGateway::new(domain, &cli.deployment, default_indexer)?
        .with_indexers(extra);

    for address in gateway.indexer_addresses() {
        eprintln!("  mock indexer {address}");
    }

    let running = gateway.serve_on(cli.port).await?;
    eprintln!("mock-gateway listening on {}", running.base_url);

    tokio::signal::ctrl_c().await?;
    running.shutdown();
    Ok(())
}
