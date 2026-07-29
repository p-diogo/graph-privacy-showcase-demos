import { BigInt, Bytes, crypto, log } from "@graphprotocol/graph-ts";
import { PostAnchorCall } from "../generated/AnchorDataEdge/AnchorDataEdge";
import { Anchor, ConflictingAnchor, MalformedAnchor, Stream } from "../generated/schema";

// The 105-byte envelope (spec §4.2). Fixed offsets, decoded with explicit byte
// reads — the EBO decoding.ts style, chosen because it is auditable line by
// line against the table in the spec.
export const ENVELOPE_LENGTH: i32 = 105;
export const ENVELOPE_VERSION: i32 = 1;

const OFFSET_VERSION: i32 = 0;
const OFFSET_STREAM_ID: i32 = 1;
const OFFSET_SEQ: i32 = 33;
const OFFSET_CIPHERTEXT_DIGEST: i32 = 41;
const OFFSET_PREV_ENVELOPE_DIGEST: i32 = 73;

const SIZE_DIGEST: i32 = 32;
const SIZE_STREAM_ID: i32 = 32;
const SIZE_SEQ: i32 = 8;

// Serving modes. MODE_HONEST is the only one ever deployed anywhere; the other
// two are deliberately broken servers that exist so the negative tests have
// something real to catch. They are named in the manifest of a local-only
// deployment and never published.
export const MODE_HONEST: i32 = 0;
export const MODE_DROP_EVERY_FOURTH: i32 = 1;
export const MODE_BREAK_CHAIN_AT_SEQ_FIVE: i32 = 2;

const BREAK_CHAIN_AT_SEQ: i32 = 5;
const DROP_MODULUS: i32 = 4;
const DROP_REMAINDER: i32 = 3;

function sliceBytes(source: Bytes, start: i32, length: i32): Bytes {
  let out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = source[start + i];
  }
  return Bytes.fromUint8Array(out);
}

function readU64BE(source: Bytes, start: i32): BigInt {
  let value = BigInt.zero();
  let base = BigInt.fromI32(256);
  for (let i = 0; i < SIZE_SEQ; i++) {
    value = value.times(base).plus(BigInt.fromI32(<i32>source[start + i]));
  }
  return value;
}

function keccak(data: Bytes): Bytes {
  return Bytes.fromByteArray(crypto.keccak256(data));
}

function loadOrCreateStream(streamId: Bytes, blockNumber: BigInt): Stream {
  let stream = Stream.load(streamId);
  if (stream == null) {
    stream = new Stream(streamId);
    stream.anchorCount = BigInt.zero();
    stream.latestSeq = null;
    stream.headEnvelopeDigest = null;
    stream.hasConflicts = false;
    stream.conflictCount = BigInt.zero();
    stream.firstBlock = blockNumber;
    stream.lastBlock = blockNumber;
  }
  return stream as Stream;
}

function recordMalformed(call: PostAnchorCall, payload: Bytes, reason: string): void {
  let id = call.transaction.hash.toHexString() + "-" + keccak(payload).toHexString();
  let malformed = new MalformedAnchor(id);
  malformed.reason = reason;
  malformed.payloadLength = BigInt.fromI32(payload.length);
  malformed.payload = payload;
  malformed.submitter = call.from;
  malformed.txHash = call.transaction.hash;
  malformed.blockNumber = call.block.number;
  malformed.save();
  log.warning("anchor: undecodable payload ({}) in tx {}", [reason, call.transaction.hash.toHexString()]);
}

/**
 * Index one postAnchor call.
 *
 * The index reports what the chain contains; the completeness checker
 * adjudicates. Nothing is silently dropped: a payload that will not decode
 * becomes a MalformedAnchor, a second different envelope at a position becomes
 * a ConflictingAnchor, and an identical re-submission increments a counter.
 *
 * Ordering is deterministic because every anchor is a top-level transaction
 * from a single writer EOA: nonce ordering makes seq order coincide with block
 * order, and graph-node processes transactions in block order.
 */
export function indexAnchorCall(call: PostAnchorCall, mode: i32): void {
  // graph-cli 0.98.1 names the unnamed `bytes` input `value0` (spec §4.4 says
  // `param0`, which was the older codegen convention). The accessor name is the
  // only thing that changed; it is still the ABI-decoded calldata argument.
  let payload = call.inputs.value0;

  if (payload.length != ENVELOPE_LENGTH) {
    recordMalformed(call, payload, "WRONG_LENGTH");
    return;
  }
  if (<i32>payload[OFFSET_VERSION] != ENVELOPE_VERSION) {
    recordMalformed(call, payload, "UNSUPPORTED_VERSION");
    return;
  }

  let streamId = sliceBytes(payload, OFFSET_STREAM_ID, SIZE_STREAM_ID);
  let seq = readU64BE(payload, OFFSET_SEQ);
  let ciphertextDigest = sliceBytes(payload, OFFSET_CIPHERTEXT_DIGEST, SIZE_DIGEST);
  let prevEnvelopeDigest = sliceBytes(payload, OFFSET_PREV_ENVELOPE_DIGEST, SIZE_DIGEST);
  let envelope = payload;

  if (mode == MODE_DROP_EVERY_FOURTH && seq.mod(BigInt.fromI32(DROP_MODULUS)).equals(BigInt.fromI32(DROP_REMAINDER))) {
    // BAD SERVER (test fixture): silently withhold every fourth anchor. This is
    // what an incomplete index looks like from the outside — the checker must
    // report GAP at exactly these positions.
    return;
  }

  if (mode == MODE_BREAK_CHAIN_AT_SEQ_FIVE && seq.equals(BigInt.fromI32(BREAK_CHAIN_AT_SEQ))) {
    // BAD SERVER (test fixture): rewrite this anchor's backward link and keep
    // the row internally consistent, so only the chain check can catch it.
    let mutated = new Uint8Array(ENVELOPE_LENGTH);
    for (let i = 0; i < ENVELOPE_LENGTH; i++) {
      mutated[i] = payload[i];
    }
    mutated[OFFSET_PREV_ENVELOPE_DIGEST] = mutated[OFFSET_PREV_ENVELOPE_DIGEST] ^ 0xff;
    envelope = Bytes.fromUint8Array(mutated);
    prevEnvelopeDigest = sliceBytes(envelope, OFFSET_PREV_ENVELOPE_DIGEST, SIZE_DIGEST);
  }

  let envelopeDigest = keccak(envelope);
  let stream = loadOrCreateStream(streamId, call.block.number);
  let anchorId = streamId.toHexString() + "-" + seq.toString();
  let existing = Anchor.load(anchorId);

  if (existing == null) {
    let anchor = new Anchor(anchorId);
    anchor.stream = stream.id;
    anchor.seq = seq;
    anchor.ciphertextDigest = ciphertextDigest;
    anchor.prevEnvelopeDigest = prevEnvelopeDigest;
    anchor.envelopeDigest = envelopeDigest;
    anchor.envelope = envelope;
    anchor.submitter = call.from;
    anchor.txHash = call.transaction.hash;
    anchor.blockNumber = call.block.number;
    anchor.blockTimestamp = call.block.timestamp;
    anchor.duplicateCount = BigInt.zero();
    anchor.save();

    stream.anchorCount = stream.anchorCount.plus(BigInt.fromI32(1));
    let latest = stream.latestSeq;
    if (latest === null || seq.gt(latest as BigInt)) {
      stream.latestSeq = seq;
      stream.headEnvelopeDigest = envelopeDigest;
    }
  } else if (existing.envelopeDigest.equals(envelopeDigest)) {
    existing.duplicateCount = existing.duplicateCount.plus(BigInt.fromI32(1));
    existing.save();
  } else {
    let conflictId = anchorId + "-" + call.transaction.hash.toHexString();
    let conflict = new ConflictingAnchor(conflictId);
    conflict.stream = stream.id;
    conflict.seq = seq;
    conflict.ciphertextDigest = ciphertextDigest;
    conflict.prevEnvelopeDigest = prevEnvelopeDigest;
    conflict.envelopeDigest = envelopeDigest;
    conflict.envelope = envelope;
    conflict.submitter = call.from;
    conflict.txHash = call.transaction.hash;
    conflict.blockNumber = call.block.number;
    conflict.save();

    stream.hasConflicts = true;
    stream.conflictCount = stream.conflictCount.plus(BigInt.fromI32(1));
  }

  stream.lastBlock = call.block.number;
  stream.save();
}
