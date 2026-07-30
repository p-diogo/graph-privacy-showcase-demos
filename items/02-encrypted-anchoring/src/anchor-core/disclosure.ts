import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex } from "./bytes.js";
import { parseKeyfile, type Keyfile } from "./keystore.js";
import { parseRecordsJsonl, serializeRecordsJsonl, type RecordLine } from "./records.js";

/**
 * The disclosure bundle is what a data owner hands an auditor: the plaintext
 * records, the key material needed to re-derive their ciphertexts, and the
 * seq each record claims. Nothing else — the auditor reconstructs the expected
 * anchors and checks them against what independent indexers serve.
 *
 * `seqs` is aligned index-for-index with the lines of `records.jsonl`. Carrying
 * seq explicitly (rather than implying it from line position) is what lets a
 * suppressed record read as `MISSING seq=k` instead of silently renumbering
 * every record after it.
 */
export const DISCLOSURE_FORMAT = "item02-disclosure";

export const DISCLOSURE_NOTE =
  "Completeness is with respect to on-chain emissions only: this bundle lets a " +
  "verifier prove the disclosed records match what was anchored, never that the " +
  "anchored set reflects off-chain reality. Not a proof of reserves.";

export interface DisclosureManifest {
  format: typeof DISCLOSURE_FORMAT;
  version: 1;
  streamId: Hex;
  contract: Hex | null;
  chainId: number | null;
  startBlock: string | null;
  endBlock: string | null;
  anchorCount: number;
  seqs: string[];
  note: string;
}

export interface Disclosure {
  manifest: DisclosureManifest;
  keyfile: Keyfile;
  records: RecordLine[];
}

export const DISCLOSURE_FILES = {
  manifest: "manifest.json",
  keyfile: "keyfile.json",
  records: "records.jsonl",
} as const;

export function parseDisclosureManifest(json: string): DisclosureManifest {
  const parsed = JSON.parse(json) as Partial<DisclosureManifest>;
  if (parsed.format !== DISCLOSURE_FORMAT) {
    throw new Error(`not an ${DISCLOSURE_FORMAT}: format=${String(parsed.format)}`);
  }
  if (parsed.version !== 1) throw new Error(`unsupported disclosure version ${String(parsed.version)}`);
  if (!Array.isArray(parsed.seqs)) throw new Error("disclosure manifest has no seqs array");
  if (typeof parsed.streamId !== "string") throw new Error("disclosure manifest has no streamId");
  return parsed as DisclosureManifest;
}

export function readDisclosure(dir: string): Disclosure {
  const manifest = parseDisclosureManifest(readFileSync(join(dir, DISCLOSURE_FILES.manifest), "utf8"));
  const keyfile = parseKeyfile(readFileSync(join(dir, DISCLOSURE_FILES.keyfile), "utf8"));
  const records = parseRecordsJsonl(readFileSync(join(dir, DISCLOSURE_FILES.records), "utf8"));

  if (keyfile.streamId.toLowerCase() !== manifest.streamId.toLowerCase()) {
    throw new Error(
      `disclosure is inconsistent: manifest streamId ${manifest.streamId} != keyfile streamId ${keyfile.streamId}`,
    );
  }
  if (manifest.seqs.length !== records.length) {
    throw new Error(
      `disclosure is inconsistent: ${manifest.seqs.length} seqs but ${records.length} records — ` +
        "a tamper must remove a record and its seq together",
    );
  }
  return { manifest, keyfile, records };
}

export function writeDisclosure(dir: string, disclosure: Disclosure): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DISCLOSURE_FILES.manifest), `${JSON.stringify(disclosure.manifest, null, 2)}\n`);
  writeFileSync(join(dir, DISCLOSURE_FILES.keyfile), `${JSON.stringify(disclosure.keyfile, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(dir, DISCLOSURE_FILES.records), serializeRecordsJsonl(disclosure.records));
}

/** Pair each disclosed record line with the seq the manifest claims for it. */
export function disclosedRecords(disclosure: Disclosure): { seq: bigint; plaintext: Uint8Array; text: string }[] {
  return disclosure.records.map((record, index) => ({
    seq: BigInt(disclosure.manifest.seqs[index] as string),
    plaintext: record.plaintext,
    text: record.text,
  }));
}
