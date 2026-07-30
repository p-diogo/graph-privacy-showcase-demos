#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ARCHIVE_FORMAT,
  DISCLOSURE_FORMAT,
  DISCLOSURE_NOTE,
  UsageError,
  boolFlag,
  computeAnchors,
  generateKeyfile,
  keyMaterial,
  optionalFlag,
  parseArchive,
  parseArgs,
  parseRecordsJsonl,
  readKeyfile,
  requireFlag,
  toHex,
  writeDisclosure,
  writeKeyfile,
  type Archive,
  type ArchiveAnchor,
  type Hex,
} from "../anchor-core/index.js";
import { connectWriterChain } from "./chain.js";

const USAGE = `anchor-writer — encrypt records and anchor their ciphertext digests (item 02)

  anchor-writer init --keystore <file>
      Generate a fresh streamId + streamKey. DEMO-GRADE: the key is written in
      cleartext and never leaves this machine.

  anchor-writer post --records <file.jsonl> --keystore <file> --contract <0x..>
                     [--rpc <url>] [--private-key <0x..>|$ANCHOR_WRITER_PRIVATE_KEY]
                     [--archive <file.json>] [--dry-run] [--force]
      Encrypt each record, build the 105-byte envelopes, and submit one
      postAnchor tx per anchor in seq order. --dry-run computes and archives
      everything without touching a chain.

  anchor-writer disclose --archive <file.json> --records <file.jsonl>
                         --keystore <file> --out <dir>
      Bundle plaintext records + key material + seq map for an auditor.

Honesty: anchoring publishes the fact that records exist and when. Digests are
of ciphertext, so content stays private, but existence, count and cadence are
public forever. Anchors prove nothing about off-chain reality.`;

function fail(message: string): never {
  process.stderr.write(`anchor-writer: ${message}\n`);
  process.exit(1);
}

function loadRecords(path: string) {
  return parseRecordsJsonl(readFileSync(path, "utf8"));
}

function cmdInit(args: ReturnType<typeof parseArgs>): void {
  const keystorePath = requireFlag(args, "keystore");
  if (existsSync(keystorePath) && !boolFlag(args, "force")) {
    fail(`keystore ${keystorePath} already exists (use --force to overwrite)`);
  }
  const keyfile = generateKeyfile();
  mkdirSync(dirname(keystorePath), { recursive: true });
  writeKeyfile(keystorePath, keyfile);
  process.stdout.write(`wrote ${keystorePath}\n`);
  process.stdout.write(`streamId ${keyfile.streamId}\n`);
  process.stdout.write("streamKey withheld from stdout; it lives only in the keystore file\n");
}

async function cmdPost(args: ReturnType<typeof parseArgs>): Promise<void> {
  const recordsPath = requireFlag(args, "records");
  const keystorePath = requireFlag(args, "keystore");
  const contract = requireFlag(args, "contract") as Hex;
  const archivePath = optionalFlag(args, "archive") ?? "anchor-archive.json";
  const dryRun = boolFlag(args, "dry-run");

  if (existsSync(archivePath) && !boolFlag(args, "force")) {
    fail(`archive ${archivePath} already exists (use --force to overwrite)`);
  }

  const keyfile = readKeyfile(keystorePath);
  const { streamId, streamKey } = keyMaterial(keyfile);
  const records = loadRecords(recordsPath);
  const anchors = computeAnchors(
    streamKey,
    streamId,
    records.map((record, index) => ({ seq: BigInt(index), plaintext: record.plaintext })),
  );

  const archiveAnchors: ArchiveAnchor[] = anchors.map((anchor) => ({
    seq: anchor.seq.toString(),
    ciphertext: toHex(anchor.ciphertext),
    ciphertextDigest: toHex(anchor.ciphertextDigest),
    prevEnvelopeDigest: toHex(anchor.prevEnvelopeDigest as Uint8Array),
    envelope: toHex(anchor.envelope as Uint8Array),
    envelopeDigest: toHex(anchor.envelopeDigest as Uint8Array),
    txHash: null,
    blockNumber: null,
  }));

  const archive: Archive = {
    format: ARCHIVE_FORMAT,
    version: 1,
    streamId: keyfile.streamId,
    contract,
    chainId: null,
    startBlock: null,
    endBlock: null,
    submitted: false,
    anchors: archiveAnchors,
  };

  if (dryRun) {
    writeArchive(archivePath, archive);
    process.stdout.write(`dry run: computed ${anchors.length} anchors, submitted none\n`);
    process.stdout.write(`wrote ${archivePath}\n`);
    return;
  }

  const rpcUrl = requireFlag(args, "rpc");
  const privateKey = optionalFlag(args, "private-key") ?? process.env.ANCHOR_WRITER_PRIVATE_KEY;
  if (!privateKey) throw new UsageError("no --private-key and no ANCHOR_WRITER_PRIVATE_KEY in the environment");

  const chain = await connectWriterChain(rpcUrl, privateKey);
  archive.chainId = chain.chainId;
  process.stdout.write(`posting ${anchors.length} anchors to ${contract} (chainId ${chain.chainId}) from ${chain.sender}\n`);

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i] as (typeof anchors)[number];
    const submission = await chain.submit(contract, anchor.envelope as Uint8Array);
    const entry = archiveAnchors[i] as ArchiveAnchor;
    entry.txHash = submission.txHash as Hex;
    entry.blockNumber = submission.blockNumber.toString();
    if (archive.startBlock === null) archive.startBlock = submission.blockNumber.toString();
    archive.endBlock = submission.blockNumber.toString();
    process.stdout.write(
      `  seq ${anchor.seq} -> ${submission.txHash} (block ${submission.blockNumber}) digest ${toHex(anchor.ciphertextDigest)}\n`,
    );
  }

  archive.submitted = true;
  writeArchive(archivePath, archive);
  process.stdout.write(`wrote ${archivePath}\n`);
}

function writeArchive(path: string, archive: Archive): void {
  mkdirSync(dirname(path) === "" ? "." : dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`);
}

function cmdDisclose(args: ReturnType<typeof parseArgs>): void {
  const archivePath = requireFlag(args, "archive");
  const recordsPath = requireFlag(args, "records");
  const keystorePath = requireFlag(args, "keystore");
  const outDir = requireFlag(args, "out");

  const archive = parseArchive(readFileSync(archivePath, "utf8"));
  const keyfile = readKeyfile(keystorePath);
  const records = loadRecords(recordsPath);

  if (archive.streamId.toLowerCase() !== keyfile.streamId.toLowerCase()) {
    fail(`archive streamId ${archive.streamId} != keystore streamId ${keyfile.streamId}`);
  }
  if (archive.anchors.length !== records.length) {
    fail(`archive has ${archive.anchors.length} anchors but the records file has ${records.length} lines`);
  }

  writeDisclosure(outDir, {
    manifest: {
      format: DISCLOSURE_FORMAT,
      version: 1,
      streamId: keyfile.streamId,
      contract: archive.contract,
      chainId: archive.chainId,
      startBlock: archive.startBlock,
      endBlock: archive.endBlock,
      anchorCount: records.length,
      seqs: archive.anchors.map((anchor) => anchor.seq),
      note: DISCLOSURE_NOTE,
    },
    keyfile,
    records,
  });

  process.stdout.write(`wrote disclosure bundle to ${outDir}\n`);
  process.stdout.write(`  ${join(outDir, "records.jsonl")} (${records.length} records)\n`);
  process.stdout.write(`  ${join(outDir, "keyfile.json")} (DEMO-GRADE key material)\n`);
  process.stdout.write(`  ${join(outDir, "manifest.json")}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "init":
      cmdInit(args);
      return;
    case "post":
      await cmdPost(args);
      return;
    case "disclose":
      cmdDisclose(args);
      return;
    case "help":
    case undefined:
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      throw new UsageError(`unknown command ${args.command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof UsageError)) {
    process.stderr.write(`anchor-writer: ${message}\n`);
    process.exit(1);
  }
  process.stderr.write(`anchor-writer: ${message}\n\n${USAGE}\n`);
  process.exit(1);
});
