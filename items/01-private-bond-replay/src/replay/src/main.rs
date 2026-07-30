//! `bond-replay` command line.
//!
//! Exit codes are the contract: 0 means every check passed, nonzero means at
//! least one did not. Nothing prints a reassuring summary over a failed check.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use alloy::primitives::Address;
use alloy::rpc::types::BlockId;
use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};

use bond_replay::anchors::{self, BlockPinValue};
use bond_replay::attestation::{self, CheckOutcome, DomainConfig};
use bond_replay::consistency::{self, Collected, RouteKind};
use bond_replay::fixtures;
use bond_replay::gateway::{AuditBundle, GatewayClient};
use bond_replay::onchain::ChainReader;
use bond_replay::reconcile::{self, ReconcileInputs};
use bond_replay::records::RecordsManifest;
use bond_replay::tamper::{self, RecordField, Tripwire};

#[derive(Parser)]
#[command(
    name = "bond-replay",
    about = "Auditor replay for the private-bond anchor set",
    long_about = "Replays a disclosed set of off-chain bond records against the anchor set served \
by The Graph and the roots anchored on chain.\n\n\
Attestations verified here are signatures by staked allocations, not validity proofs. \
Completeness is with respect to on-chain anchors only. Queries made by this tool are visible to \
the gateway and to every serving indexer."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate the deterministic seed lifecycle and disclosed-record fixtures.
    SeedFixtures(SeedFixturesArgs),
    /// Fetch the anchor set through the gateway and save an attested bundle.
    Fetch(FetchArgs),
    /// Verify a saved bundle's attestation offline.
    VerifyAttestation(VerifyArgs),
    /// Replay disclosed records against the served anchors and anchored roots.
    Reconcile(ReconcileArgs),
    /// Demonstrate that tampering fails, and fails in the right place.
    Tamper(TamperArgs),
    /// Compare answers from distinct indexers at one pinned block.
    Consistency(ConsistencyArgs),
}

#[derive(Args)]
struct SeedFixturesArgs {
    /// Directory to write lifecycle.json, records-manifest.json and records/.
    #[arg(long, default_value = "../../build")]
    out_dir: PathBuf,
    /// Bond maturity, unix seconds. Defaults to the local fixture constant.
    ///
    /// Only a chain whose clock can be warped can use the default: the
    /// contract wants maturity in the future at `atomicSwap` and in the past
    /// at `burn`. A public-testnet run passes a real wall-clock maturity
    /// shortly after deploy and waits for it.
    #[arg(long, default_value_t = fixtures::MATURITY_DATE)]
    maturity: u64,
}

#[derive(Args, Clone)]
struct DomainArgs {
    /// Chain ID of the attestation EIP-712 domain.
    #[arg(long, default_value_t = attestation::DEFAULT_CHAIN_ID)]
    chain_id: u64,
    /// DisputeManager address of the attestation EIP-712 domain.
    #[arg(long, default_value = attestation::DEFAULT_DISPUTE_MANAGER)]
    dispute_manager: String,
}

impl DomainArgs {
    fn config(&self) -> Result<DomainConfig> {
        Ok(DomainConfig {
            chain_id: self.chain_id,
            dispute_manager: self
                .dispute_manager
                .parse()
                .context("--dispute-manager is not an address")?,
        })
    }
}

#[derive(Args)]
struct FetchArgs {
    /// Gateway base URL.
    #[arg(long)]
    gateway: String,
    /// Subgraph deployment ID (Qm...).
    #[arg(long)]
    deployment: String,
    /// API key. Read from the environment; never stored in this repo.
    #[arg(long, env = "GRAPH_API_KEY", hide_env_values = true)]
    api_key: Option<String>,
    /// Pin to this block number instead of resolving the head via `_meta`.
    #[arg(long)]
    block_number: Option<u64>,
    /// Where to write the audit bundle.
    #[arg(long, default_value = "../../build/audit-bundle.json")]
    out: PathBuf,
}

#[derive(Args)]
struct VerifyArgs {
    #[arg(long, default_value = "../../build/audit-bundle.json")]
    bundle: PathBuf,
    #[command(flatten)]
    domain: DomainArgs,
    /// Resolve the recovered allocation against a network subgraph endpoint.
    #[arg(long)]
    network_subgraph: Option<String>,
}

#[derive(Args)]
struct ReconcileArgs {
    #[arg(long, default_value = "../../build/audit-bundle.json")]
    bundle: PathBuf,
    #[arg(long, default_value = "../../build/records-manifest.json")]
    manifest: PathBuf,
    #[arg(long, default_value = "../../build/records")]
    records_dir: PathBuf,
    /// RPC endpoint used to read `knownRoots`. Point this at your own node.
    #[arg(long)]
    rpc_url: Option<String>,
    /// The deployed PrivateBond address.
    #[arg(long)]
    contract: Option<String>,
    /// Also compare every served commitment against contract storage.
    #[arg(long)]
    verify_onchain: bool,
    #[command(flatten)]
    domain: DomainArgs,
    /// Write the machine-readable report here.
    #[arg(long, default_value = "../../build/reconcile-report.json")]
    report: PathBuf,
}

#[derive(Args)]
struct TamperArgs {
    /// Which tripwire to demonstrate.
    #[arg(long, value_enum)]
    tripwire: TripwireArg,
    /// For the altered-record tripwire: which record file to alter.
    #[arg(long)]
    record: Option<String>,
    /// For the altered-record tripwire: which field to alter.
    #[arg(long, value_enum, default_value = "value")]
    field: RecordField,
    #[arg(long, default_value = "../../build/audit-bundle.json")]
    bundle: PathBuf,
    #[arg(long, default_value = "../../build/records-manifest.json")]
    manifest: PathBuf,
    #[arg(long, default_value = "../../build/records")]
    records_dir: PathBuf,
    #[arg(long)]
    rpc_url: Option<String>,
    #[arg(long)]
    contract: Option<String>,
    #[command(flatten)]
    domain: DomainArgs,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum TripwireArg {
    AlteredRecord,
    AlteredResponseByte,
    ResignedAlteredAnchors,
}

impl From<TripwireArg> for Tripwire {
    fn from(a: TripwireArg) -> Self {
        match a {
            TripwireArg::AlteredRecord => Tripwire::AlteredRecord,
            TripwireArg::AlteredResponseByte => Tripwire::AlteredResponseByte,
            TripwireArg::ResignedAlteredAnchors => Tripwire::ResignedAlteredAnchors,
        }
    }
}

#[derive(Args)]
struct ConsistencyArgs {
    #[arg(long)]
    gateway: String,
    #[arg(long)]
    deployment: String,
    #[arg(long, env = "GRAPH_API_KEY", hide_env_values = true)]
    api_key: Option<String>,
    /// Network subgraph endpoint, for enumerating and resolving indexers.
    #[arg(long)]
    network_subgraph: String,
    /// Minimum distinct signing indexers required.
    #[arg(long, default_value_t = 2)]
    min_signers: usize,
    /// Cap on best-effort main-route attempts, when the targeted route is
    /// unavailable.
    #[arg(long, default_value_t = 20)]
    max_attempts: usize,
    #[command(flatten)]
    domain: DomainArgs,
    #[arg(long, default_value = "../../build/consistency-report.json")]
    report: PathBuf,
    /// Directory for per-signer bundles, always written on divergence.
    #[arg(long, default_value = "../../build/consistency-bundles")]
    bundles_dir: PathBuf,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("bond-replay: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<bool> {
    let cli = Cli::parse();
    match cli.command {
        Command::SeedFixtures(a) => cmd_seed_fixtures(a),
        Command::Fetch(a) => cmd_fetch(a).await,
        Command::VerifyAttestation(a) => cmd_verify(a).await,
        Command::Reconcile(a) => cmd_reconcile(a).await,
        Command::Tamper(a) => cmd_tamper(a).await,
        Command::Consistency(a) => cmd_consistency(a).await,
    }
}

fn cmd_seed_fixtures(args: SeedFixturesArgs) -> Result<bool> {
    std::fs::create_dir_all(&args.out_dir)?;
    let generated = fixtures::generate_with_maturity(args.maturity)?;
    fixtures::write_to(&args.out_dir, &generated)?;

    println!("wrote {} disclosed records", generated.records.len());
    println!("  lifecycle          {}", args.out_dir.join("lifecycle.json").display());
    println!("  records manifest   {}", args.out_dir.join("records-manifest.json").display());
    println!(
        "  bond id            {} ({})",
        generated.manifest.bond_id_string, generated.manifest.bond_id
    );
    println!("  maturity           {}", generated.manifest.maturity_date);
    println!(
        "  leaves             {} ({} disclosed, {} structural burn outputs)",
        generated.manifest.entries.len(),
        generated.records.len(),
        generated.manifest.entries.len() - generated.records.len()
    );
    println!(
        "\nNote: the `proof` arguments in lifecycle.json are placeholder bytes, not proofs.\n\
         They are never inspected under the MockVerifier default."
    );
    Ok(true)
}

async fn cmd_fetch(args: FetchArgs) -> Result<bool> {
    let client = GatewayClient::new(&args.gateway, args.api_key)?;
    let url = client.deployment_url(&args.deployment);

    let pin = match args.block_number {
        Some(n) => BlockPinValue::Number(n),
        None => {
            let meta = client
                .fetch(&url, &anchors::meta_query(), &args.deployment, None)
                .await?;
            let value: serde_json::Value = serde_json::from_str(&meta.response)?;
            let hash = value
                .pointer("/data/_meta/block/hash")
                .and_then(|v| v.as_str())
                .context("_meta did not return a block hash to pin to")?;
            BlockPinValue::Hash(hash.to_string())
        }
    };

    let bundle = client
        .fetch(&url, &anchors::audit_query(&pin), &args.deployment, None)
        .await?;

    // Parse before saving: a bundle that cannot be read as an anchor set is
    // not worth reconciling later.
    let set = anchors::parse_anchor_set(&bundle.response)?;

    write_json(&args.out, &serde_json::to_string_pretty(&bundle)?)?;
    println!("saved audit bundle to {}", args.out.display());
    println!(
        "  pinned block  {} ({})",
        set.meta.block.number, set.meta.block.hash
    );
    println!("  commitments   {}", set.commitments.len());
    println!("  nullifiers    {}", set.nullifiers.len());
    println!(
        "\nThis request was visible to the gateway and to the serving indexer: \
         which deployment, the full query, and when."
    );
    Ok(true)
}

async fn cmd_verify(args: VerifyArgs) -> Result<bool> {
    let bundle = load_bundle(&args.bundle)?;
    let domain = args.domain.config()?;
    let verification = attestation::verify_offline(&bundle, &domain)?;

    for check in &verification.checks {
        let mark = match check.outcome {
            CheckOutcome::Pass => "PASS",
            CheckOutcome::Fail => "FAIL",
        };
        println!("{mark}  {:<22} {}", check.step, check.detail);
    }

    let mut ok = verification.passed();

    if let (Some(endpoint), Some(allocation)) =
        (&args.network_subgraph, &verification.recovered_allocation)
    {
        match resolve_signer(endpoint, allocation, &bundle.deployment).await {
            Ok(signer) => println!(
                "PASS  {:<22} allocation {} -> indexer {} (stake {})",
                "signerResolution", signer.allocation, signer.indexer, signer.staked_tokens
            ),
            Err(e) => {
                println!("FAIL  {:<22} {e:#}", "signerResolution");
                ok = false;
            }
        }
    } else if args.network_subgraph.is_none() {
        println!(
            "SKIP  {:<22} no --network-subgraph given; the signature was recovered but not \
             resolved to a staked indexer",
            "signerResolution"
        );
    }

    println!("\n{}", verification.means);
    Ok(ok)
}

async fn cmd_reconcile(args: ReconcileArgs) -> Result<bool> {
    let bundle = load_bundle(&args.bundle)?;
    let domain = args.domain.config()?;
    let verification = attestation::verify_offline(&bundle, &domain)?;

    let set = anchors::parse_anchor_set(&bundle.response)?;
    let manifest = RecordsManifest::load(&args.manifest)?;
    let records = manifest.load_records(&args.records_dir)?;

    let chain = open_chain(&args.rpc_url, &args.contract, &set).await?;

    let contract_label = args.contract.clone().unwrap_or_else(|| "unknown".to_string());
    let report = reconcile::reconcile(
        ReconcileInputs {
            anchor_set: &set,
            manifest: &manifest,
            records: &records,
            attestation: verification,
            deployment: bundle.deployment.clone(),
            contract: contract_label,
        },
        chain.as_ref(),
        args.verify_onchain,
    )
    .await?;

    print_reconcile(&report);
    write_json(&args.report, &report.to_json()?)?;
    println!("\nreport written to {}", args.report.display());

    Ok(report.passed())
}

async fn cmd_tamper(args: TamperArgs) -> Result<bool> {
    let tripwire: Tripwire = args.tripwire.into();
    let domain = args.domain.config()?;
    let bundle = load_bundle(&args.bundle)?;
    let manifest = RecordsManifest::load(&args.manifest)?;

    println!("tripwire      {tripwire:?}");
    println!("expected to be caught by: {}\n", tripwire.expected_detector());

    let caught = match tripwire {
        Tripwire::AlteredRecord => {
            let file = args
                .record
                .clone()
                .context("--record is required for the altered-record tripwire")?;
            let mut records = manifest.load_records(&args.records_dir)?;

            let leaf = manifest
                .entries
                .iter()
                .find(|e| e.record_file.as_deref() == Some(file.as_str()))
                .with_context(|| format!("manifest lists no record file {file}"))?
                .leaf_index;

            let original = records.get(&leaf).context("record not loaded")?.clone();
            let altered = tamper::alter_record(&original, args.field)?;
            println!(
                "altered {file}: {:?}\n  was {}\n  now {}",
                args.field,
                original.recompute_commitment()?,
                altered.recompute_commitment()?
            );
            records.insert(leaf, altered);

            let set = anchors::parse_anchor_set(&bundle.response)?;
            let chain = open_chain(&args.rpc_url, &args.contract, &set).await?;
            let report = reconcile::reconcile(
                ReconcileInputs {
                    anchor_set: &set,
                    manifest: &manifest,
                    records: &records,
                    attestation: attestation::verify_offline(&bundle, &domain)?,
                    deployment: bundle.deployment.clone(),
                    contract: args.contract.clone().unwrap_or_else(|| "unknown".into()),
                },
                chain.as_ref(),
                false,
            )
            .await?;

            print_reconcile(&report);
            !report.passed()
        }

        Tripwire::AlteredResponseByte => {
            let mut altered = bundle.clone();
            altered.response = tamper::alter_one_response_byte(&bundle.response)?;
            println!("altered one byte of the saved response body");

            let verification = attestation::verify_offline(&altered, &domain)?;
            for check in &verification.checks {
                let mark = if check.outcome == CheckOutcome::Pass { "PASS" } else { "FAIL" };
                println!("{mark}  {:<22} {}", check.step, check.detail);
            }
            !verification.passed()
        }

        Tripwire::ResignedAlteredAnchors => {
            let signer = alloy::signers::local::PrivateKeySigner::random();
            let liar = tamper::resign_altered_anchors(&bundle, &domain, &signer)?;
            println!("served an altered anchor set under a fresh, valid attestation");

            let verification = attestation::verify_offline(&liar, &domain)?;
            println!(
                "attestation verification: {}  <- expected to PASS; that is the point",
                if verification.passed() { "PASS" } else { "FAIL" }
            );
            if !verification.passed() {
                bail!(
                    "the re-signed bundle failed attestation verification, so this run does not \
                     demonstrate tripwire 3"
                );
            }

            let set = anchors::parse_anchor_set(&liar.response)?;
            let chain = open_chain(&args.rpc_url, &args.contract, &set).await?;
            if chain.is_none() {
                bail!(
                    "this tripwire needs --rpc-url and --contract: it demonstrates the chain \
                     catching what the attestation cannot"
                );
            }

            let records = manifest.load_records(&args.records_dir)?;
            let report = reconcile::reconcile(
                ReconcileInputs {
                    anchor_set: &set,
                    manifest: &manifest,
                    records: &records,
                    attestation: verification,
                    deployment: liar.deployment.clone(),
                    contract: args.contract.clone().unwrap_or_else(|| "unknown".into()),
                },
                chain.as_ref(),
                false,
            )
            .await?;

            print_reconcile(&report);

            let root_failed = report
                .root_replay
                .iter()
                .any(|r| r.outcome == CheckOutcome::Fail);
            if !root_failed {
                bail!(
                    "root replay passed against a tampered anchor set; the tripwire did not fire \
                     where it was supposed to"
                );
            }
            !report.passed()
        }
    };

    if caught {
        println!("\nTAMPERING CAUGHT — the audit failed, as it must.");
        Ok(true)
    } else {
        println!("\nTAMPERING NOT CAUGHT — this is a failure of the tooling, not a success.");
        Ok(false)
    }
}

async fn cmd_consistency(args: ConsistencyArgs) -> Result<bool> {
    let client = GatewayClient::new(&args.gateway, args.api_key.clone())?;
    let deployment_url = client.deployment_url(&args.deployment);

    // 1 — pin a block, so honest head-drift cannot masquerade as divergence.
    let meta = client
        .fetch(&deployment_url, &anchors::meta_query(), &args.deployment, None)
        .await?;
    let meta_value: serde_json::Value = serde_json::from_str(&meta.response)?;
    let block_hash = meta_value
        .pointer("/data/_meta/block/hash")
        .and_then(|v| v.as_str())
        .context("_meta did not return a block hash")?
        .to_string();
    let block_number = meta_value
        .pointer("/data/_meta/block/number")
        .and_then(|v| v.as_u64())
        .context("_meta did not return a block number")?;

    let query = anchors::audit_query(&BlockPinValue::Hash(block_hash.clone()));
    let domain = args.domain.config()?;

    // 2 — enumerate candidates.
    let candidates = fetch_active_indexers(&args.network_subgraph, &args.deployment).await?;
    println!("{} candidate indexer(s) with active allocations", candidates.len());

    // 3 — targeted route first; it is the only path that can support a
    //     coverage claim.
    let mut collected: Vec<Collected> = Vec::new();
    let mut route = RouteKind::TargetedPerIndexer;
    let mut targeted_worked = false;

    for indexer in &candidates {
        if consistency::distinct_indexers(&collected).len() >= args.min_signers {
            break;
        }
        let url = client.indexer_url(&args.deployment, indexer);
        match client
            .fetch(&url, &query, &args.deployment, Some(indexer.clone()))
            .await
        {
            Ok(bundle) => {
                targeted_worked = true;
                collected.push(collect(bundle, &domain, &args.network_subgraph).await?);
            }
            Err(e) => eprintln!("  targeted route to {indexer} failed: {e:#}"),
        }
    }

    // 4 — fallback: best-effort, explicitly not a coverage claim.
    if !targeted_worked {
        route = RouteKind::BestEffortMainRoute;
        eprintln!(
            "targeted per-indexer route unavailable; falling back to best-effort sampling of the \
             main route. This path carries no distinctness guarantee."
        );
        for attempt in 0..args.max_attempts {
            if consistency::distinct_indexers(&collected).len() >= args.min_signers {
                break;
            }
            match client
                .fetch(&deployment_url, &query, &args.deployment, None)
                .await
            {
                Ok(bundle) => collected.push(collect(bundle, &domain, &args.network_subgraph).await?),
                Err(e) => eprintln!("  attempt {attempt} failed: {e:#}"),
            }
        }
        if consistency::distinct_indexers(&collected).len() < args.min_signers {
            eprintln!(
                "reached the {} attempt cap with {} distinct signer(s); the main route makes no \
                 distinctness guarantee and no k-of-n coverage is claimed",
                args.max_attempts,
                consistency::distinct_indexers(&collected).len()
            );
        }
    }

    if collected.is_empty() {
        bail!("no attested answers were collected; nothing to compare");
    }

    let report = consistency::build_report(
        args.deployment.clone(),
        block_number,
        block_hash,
        route,
        args.min_signers,
        &collected,
    );

    println!("\nagreement            {:?}", report.agreement);
    println!("distinct signers     {}", report.distinct_signers_observed);
    println!(
        "coverage claim       {}",
        if report.coverage_claim_supported {
            "supported by route"
        } else {
            "NOT supported by route"
        }
    );
    for o in &report.observations {
        println!(
            "  {} indexer={} stake={} cid={}",
            o.allocation,
            o.indexer.as_deref().unwrap_or("<unresolved>"),
            o.staked_tokens.as_deref().unwrap_or("-"),
            o.response_cid
        );
    }
    for f in &report.failures {
        println!("FAIL  {f}");
    }
    println!("\n{}", report.means);

    // Divergence evidence is always preserved, each bundle with its own
    // attestation: that is what makes it non-repudiable.
    if report.agreement != consistency::AgreementClass::ByteIdentical {
        std::fs::create_dir_all(&args.bundles_dir)?;
        for (i, c) in collected.iter().enumerate() {
            let path = args
                .bundles_dir
                .join(format!("signer-{i}-{}.json", c.allocation));
            write_json(&path, &serde_json::to_string_pretty(&c.bundle)?)?;
        }
        println!("divergence bundles written to {}", args.bundles_dir.display());
    }

    write_json(&args.report, &report.to_json()?)?;
    Ok(report.result == CheckOutcome::Pass)
}

// ---------------------------------------------------------------------------

async fn collect(
    bundle: AuditBundle,
    domain: &DomainConfig,
    network_subgraph: &str,
) -> Result<Collected> {
    let verification = attestation::verify_offline(&bundle, domain)?;
    if !verification.passed() {
        bail!(
            "an answer failed attestation verification and cannot be counted as a signed \
             observation: {:?}",
            verification.checks
        );
    }
    let allocation = verification
        .recovered_allocation
        .clone()
        .context("attestation verified but no allocation was recovered")?;

    let resolved = resolve_signer(network_subgraph, &allocation, &bundle.deployment)
        .await
        .ok();

    Ok(Collected {
        bundle,
        allocation,
        resolved,
    })
}

async fn resolve_signer(
    endpoint: &str,
    allocation: &str,
    deployment: &str,
) -> Result<attestation::ResolvedSigner> {
    let body = post_graphql(endpoint, &attestation::allocation_query(allocation)).await?;
    attestation::parse_allocation_response(&body, deployment)
}

async fn fetch_active_indexers(endpoint: &str, deployment: &str) -> Result<Vec<String>> {
    let query = format!(
        "{{allocations(where:{{subgraphDeployment_:{{ipfsHash:\"{deployment}\"}},status:Active}},\
first:100){{id indexer{{id stakedTokens}}}}}}"
    );
    let body = post_graphql(endpoint, &query).await?;
    let value: serde_json::Value = serde_json::from_str(&body)?;

    let mut out = Vec::new();
    if let Some(allocations) = value.pointer("/data/allocations").and_then(|v| v.as_array()) {
        for a in allocations {
            if let Some(id) = a.pointer("/indexer/id").and_then(|v| v.as_str()) {
                let id = id.to_lowercase();
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
    }
    Ok(out)
}

async fn post_graphql(endpoint: &str, query: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .header("content-type", "application/json")
        .body(bond_replay::gateway::client_post_body(query))
        .send()
        .await
        .with_context(|| format!("request to {endpoint} failed"))?;

    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        bail!("{endpoint} returned HTTP {status}: {body}");
    }
    Ok(body)
}

async fn open_chain(
    rpc_url: &Option<String>,
    contract: &Option<String>,
    set: &anchors::AnchorSet,
) -> Result<Option<ChainReader>> {
    let Some(rpc) = rpc_url else { return Ok(None) };

    // Prefer an explicit --contract, else take the address the indexer served.
    let address: Address = match contract {
        Some(c) => c.parse().context("--contract is not an address")?,
        None => set
            .bonds
            .first()
            .map(|b| b.address.parse())
            .transpose()
            .context("served bond address is not an address")?
            .context("no --contract given and the served anchor set names no bond address")?,
    };

    let reader = ChainReader::connect(rpc, address, BlockId::latest()).await?;
    Ok(Some(reader))
}

fn load_bundle(path: &Path) -> Result<AuditBundle> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read audit bundle: {}", path.display()))?;
    let bundle: AuditBundle = serde_json::from_str(&raw)
        .with_context(|| format!("cannot parse audit bundle: {}", path.display()))?;
    if bundle.schema != AuditBundle::SCHEMA {
        bail!(
            "unexpected bundle schema {:?}, expected {:?}",
            bundle.schema,
            AuditBundle::SCHEMA
        );
    }
    Ok(bundle)
}

fn write_json(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents).with_context(|| format!("cannot write {}", path.display()))
}

fn print_reconcile(report: &reconcile::ReconcileReport) {
    let mark = |o: CheckOutcome| if o == CheckOutcome::Pass { "PASS" } else { "FAIL" };

    println!(
        "\nblock {} ({})",
        report.pinned_block_number, report.pinned_block_hash
    );
    println!("bond  {} ({})\n", report.bond_id_string, report.bond_id);

    for r in &report.records {
        println!(
            "{}  leaf {:<3} {:<32} {}",
            mark(r.outcome),
            r.leaf_index,
            r.record_file,
            r.detail
        );
    }

    println!(
        "\n{}  anchor accounting  {}",
        mark(report.anchor_accounting.outcome),
        report.anchor_accounting.detail
    );

    for r in &report.root_replay {
        println!(
            "{}  root after {:<12} ({} leaves)  {}",
            mark(r.outcome),
            r.after_call,
            r.leaf_count,
            r.rebuilt_root
        );
    }

    if let Some(checks) = &report.on_chain_cross_check {
        let failed = checks.iter().filter(|c| c.outcome == CheckOutcome::Fail).count();
        println!(
            "{}  on-chain cross-check of {} served commitment(s), {} mismatch(es)",
            mark(if failed == 0 { CheckOutcome::Pass } else { CheckOutcome::Fail }),
            checks.len(),
            failed
        );
    }

    if report.failures.is_empty() {
        println!("\nRESULT: PASS");
    } else {
        println!("\nRESULT: FAIL");
        for f in &report.failures {
            println!("  - {f}");
        }
    }

    for note in &report.scope {
        println!("\nnote: {note}");
    }
}
