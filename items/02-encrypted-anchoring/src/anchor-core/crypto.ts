import { gcmsiv } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, u64be, utf8 } from "./bytes.js";
import { ENVELOPE_VERSION, SIZE } from "./envelope.js";

/**
 * Deterministic record encryption (spec §4.3).
 *
 * AES-256-GCM-SIV (RFC 8452) with key and nonce derived from the stream key:
 *
 *   encKey = HKDF-SHA256(ikm = streamKey, salt = "", info = "anchor-enc"   ‖ streamId,        L = 32)
 *   nonce  = HKDF-SHA256(ikm = streamKey, salt = "", info = "anchor-nonce" ‖ streamId ‖ seq,  L = 12)
 *   AAD    = version ‖ streamId ‖ seq                                                        (41 bytes)
 *
 * `salt` is the empty string in the HKDF-Extract sense (RFC 5869 §2.2: an
 * absent salt is equivalent to HashLen zero bytes, which is what a zero-length
 * salt produces here).
 *
 * Why deterministic: the completeness checker's contract is that *plaintext +
 * keys alone* reproduce the expected anchor sequence. A randomised AEAD would
 * force the verifier to trust an archived ciphertext. GCM-SIV is the standard
 * construction designed to survive deterministic use — nonce misuse leaks only
 * plaintext equality, and per-seq nonce derivation makes even that unreachable
 * (distinct seq → distinct nonce → unrelated ciphertexts for equal plaintexts).
 *
 * The AAD binds every ciphertext to its stream position: a ciphertext moved to
 * another seq (or another stream) fails tag verification on decrypt.
 *
 * Keys never leave this process. Nothing in this file writes key material
 * anywhere; the writer's keystore is the only thing that persists a key, and it
 * is demo-grade by construction (spec §10).
 */

export const HKDF_INFO_ENC = utf8("anchor-enc");
export const HKDF_INFO_NONCE = utf8("anchor-nonce");
export const HKDF_SALT = new Uint8Array(0);

export const STREAM_KEY_LENGTH = 32;
export const ENC_KEY_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const AAD_LENGTH = SIZE.version + SIZE.streamId + SIZE.seq;
/** AES-GCM-SIV authentication tag, appended to the ciphertext by @noble/ciphers. */
export const TAG_LENGTH = 16;

function requireStreamKey(streamKey: Uint8Array): void {
  if (streamKey.length !== STREAM_KEY_LENGTH) {
    throw new Error(`streamKey must be ${STREAM_KEY_LENGTH} bytes, got ${streamKey.length}`);
  }
}

function requireStreamId(streamId: Uint8Array): void {
  if (streamId.length !== SIZE.streamId) {
    throw new Error(`streamId must be ${SIZE.streamId} bytes, got ${streamId.length}`);
  }
}

export function deriveEncKey(streamKey: Uint8Array, streamId: Uint8Array): Uint8Array {
  requireStreamKey(streamKey);
  requireStreamId(streamId);
  return hkdf(sha256, streamKey, HKDF_SALT, concat(HKDF_INFO_ENC, streamId), ENC_KEY_LENGTH);
}

export function deriveNonce(streamKey: Uint8Array, streamId: Uint8Array, seq: bigint): Uint8Array {
  requireStreamKey(streamKey);
  requireStreamId(streamId);
  return hkdf(sha256, streamKey, HKDF_SALT, concat(HKDF_INFO_NONCE, streamId, u64be(seq)), NONCE_LENGTH);
}

/** version ‖ streamId ‖ seq — position binding for the AEAD. */
export function buildAad(streamId: Uint8Array, seq: bigint): Uint8Array {
  requireStreamId(streamId);
  return concat(Uint8Array.of(ENVELOPE_VERSION), streamId, u64be(seq));
}

export function encryptRecord(
  streamKey: Uint8Array,
  streamId: Uint8Array,
  seq: bigint,
  plaintext: Uint8Array,
): Uint8Array {
  const key = deriveEncKey(streamKey, streamId);
  const nonce = deriveNonce(streamKey, streamId, seq);
  const aad = buildAad(streamId, seq);
  return gcmsiv(key, nonce, aad).encrypt(plaintext);
}

export function decryptRecord(
  streamKey: Uint8Array,
  streamId: Uint8Array,
  seq: bigint,
  ciphertext: Uint8Array,
): Uint8Array {
  const key = deriveEncKey(streamKey, streamId);
  const nonce = deriveNonce(streamKey, streamId, seq);
  const aad = buildAad(streamId, seq);
  return gcmsiv(key, nonce, aad).decrypt(ciphertext);
}
