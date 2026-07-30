import { concat, keccak256, readU64be, toHex, u64be, type Hex } from "./bytes.js";

/**
 * The 105-byte anchor envelope (spec §4.2).
 *
 *   offset  size  field
 *   0       1     version (0x01)
 *   1       32    streamId
 *   33      8     seq (uint64 big-endian)
 *   41      32    ciphertextDigest = keccak256(ciphertext)
 *   73      32    prevEnvelopeDigest = keccak256(previous envelope), zero at seq 0
 *
 * Digests are of ciphertext, never plaintext: nothing about record content is
 * derivable from an envelope.
 */
export const ENVELOPE_VERSION = 0x01;
export const ENVELOPE_LENGTH = 105;

export const OFFSET = {
  version: 0,
  streamId: 1,
  seq: 33,
  ciphertextDigest: 41,
  prevEnvelopeDigest: 73,
} as const;

export const SIZE = {
  version: 1,
  streamId: 32,
  seq: 8,
  ciphertextDigest: 32,
  prevEnvelopeDigest: 32,
} as const;

export interface EnvelopeFields {
  version: number;
  streamId: Uint8Array;
  seq: bigint;
  ciphertextDigest: Uint8Array;
  prevEnvelopeDigest: Uint8Array;
}

/** Decode failure reasons. The subgraph mapping uses the same two strings. */
export type MalformedReason = "WRONG_LENGTH" | "UNSUPPORTED_VERSION";

export class EnvelopeDecodeError extends Error {
  constructor(
    readonly reason: MalformedReason,
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeDecodeError";
  }
}

function requireLength(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new Error(`${name} must be ${length} bytes, got ${value.length}`);
  }
}

export function encodeEnvelope(fields: EnvelopeFields): Uint8Array {
  if (fields.version < 0 || fields.version > 255) throw new Error(`version out of range: ${fields.version}`);
  requireLength("streamId", fields.streamId, SIZE.streamId);
  requireLength("ciphertextDigest", fields.ciphertextDigest, SIZE.ciphertextDigest);
  requireLength("prevEnvelopeDigest", fields.prevEnvelopeDigest, SIZE.prevEnvelopeDigest);
  const envelope = concat(
    Uint8Array.of(fields.version),
    fields.streamId,
    u64be(fields.seq),
    fields.ciphertextDigest,
    fields.prevEnvelopeDigest,
  );
  if (envelope.length !== ENVELOPE_LENGTH) throw new Error(`encoded envelope is ${envelope.length} bytes`);
  return envelope;
}

export function decodeEnvelope(payload: Uint8Array): EnvelopeFields {
  if (payload.length !== ENVELOPE_LENGTH) {
    throw new EnvelopeDecodeError("WRONG_LENGTH", `envelope must be ${ENVELOPE_LENGTH} bytes, got ${payload.length}`);
  }
  const version = payload[OFFSET.version] as number;
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeDecodeError("UNSUPPORTED_VERSION", `unsupported envelope version 0x${version.toString(16)}`);
  }
  return {
    version,
    streamId: payload.slice(OFFSET.streamId, OFFSET.streamId + SIZE.streamId),
    seq: readU64be(payload, OFFSET.seq),
    ciphertextDigest: payload.slice(OFFSET.ciphertextDigest, OFFSET.ciphertextDigest + SIZE.ciphertextDigest),
    prevEnvelopeDigest: payload.slice(
      OFFSET.prevEnvelopeDigest,
      OFFSET.prevEnvelopeDigest + SIZE.prevEnvelopeDigest,
    ),
  };
}

export function envelopeDigest(envelope: Uint8Array): Uint8Array {
  return keccak256(envelope);
}

export function describeEnvelope(envelope: Uint8Array): Record<string, string> {
  const f = decodeEnvelope(envelope);
  return {
    version: `0x${f.version.toString(16).padStart(2, "0")}`,
    streamId: toHex(f.streamId),
    seq: f.seq.toString(),
    ciphertextDigest: toHex(f.ciphertextDigest),
    prevEnvelopeDigest: toHex(f.prevEnvelopeDigest),
    envelopeDigest: toHex(envelopeDigest(envelope)) as Hex,
  };
}
