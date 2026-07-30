#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import {
  computeAnchors,
  deriveEncKey,
  deriveNonce,
  buildAad,
  keyMaterial,
  parseKeyfile,
  parseRecordsJsonl,
  toHex,
} from "../anchor-core/index.js";

/**
 * Regenerate `fixtures/golden/anchors.json`.
 *
 * The golden file is the determinism contract: fixed key + fixed records must
 * always produce these exact bytes. Regenerating it is a deliberate act — if
 * the file changes without the envelope format changing, something is wrong.
 *
 * Derived key material is included on purpose. The demo key is published, so
 * nothing is leaked, and publishing the derivation lets a third party check an
 * independent AES-256-GCM-SIV implementation against these vectors without
 * reimplementing HKDF first.
 */
const keyfilePath = process.argv[2] ?? "fixtures/demo-keyfile.json";
const recordsPath = process.argv[3] ?? "fixtures/records.jsonl";
const outPath = process.argv[4] ?? "fixtures/golden/anchors.json";

const keyfile = parseKeyfile(readFileSync(keyfilePath, "utf8"));
const { streamId, streamKey } = keyMaterial(keyfile);
const records = parseRecordsJsonl(readFileSync(recordsPath, "utf8"));

const anchors = computeAnchors(
  streamKey,
  streamId,
  records.map((record, index) => ({ seq: BigInt(index), plaintext: record.plaintext })),
);

const golden = {
  format: "item02-golden-vectors",
  version: 1,
  note:
    "Deterministic AES-256-GCM-SIV (RFC 8452) with HKDF-SHA256 derived key and nonce, " +
    "AAD = version||streamId||seq. Same records + same key => these exact bytes, forever.",
  keyfile: keyfilePath,
  records: recordsPath,
  streamId: keyfile.streamId,
  encKey: toHex(deriveEncKey(streamKey, streamId)),
  envelopeLength: 105,
  anchors: anchors.map((anchor, index) => ({
    seq: anchor.seq.toString(),
    recordText: (records[index] as (typeof records)[number]).text,
    nonce: toHex(deriveNonce(streamKey, streamId, anchor.seq)),
    aad: toHex(buildAad(streamId, anchor.seq)),
    ciphertext: toHex(anchor.ciphertext),
    ciphertextDigest: toHex(anchor.ciphertextDigest),
    prevEnvelopeDigest: toHex(anchor.prevEnvelopeDigest as Uint8Array),
    envelope: toHex(anchor.envelope as Uint8Array),
    envelopeDigest: toHex(anchor.envelopeDigest as Uint8Array),
  })),
};

writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
process.stdout.write(`wrote ${outPath} (${golden.anchors.length} anchors)\n`);
