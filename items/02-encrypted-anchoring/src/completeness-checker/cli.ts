#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  UsageError,
  boolFlag,
  computeAnchors,
  disclosedRecords,
  keyMaterial,
  optionalFlag,
  parseArgs,
  readDisclosure,
  requireFlag,
  toHex,
  type Hex,
} from "../anchor-core/index.js";
import { EXIT, compareDisclosureToIndex, compareIndexes, formatFinding, type Verdict } from "./compare.js";
import { GATEWAY_UNEXERCISED_NOTICE, fetchFromGateway } from "./sources/gateway.js";
import { fetchServedIndex } from "./sources/graphql.js";
import { scanChain } from "./sources/chain.js";
import type { ServedIndex } from "./types.js";

const USAGE = `completeness-checker — reconcile a disclosure against the anchors a source serves

  completeness-checker verify --disclosure <dir> --source <local|gateway|chain> [options]

  common
    --disclosure <dir>     disclosure bundle produced by 'anchor-writer disclose'
    --json <file>          also write the verdict as JSON
    --evidence <dir>       save raw responses / scan inputs for a third party

  --source local
    --endpoint <url>       graph-node query endpoint (default http://localhost:8000/subgraphs/name/anchor-data-edge)
    --block <n>            pin the query to a block (strongly recommended: unpinned runs are not reproducible)

  --source chain
    --rpc <url>            any archive RPC; no Graph component is in the trust path
    --contract <0x..>      anchor contract (defaults to the disclosure manifest)
    --from-block <n>       defaults to the disclosure manifest's startBlock
    --to-block <n>         defaults to chain head

  --source gateway         NOT EXERCISED IN THIS BUILD (see below)
    --url <url>            gateway query URL for the deployment
    --api-key <key>        gateway API key (never written to disk by this tool)
    --block <n>            pin the query to a block

  cross-check
    --cross-check-chain    additionally rebuild the set from raw blocks and require
                           entity-for-entity agreement with the served index
                           (needs --rpc; implied when --source chain)

exit codes: 0 ok · 1 usage/runtime · 2 ALTERED · 3 MISSING · 4 GAP ·
            5 CHAIN-BREAK · 6 CONFLICT · 7 ENVELOPE-MISMATCH · 8 COUNT-MISMATCH
with several findings the process exits with the lowest code; all are printed.

Completeness is with respect to on-chain emissions only. A pass means the
disclosed records are exactly what was anchored — never that the anchored set
reflects off-chain reality. This is not a proof of reserves.

Read privacy: running this against a remote source tells that operator which
stream you are auditing, at which blocks, and when. No mode here mitigates
that; item 06 designs the fix.`;

interface Options {
  disclosureDir: string;
  source: "local" | "gateway" | "chain";
  jsonOut: string | undefined;
  evidenceDir: string | undefined;
  crossCheckChain: boolean;
}

function parseBlock(value: string | undefined): bigint | null {
  return value === undefined ? null : BigInt(value);
}

async function loadIndex(
  args: ReturnType<typeof parseArgs>,
  options: Options,
  streamId: Uint8Array,
  manifest: { contract: Hex | null; startBlock: string | null },
): Promise<{ index: ServedIndex; responses: string[] }> {
  if (options.source === "local") {
    const endpoint = optionalFlag(args, "endpoint") ?? "http://localhost:8000/subgraphs/name/anchor-data-edge";
    const block = parseBlock(optionalFlag(args, "block"));
    const result = await fetchServedIndex({
      endpoint,
      streamId,
      block,
      source: "local",
      description: `local graph-node ${endpoint}${block === null ? " (unpinned)" : ` at block ${block}`}`,
    });
    return { index: result.index, responses: result.responses };
  }

  if (options.source === "gateway") {
    const url = requireFlag(args, "url");
    const apiKey = optionalFlag(args, "api-key") ?? process.env.GRAPH_API_KEY;
    if (!apiKey) throw new UsageError("gateway mode needs --api-key or GRAPH_API_KEY");
    process.stderr.write(`completeness-checker: WARNING — ${GATEWAY_UNEXERCISED_NOTICE}\n`);
    const result = await fetchFromGateway({ url, apiKey, streamId, block: parseBlock(optionalFlag(args, "block")) });
    return { index: result.index, responses: result.responses };
  }

  const rpcUrl = requireFlag(args, "rpc");
  const contract = (optionalFlag(args, "contract") ?? manifest.contract) as Hex | null;
  if (!contract) throw new UsageError("chain mode needs --contract (the disclosure manifest has none)");
  const fromBlock = optionalFlag(args, "from-block") ?? manifest.startBlock ?? "0";
  const index = await scanChain({
    rpcUrl,
    contract,
    streamId,
    fromBlock: BigInt(fromBlock),
    toBlock: parseBlock(optionalFlag(args, "to-block")),
  });
  return { index, responses: [] };
}

function printVerdict(verdict: Verdict, index: ServedIndex): void {
  const out = process.stdout;
  out.write(`source     : ${index.description}\n`);
  out.write(`stream     : ${toHex(index.streamId)}\n`);
  out.write(
    `counts     : ${verdict.summary.disclosedCount} disclosed record(s), ${verdict.summary.servedCount} served anchor(s)\n`,
  );
  out.write(
    `chain      : ${verdict.summary.checkedLinks} link(s) checked, ${verdict.summary.unresolvableLinks} unresolvable\n`,
  );
  if (index.pinnedBlock !== null) out.write(`pinned     : block ${index.pinnedBlock}\n`);
  else out.write("pinned     : NOT PINNED — this run is not reproducible; pass --block\n");
  if (index.source === "gateway") {
    out.write(`attestation: ${index.attestation ? "captured (not verified here — item 01 owns verification)" : "ABSENT"}\n`);
  }

  for (const note of verdict.notes) {
    out.write(`NOTE  ${note.code}${note.seq === null ? "" : ` seq=${note.seq}`}: ${note.detail}\n`);
  }
  for (const finding of verdict.findings) {
    out.write(`FAIL  ${formatFinding(finding)}\n`);
  }

  if (verdict.ok) {
    out.write(
      "\nPASS — every disclosed record matches an anchor the chain carries, the sequence is contiguous, and the hash chain holds.\n",
    );
    out.write(
      "       Scope: completeness with respect to on-chain emissions. Says nothing about off-chain reality.\n",
    );
  } else {
    out.write(`\nFAIL — ${verdict.findings.length} finding(s); exiting ${verdict.exitCode}\n`);
  }
}

async function cmdVerify(args: ReturnType<typeof parseArgs>): Promise<number> {
  const options: Options = {
    disclosureDir: requireFlag(args, "disclosure"),
    source: requireFlag(args, "source") as Options["source"],
    jsonOut: optionalFlag(args, "json"),
    evidenceDir: optionalFlag(args, "evidence"),
    crossCheckChain: boolFlag(args, "cross-check-chain"),
  };
  if (!["local", "gateway", "chain"].includes(options.source)) {
    throw new UsageError(`--source must be local, gateway or chain (got ${options.source})`);
  }

  const disclosure = readDisclosure(options.disclosureDir);
  const { streamId, streamKey } = keyMaterial(disclosure.keyfile);
  const expected = computeAnchors(streamKey, streamId, disclosedRecords(disclosure));

  const { index, responses } = await loadIndex(args, options, streamId, disclosure.manifest);
  const verdict = compareDisclosureToIndex(expected, index);

  let crossCheckDifferences: string[] | null = null;
  if (options.crossCheckChain && options.source !== "chain") {
    const contract = (optionalFlag(args, "contract") ?? disclosure.manifest.contract) as Hex | null;
    if (!contract) throw new UsageError("--cross-check-chain needs a contract address");
    const chainIndex = await scanChain({
      rpcUrl: requireFlag(args, "rpc"),
      contract,
      streamId,
      fromBlock: BigInt(optionalFlag(args, "from-block") ?? disclosure.manifest.startBlock ?? "0"),
      toBlock: parseBlock(optionalFlag(args, "to-block")),
    });
    crossCheckDifferences = compareIndexes(index, chainIndex);
  }

  printVerdict(verdict, index);

  if (crossCheckDifferences !== null) {
    if (crossCheckDifferences.length === 0) {
      process.stdout.write("cross-check: served index agrees entity-for-entity with a raw block scan\n");
    } else {
      process.stdout.write("cross-check: served index DISAGREES with a raw block scan\n");
      for (const difference of crossCheckDifferences) process.stdout.write(`  ${difference}\n`);
    }
  }

  if (options.evidenceDir) {
    mkdirSync(options.evidenceDir, { recursive: true });
    responses.forEach((body, page) => {
      writeFileSync(join(options.evidenceDir as string, `response-${page}.json`), body);
    });
    if (index.attestation) {
      writeFileSync(join(options.evidenceDir, "graph-attestation.txt"), `${index.attestation}\n`);
    }
  }

  if (options.jsonOut) {
    const payload = {
      source: index.source,
      description: index.description,
      streamId: toHex(index.streamId),
      pinnedBlock: index.pinnedBlock === null ? null : index.pinnedBlock.toString(),
      attestationCaptured: index.attestation !== null,
      ok: verdict.ok,
      exitCode: verdict.exitCode,
      findings: verdict.findings.map((finding) => ({
        code: finding.code,
        seq: finding.seq === null ? null : finding.seq.toString(),
        detail: finding.detail,
      })),
      notes: verdict.notes.map((note) => ({
        code: note.code,
        seq: note.seq === null ? null : note.seq.toString(),
        detail: note.detail,
      })),
      summary: verdict.summary,
      crossCheckDifferences,
    };
    writeFileSync(options.jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
  }

  const crossCheckFailed = crossCheckDifferences !== null && crossCheckDifferences.length > 0;
  if (crossCheckFailed && verdict.exitCode === EXIT.OK) return EXIT.GAP;
  return verdict.exitCode;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "verify":
      process.exit(await cmdVerify(args));
      break;
    case "help":
    case undefined:
      process.stdout.write(`${USAGE}\n`);
      break;
    default:
      throw new UsageError(`unknown command ${args.command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`completeness-checker: ${message}\n`);
  if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
  process.exit(EXIT.USAGE);
});
