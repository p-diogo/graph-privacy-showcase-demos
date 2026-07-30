import { Address, BigInt, Bytes, crypto, ethereum } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, describe, newMockCallWithIO, test } from "matchstick-as/assembly/index";
import { PostAnchorCall } from "../../src/subgraph/generated/AnchorDataEdge/AnchorDataEdge";
import { handlePostAnchor } from "../../src/subgraph/src/mapping";

// Golden vectors, copied verbatim from fixtures/golden/anchors.json — the same
// bytes the TypeScript writer produces for the published demo key. Asserting
// them here ties the AssemblyScript decoder to the TypeScript encoder: if the
// two implementations ever disagree about the envelope layout, these fail.
const STREAM_ID = "0x5be7cd098a9193fd81ad24e4bf014498cfc8e1fcfb796660cb9ee01eab8c373d";

const ENVELOPE_SEQ0 =
  "0x015be7cd098a9193fd81ad24e4bf014498cfc8e1fcfb796660cb9ee01eab8c373d0000000000000000" +
  "6a7d5519f40837ccf235af0f6df03bca37d93957e1695f7ef5376c003aad5122" +
  "0000000000000000000000000000000000000000000000000000000000000000";
const CIPHERTEXT_DIGEST_SEQ0 = "0x6a7d5519f40837ccf235af0f6df03bca37d93957e1695f7ef5376c003aad5122";
const ENVELOPE_DIGEST_SEQ0 = "0xc4451b117afd7e0594b7cda6a942103538a0effa68a67874f1991654de5d8eaa";

const ENVELOPE_SEQ1 =
  "0x015be7cd098a9193fd81ad24e4bf014498cfc8e1fcfb796660cb9ee01eab8c373d0000000000000001" +
  "c06d2fe5b45403775e1db15cf06b3429f059c565beb48ecde1d992f89ebef2ea" +
  "c4451b117afd7e0594b7cda6a942103538a0effa68a67874f1991654de5d8eaa";
const ENVELOPE_DIGEST_SEQ1 = "0x88f72e93add5ba9b183812b8eb706ab5c6670ceb2de82b46121a640e05cf5eb4";

const SUBMITTER = "0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266";
const TX_HASH_A = "0xaa00000000000000000000000000000000000000000000000000000000000001";
const TX_HASH_B = "0xbb00000000000000000000000000000000000000000000000000000000000002";

function anchorId(seq: string): string {
  return STREAM_ID + "-" + seq;
}

function callWithPayload(payload: Bytes, txHash: string, blockNumber: i32): PostAnchorCall {
  let inputs: Array<ethereum.EventParam> = [new ethereum.EventParam("value0", ethereum.Value.fromBytes(payload))];
  let outputs: Array<ethereum.EventParam> = [];
  let call = changetype<PostAnchorCall>(newMockCallWithIO(inputs, outputs));
  call.from = Address.fromString(SUBMITTER);
  call.transaction.hash = Bytes.fromHexString(txHash);
  call.block.number = BigInt.fromI32(blockNumber);
  call.block.timestamp = BigInt.fromI32(1700000000 + blockNumber);
  return call;
}

/** Build an envelope from parts, so tests can produce variants the fixtures do not contain. */
function envelope(streamId: string, seq: i32, ciphertextDigest: string, prevEnvelopeDigest: string): Bytes {
  let out = new Uint8Array(105);
  out[0] = 1;
  let id = Bytes.fromHexString(streamId);
  for (let i = 0; i < 32; i++) {
    out[1 + i] = id[i];
  }
  let value = seq;
  for (let i = 7; i >= 0; i--) {
    out[33 + i] = <u8>(value & 0xff);
    value = value >> 8;
  }
  let ct = Bytes.fromHexString(ciphertextDigest);
  for (let i = 0; i < 32; i++) {
    out[41 + i] = ct[i];
  }
  let prev = Bytes.fromHexString(prevEnvelopeDigest);
  for (let i = 0; i < 32; i++) {
    out[73 + i] = prev[i];
  }
  return Bytes.fromUint8Array(out);
}

describe("handlePostAnchor", () => {
  afterEach(() => {
    clearStore();
  });

  test("indexes a well-formed anchor and creates its stream", () => {
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ0), TX_HASH_A, 100));

    assert.entityCount("Anchor", 1);
    assert.entityCount("Stream", 1);
    assert.fieldEquals("Anchor", anchorId("0"), "seq", "0");
    assert.fieldEquals("Anchor", anchorId("0"), "ciphertextDigest", CIPHERTEXT_DIGEST_SEQ0);
    assert.fieldEquals("Anchor", anchorId("0"), "envelopeDigest", ENVELOPE_DIGEST_SEQ0);
    assert.fieldEquals(
      "Anchor",
      anchorId("0"),
      "prevEnvelopeDigest",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert.fieldEquals("Anchor", anchorId("0"), "envelope", ENVELOPE_SEQ0);
    assert.fieldEquals("Anchor", anchorId("0"), "submitter", SUBMITTER.toLowerCase());
    assert.fieldEquals("Anchor", anchorId("0"), "txHash", TX_HASH_A);
    assert.fieldEquals("Anchor", anchorId("0"), "blockNumber", "100");
    assert.fieldEquals("Anchor", anchorId("0"), "duplicateCount", "0");

    assert.fieldEquals("Stream", STREAM_ID, "anchorCount", "1");
    assert.fieldEquals("Stream", STREAM_ID, "latestSeq", "0");
    assert.fieldEquals("Stream", STREAM_ID, "headEnvelopeDigest", ENVELOPE_DIGEST_SEQ0);
    assert.fieldEquals("Stream", STREAM_ID, "hasConflicts", "false");
    assert.fieldEquals("Stream", STREAM_ID, "conflictCount", "0");
    assert.fieldEquals("Stream", STREAM_ID, "firstBlock", "100");
    assert.fieldEquals("Stream", STREAM_ID, "lastBlock", "100");
  });

  test("advances the stream head across a chained sequence", () => {
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ0), TX_HASH_A, 100));
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ1), TX_HASH_B, 101));

    assert.entityCount("Anchor", 2);
    assert.fieldEquals("Anchor", anchorId("1"), "prevEnvelopeDigest", ENVELOPE_DIGEST_SEQ0);
    assert.fieldEquals("Anchor", anchorId("1"), "envelopeDigest", ENVELOPE_DIGEST_SEQ1);
    assert.fieldEquals("Stream", STREAM_ID, "anchorCount", "2");
    assert.fieldEquals("Stream", STREAM_ID, "latestSeq", "1");
    assert.fieldEquals("Stream", STREAM_ID, "headEnvelopeDigest", ENVELOPE_DIGEST_SEQ1);
    assert.fieldEquals("Stream", STREAM_ID, "lastBlock", "101");
  });

  test("counts an identical re-submission as a duplicate, not a second anchor", () => {
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ0), TX_HASH_A, 100));
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ0), TX_HASH_B, 105));

    assert.entityCount("Anchor", 1);
    assert.entityCount("ConflictingAnchor", 0);
    assert.fieldEquals("Anchor", anchorId("0"), "duplicateCount", "1");
    assert.fieldEquals("Anchor", anchorId("0"), "txHash", TX_HASH_A);
    assert.fieldEquals("Stream", STREAM_ID, "anchorCount", "1");
    assert.fieldEquals("Stream", STREAM_ID, "hasConflicts", "false");
  });

  test("records a different envelope at the same seq as a conflict", () => {
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ0), TX_HASH_A, 100));
    let competing = envelope(
      STREAM_ID,
      0,
      "0xdead000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    handlePostAnchor(callWithPayload(competing, TX_HASH_B, 106));

    assert.entityCount("Anchor", 1);
    assert.entityCount("ConflictingAnchor", 1);
    assert.fieldEquals("Anchor", anchorId("0"), "ciphertextDigest", CIPHERTEXT_DIGEST_SEQ0);
    assert.fieldEquals("Anchor", anchorId("0"), "duplicateCount", "0");
    assert.fieldEquals("ConflictingAnchor", anchorId("0") + "-" + TX_HASH_B, "seq", "0");
    assert.fieldEquals(
      "ConflictingAnchor",
      anchorId("0") + "-" + TX_HASH_B,
      "ciphertextDigest",
      "0xdead000000000000000000000000000000000000000000000000000000000001",
    );
    assert.fieldEquals("Stream", STREAM_ID, "hasConflicts", "true");
    assert.fieldEquals("Stream", STREAM_ID, "conflictCount", "1");
    assert.fieldEquals("Stream", STREAM_ID, "anchorCount", "1");
  });

  test("records a short payload as malformed and drops nothing", () => {
    let payload = Bytes.fromHexString("0x0102030405");
    handlePostAnchor(callWithPayload(payload, TX_HASH_A, 110));

    assert.entityCount("Anchor", 0);
    assert.entityCount("Stream", 0);
    assert.entityCount("MalformedAnchor", 1);

    let id = TX_HASH_A + "-" + Bytes.fromByteArray(crypto.keccak256(payload)).toHexString();
    assert.fieldEquals("MalformedAnchor", id, "reason", "WRONG_LENGTH");
    assert.fieldEquals("MalformedAnchor", id, "payloadLength", "5");
    assert.fieldEquals("MalformedAnchor", id, "payload", "0x0102030405");
    assert.fieldEquals("MalformedAnchor", id, "blockNumber", "110");
  });

  test("labels a wrong-version payload UNSUPPORTED_VERSION", () => {
    let wrongVersion = envelope(
      STREAM_ID,
      0,
      CIPHERTEXT_DIGEST_SEQ0,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    let mutated = new Uint8Array(105);
    for (let i = 0; i < 105; i++) {
      mutated[i] = wrongVersion[i];
    }
    mutated[0] = 2;

    let payload = Bytes.fromUint8Array(mutated);
    handlePostAnchor(callWithPayload(payload, TX_HASH_B, 111));

    assert.entityCount("Anchor", 0);
    assert.entityCount("MalformedAnchor", 1);
    let id = TX_HASH_B + "-" + Bytes.fromByteArray(crypto.keccak256(payload)).toHexString();
    assert.fieldEquals("MalformedAnchor", id, "reason", "UNSUPPORTED_VERSION");
    assert.fieldEquals("MalformedAnchor", id, "payloadLength", "105");
  });

  test("keeps streams independent", () => {
    let otherStream = "0x1111111111111111111111111111111111111111111111111111111111111111";
    handlePostAnchor(callWithPayload(Bytes.fromHexString(ENVELOPE_SEQ0), TX_HASH_A, 100));
    handlePostAnchor(
      callWithPayload(
        envelope(
          otherStream,
          0,
          "0x2222222222222222222222222222222222222222222222222222222222222222",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ),
        TX_HASH_B,
        101,
      ),
    );

    assert.entityCount("Stream", 2);
    assert.entityCount("Anchor", 2);
    assert.fieldEquals("Stream", STREAM_ID, "anchorCount", "1");
    assert.fieldEquals("Stream", otherStream, "anchorCount", "1");
  });
});
