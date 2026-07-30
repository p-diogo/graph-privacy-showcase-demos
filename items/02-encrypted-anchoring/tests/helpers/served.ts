import { readFileSync } from "node:fs";
import { keccak256 } from "../../src/anchor-core/bytes.js";
import { encodeEnvelope } from "../../src/anchor-core/envelope.js";
import { keyMaterial, parseKeyfile } from "../../src/anchor-core/keystore.js";
import { parseRecordsJsonl } from "../../src/anchor-core/records.js";
import { computeAnchors, type ComputedAnchor } from "../../src/anchor-core/stream.js";
import type { ServedIndex } from "../../src/completeness-checker/types.js";

/** The fixture stream, recomputed from the committed demo key and records. */
export function fixtureStream(): { streamId: Uint8Array; streamKey: Uint8Array; anchors: ComputedAnchor[] } {
  const keyfile = parseKeyfile(readFileSync("fixtures/demo-keyfile.json", "utf8"));
  const { streamId, streamKey } = keyMaterial(keyfile);
  const records = parseRecordsJsonl(readFileSync("fixtures/records.jsonl", "utf8"));
  const anchors = computeAnchors(
    streamKey,
    streamId,
    records.map((record, index) => ({ seq: BigInt(index), plaintext: record.plaintext })),
  );
  return { streamId, streamKey, anchors };
}

/** An honest served index: exactly what a correct indexer would return. */
export function servedFrom(streamId: Uint8Array, anchors: readonly ComputedAnchor[]): ServedIndex {
  return {
    source: "local",
    description: "test double",
    streamId,
    anchors: anchors.map((anchor) => ({
      seq: anchor.seq,
      ciphertextDigest: anchor.ciphertextDigest,
      prevEnvelopeDigest: anchor.prevEnvelopeDigest as Uint8Array,
      envelopeDigest: anchor.envelopeDigest as Uint8Array,
      duplicateCount: 0n,
      submitter: "0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266",
      txHash: `0x${anchor.seq.toString(16).padStart(64, "0")}`,
      blockNumber: 100n + anchor.seq,
    })),
    conflicts: [],
    malformed: [],
    pinnedBlock: 200n,
    attestation: null,
  };
}

/** Drop anchors from a served index, as an incomplete server would. */
export function withoutSeqs(index: ServedIndex, seqs: bigint[]): ServedIndex {
  return { ...index, anchors: index.anchors.filter((anchor) => !seqs.includes(anchor.seq)) };
}

/**
 * Rewrite one anchor's backward link and keep the row self-consistent — the
 * same thing the local badserver-chain subgraph variant does on chain data.
 */
export function withBrokenChainAt(index: ServedIndex, seq: bigint): ServedIndex {
  return {
    ...index,
    anchors: index.anchors.map((anchor) => {
      if (anchor.seq !== seq) return anchor;
      const prev = Uint8Array.from(anchor.prevEnvelopeDigest);
      prev[0] = (prev[0] as number) ^ 0xff;
      const envelope = encodeEnvelope({
        version: 1,
        streamId: index.streamId,
        seq: anchor.seq,
        ciphertextDigest: anchor.ciphertextDigest,
        prevEnvelopeDigest: prev,
      });
      return { ...anchor, prevEnvelopeDigest: prev, envelopeDigest: keccak256(envelope) };
    }),
  };
}
