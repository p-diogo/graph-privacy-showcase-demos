import { keccak256, ZERO32 } from "./bytes.js";
import { encryptRecord } from "./crypto.js";
import { encodeEnvelope, envelopeDigest } from "./envelope.js";

export interface RecordInput {
  seq: bigint;
  plaintext: Uint8Array;
}

export interface ComputedAnchor {
  seq: bigint;
  plaintext: Uint8Array;
  ciphertext: Uint8Array;
  ciphertextDigest: Uint8Array;
  /**
   * `null` when the predecessor (seq - 1) is not part of the input set — a
   * disclosure that omits a record cannot resolve the links that depend on it.
   * The checker reports such links as unresolvable rather than as failures:
   * an absent link is missing evidence, not evidence of tampering.
   */
  prevEnvelopeDigest: Uint8Array | null;
  envelope: Uint8Array | null;
  envelopeDigest: Uint8Array | null;
}

/**
 * Recompute the anchor sequence a set of records must produce (spec §4.5 step 1).
 * Given the same records and key this is byte-for-byte reproducible; that is
 * the property the golden-vector tests assert.
 */
export function computeAnchors(
  streamKey: Uint8Array,
  streamId: Uint8Array,
  records: readonly RecordInput[],
): ComputedAnchor[] {
  const sorted = [...records].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.seq === sorted[i - 1]!.seq) throw new Error(`duplicate seq ${sorted[i]!.seq} in record set`);
  }

  const digestBySeq = new Map<bigint, Uint8Array>();
  const out: ComputedAnchor[] = [];

  for (const record of sorted) {
    const ciphertext = encryptRecord(streamKey, streamId, record.seq, record.plaintext);
    const ciphertextDigest = keccak256(ciphertext);

    let prevEnvelopeDigest: Uint8Array | null;
    if (record.seq === 0n) {
      prevEnvelopeDigest = ZERO32;
    } else {
      prevEnvelopeDigest = digestBySeq.get(record.seq - 1n) ?? null;
    }

    let envelope: Uint8Array | null = null;
    let digest: Uint8Array | null = null;
    if (prevEnvelopeDigest !== null) {
      envelope = encodeEnvelope({
        version: 1,
        streamId,
        seq: record.seq,
        ciphertextDigest,
        prevEnvelopeDigest,
      });
      digest = envelopeDigest(envelope);
      digestBySeq.set(record.seq, digest);
    }

    out.push({
      seq: record.seq,
      plaintext: record.plaintext,
      ciphertext,
      ciphertextDigest,
      prevEnvelopeDigest,
      envelope,
      envelopeDigest: digest,
    });
  }

  return out;
}
