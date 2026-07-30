import { describe, expect, it } from "vitest";
import { fromHex, toHex, ZERO32 } from "../../src/anchor-core/bytes.js";
import {
  ENVELOPE_LENGTH,
  ENVELOPE_VERSION,
  EnvelopeDecodeError,
  OFFSET,
  decodeEnvelope,
  describeEnvelope,
  encodeEnvelope,
  envelopeDigest,
} from "../../src/anchor-core/envelope.js";
import { keccak256 } from "../../src/anchor-core/bytes.js";

const STREAM_ID = fromHex("0x5be7cd098a9193fd81ad24e4bf014498cfc8e1fcfb796660cb9ee01eab8c373d");
const CIPHERTEXT_DIGEST = fromHex("0x6a7d5519f40837ccf235af0f6df03bca37d93957e1695f7ef5376c003aad5122");
const PREV_DIGEST = fromHex("0xc4451b117afd7e0594b7cda6a942103538a0effa68a67874f1991654de5d8eaa");

function sample(seq = 7n) {
  return encodeEnvelope({
    version: ENVELOPE_VERSION,
    streamId: STREAM_ID,
    seq,
    ciphertextDigest: CIPHERTEXT_DIGEST,
    prevEnvelopeDigest: PREV_DIGEST,
  });
}

describe("envelope", () => {
  it("is exactly 105 bytes with the spec's field offsets", () => {
    const envelope = sample();
    expect(envelope.length).toBe(ENVELOPE_LENGTH);
    expect(envelope.length).toBe(105);
    expect(envelope[OFFSET.version]).toBe(1);
    expect(toHex(envelope.slice(OFFSET.streamId, OFFSET.streamId + 32))).toBe(toHex(STREAM_ID));
    expect(toHex(envelope.slice(OFFSET.seq, OFFSET.seq + 8))).toBe("0x0000000000000007");
    expect(toHex(envelope.slice(OFFSET.ciphertextDigest, OFFSET.ciphertextDigest + 32))).toBe(toHex(CIPHERTEXT_DIGEST));
    expect(toHex(envelope.slice(OFFSET.prevEnvelopeDigest, OFFSET.prevEnvelopeDigest + 32))).toBe(toHex(PREV_DIGEST));
  });

  it("round-trips encode → decode", () => {
    const fields = decodeEnvelope(sample(42n));
    expect(fields.version).toBe(1);
    expect(fields.seq).toBe(42n);
    expect(toHex(fields.streamId)).toBe(toHex(STREAM_ID));
    expect(toHex(fields.ciphertextDigest)).toBe(toHex(CIPHERTEXT_DIGEST));
    expect(toHex(fields.prevEnvelopeDigest)).toBe(toHex(PREV_DIGEST));
  });

  it("encodes seq as uint64 big-endian across the byte boundaries", () => {
    for (const seq of [0n, 1n, 255n, 256n, 65535n, 4294967296n, 2n ** 63n]) {
      expect(decodeEnvelope(sample(seq)).seq).toBe(seq);
    }
  });

  it("rejects a seq that does not fit in uint64", () => {
    expect(() => sample(2n ** 64n)).toThrow(/out of uint64 range/);
  });

  it("rejects a payload of the wrong length with reason WRONG_LENGTH", () => {
    const short = sample().slice(0, 104);
    expect(() => decodeEnvelope(short)).toThrow(EnvelopeDecodeError);
    try {
      decodeEnvelope(short);
    } catch (error) {
      expect((error as EnvelopeDecodeError).reason).toBe("WRONG_LENGTH");
    }
  });

  it("rejects an unknown version with reason UNSUPPORTED_VERSION", () => {
    const wrongVersion = sample();
    wrongVersion[0] = 2;
    try {
      decodeEnvelope(wrongVersion);
      throw new Error("expected a decode failure");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeDecodeError);
      expect((error as EnvelopeDecodeError).reason).toBe("UNSUPPORTED_VERSION");
    }
  });

  it("rejects malformed field widths at encode time", () => {
    expect(() =>
      encodeEnvelope({
        version: 1,
        streamId: new Uint8Array(31),
        seq: 0n,
        ciphertextDigest: CIPHERTEXT_DIGEST,
        prevEnvelopeDigest: ZERO32,
      }),
    ).toThrow(/streamId must be 32 bytes/);
    expect(() =>
      encodeEnvelope({
        version: 1,
        streamId: STREAM_ID,
        seq: 0n,
        ciphertextDigest: new Uint8Array(16),
        prevEnvelopeDigest: ZERO32,
      }),
    ).toThrow(/ciphertextDigest must be 32 bytes/);
  });

  it("digests the whole envelope with keccak256", () => {
    const envelope = sample();
    expect(toHex(envelopeDigest(envelope))).toBe(toHex(keccak256(envelope)));
  });

  it("describes an envelope field by field", () => {
    const described = describeEnvelope(sample(3n));
    expect(described["seq"]).toBe("3");
    expect(described["version"]).toBe("0x01");
    expect(described["streamId"]).toBe(toHex(STREAM_ID));
  });
});
