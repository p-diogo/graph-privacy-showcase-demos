import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { equalBytes, fromHex, keccak256, toHex, ZERO32 } from "../../src/anchor-core/bytes.js";
import { buildAad, decryptRecord, deriveEncKey, deriveNonce } from "../../src/anchor-core/crypto.js";
import { decodeEnvelope, envelopeDigest } from "../../src/anchor-core/envelope.js";
import { keyMaterial, parseKeyfile } from "../../src/anchor-core/keystore.js";
import { parseRecordsJsonl } from "../../src/anchor-core/records.js";
import { computeAnchors } from "../../src/anchor-core/stream.js";

/**
 * The determinism contract of spec §5.1: the committed fixtures must reproduce
 * the committed golden vectors byte for byte, forever. If this suite fails, the
 * encryption scheme changed and every anchor ever posted with the old scheme is
 * no longer reproducible from its plaintext.
 */
interface GoldenAnchor {
  seq: string;
  recordText: string;
  nonce: string;
  aad: string;
  ciphertext: string;
  ciphertextDigest: string;
  prevEnvelopeDigest: string;
  envelope: string;
  envelopeDigest: string;
}

const golden = JSON.parse(readFileSync("fixtures/golden/anchors.json", "utf8")) as {
  streamId: string;
  encKey: string;
  envelopeLength: number;
  anchors: GoldenAnchor[];
};
const keyfile = parseKeyfile(readFileSync("fixtures/demo-keyfile.json", "utf8"));
const { streamId, streamKey } = keyMaterial(keyfile);
const records = parseRecordsJsonl(readFileSync("fixtures/records.jsonl", "utf8"));

const computed = computeAnchors(
  streamKey,
  streamId,
  records.map((record, index) => ({ seq: BigInt(index), plaintext: record.plaintext })),
);

describe("golden vectors", () => {
  it("covers the whole fixture stream", () => {
    expect(golden.anchors.length).toBe(records.length);
    expect(golden.anchors.length).toBe(10);
    expect(golden.streamId).toBe(keyfile.streamId);
  });

  it("re-derives the published demo key material from its documented preimages", () => {
    expect(toHex(streamId)).toBe(toHex(keccak256(new TextEncoder().encode("graph-privacy-showcase/item-02/demo-stream-id"))));
    expect(toHex(streamKey)).toBe(
      toHex(keccak256(new TextEncoder().encode("graph-privacy-showcase/item-02/demo-stream-key-THROWAWAY"))),
    );
  });

  it("reproduces every ciphertext, digest and envelope byte for byte", () => {
    expect(toHex(deriveEncKey(streamKey, streamId))).toBe(golden.encKey);
    computed.forEach((anchor, index) => {
      const expected = golden.anchors[index] as GoldenAnchor;
      expect(anchor.seq.toString()).toBe(expected.seq);
      expect((records[index] as (typeof records)[number]).text).toBe(expected.recordText);
      expect(toHex(deriveNonce(streamKey, streamId, anchor.seq))).toBe(expected.nonce);
      expect(toHex(buildAad(streamId, anchor.seq))).toBe(expected.aad);
      expect(toHex(anchor.ciphertext)).toBe(expected.ciphertext);
      expect(toHex(anchor.ciphertextDigest)).toBe(expected.ciphertextDigest);
      expect(toHex(anchor.prevEnvelopeDigest as Uint8Array)).toBe(expected.prevEnvelopeDigest);
      expect(toHex(anchor.envelope as Uint8Array)).toBe(expected.envelope);
      expect(toHex(anchor.envelopeDigest as Uint8Array)).toBe(expected.envelopeDigest);
    });
  });

  it("keeps every envelope 105 bytes", () => {
    for (const anchor of golden.anchors) {
      expect(fromHex(anchor.envelope).length).toBe(105);
    }
    expect(golden.envelopeLength).toBe(105);
  });

  it("digests ciphertext, so no envelope field is a function of the plaintext", () => {
    for (const anchor of golden.anchors) {
      expect(toHex(keccak256(fromHex(anchor.ciphertext)))).toBe(anchor.ciphertextDigest);
    }
  });

  it("hash-chains the stream: seq 0 points at zero, seq k at the digest of k-1", () => {
    expect(golden.anchors[0]!.prevEnvelopeDigest).toBe(toHex(ZERO32));
    for (let index = 1; index < golden.anchors.length; index++) {
      expect(golden.anchors[index]!.prevEnvelopeDigest).toBe(golden.anchors[index - 1]!.envelopeDigest);
    }
  });

  it("has an envelope digest that is keccak256 of the envelope it claims", () => {
    for (const anchor of golden.anchors) {
      expect(toHex(envelopeDigest(fromHex(anchor.envelope)))).toBe(anchor.envelopeDigest);
    }
  });

  it("decodes each envelope back to the fields the vector claims", () => {
    for (const anchor of golden.anchors) {
      const fields = decodeEnvelope(fromHex(anchor.envelope));
      expect(fields.seq.toString()).toBe(anchor.seq);
      expect(equalBytes(fields.streamId, streamId)).toBe(true);
      expect(toHex(fields.ciphertextDigest)).toBe(anchor.ciphertextDigest);
      expect(toHex(fields.prevEnvelopeDigest)).toBe(anchor.prevEnvelopeDigest);
    }
  });

  it("decrypts back to the exact record line the fixture file contains", () => {
    golden.anchors.forEach((anchor, index) => {
      const plaintext = decryptRecord(streamKey, streamId, BigInt(anchor.seq), fromHex(anchor.ciphertext));
      expect(new TextDecoder().decode(plaintext)).toBe((records[index] as (typeof records)[number]).text);
    });
  });
});
