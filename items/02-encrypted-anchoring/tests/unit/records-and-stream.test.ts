import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toHex, utf8, ZERO32 } from "../../src/anchor-core/bytes.js";
import { parseRecordsJsonl, serializeRecordsJsonl } from "../../src/anchor-core/records.js";
import { computeAnchors } from "../../src/anchor-core/stream.js";
import { keyMaterial, parseKeyfile } from "../../src/anchor-core/keystore.js";

const keyfile = parseKeyfile(readFileSync("fixtures/demo-keyfile.json", "utf8"));
const { streamId, streamKey } = keyMaterial(keyfile);

describe("record parsing", () => {
  it("treats the raw line bytes as the plaintext, not a re-serialisation", () => {
    const content = '{"b":1,"a":2}\n';
    const [record] = parseRecordsJsonl(content);
    expect(record!.text).toBe('{"b":1,"a":2}');
    expect(toHex(record!.plaintext)).toBe(toHex(utf8('{"b":1,"a":2}')));
  });

  it("tolerates CRLF line endings without changing the plaintext", () => {
    const [crlf] = parseRecordsJsonl('{"a":1}\r\n');
    const [lf] = parseRecordsJsonl('{"a":1}\n');
    expect(toHex(crlf!.plaintext)).toBe(toHex(lf!.plaintext));
  });

  it("rejects blank lines and non-JSON lines", () => {
    expect(() => parseRecordsJsonl('{"a":1}\n\n{"b":2}\n')).toThrow(/line 2 is blank/);
    expect(() => parseRecordsJsonl("not json\n")).toThrow(/line 1 is not valid JSON/);
    expect(() => parseRecordsJsonl("")).toThrow(/empty/);
  });

  it("round-trips the fixture file byte for byte", () => {
    const content = readFileSync("fixtures/records.jsonl", "utf8");
    expect(serializeRecordsJsonl(parseRecordsJsonl(content))).toBe(content);
  });
});

describe("stream recomputation", () => {
  const records = parseRecordsJsonl(readFileSync("fixtures/records.jsonl", "utf8")).map((record, index) => ({
    seq: BigInt(index),
    plaintext: record.plaintext,
  }));

  it("chains seq 0 to zero and every later anchor to its predecessor", () => {
    const anchors = computeAnchors(streamKey, streamId, records);
    expect(toHex(anchors[0]!.prevEnvelopeDigest as Uint8Array)).toBe(toHex(ZERO32));
    for (let index = 1; index < anchors.length; index++) {
      expect(toHex(anchors[index]!.prevEnvelopeDigest as Uint8Array)).toBe(
        toHex(anchors[index - 1]!.envelopeDigest as Uint8Array),
      );
    }
  });

  it("is order-independent: shuffled input produces the same anchors", () => {
    const shuffled = [...records].reverse();
    const fromShuffled = computeAnchors(streamKey, streamId, shuffled);
    const fromOrdered = computeAnchors(streamKey, streamId, records);
    expect(fromShuffled.map((anchor) => toHex(anchor.envelopeDigest as Uint8Array))).toEqual(
      fromOrdered.map((anchor) => toHex(anchor.envelopeDigest as Uint8Array)),
    );
  });

  it("marks links unresolvable rather than wrong when a record is absent", () => {
    const withHole = records.filter((record) => record.seq !== 4n);
    const anchors = computeAnchors(streamKey, streamId, withHole);
    const atFive = anchors.find((anchor) => anchor.seq === 5n)!;
    expect(atFive.prevEnvelopeDigest).toBeNull();
    expect(atFive.envelopeDigest).toBeNull();
    // The ciphertext still recomputes: an absent neighbour costs the chain link,
    // not the per-record check.
    expect(atFive.ciphertextDigest.length).toBe(32);
  });

  it("rejects a record set with a duplicated seq", () => {
    expect(() =>
      computeAnchors(streamKey, streamId, [
        { seq: 0n, plaintext: utf8("a") },
        { seq: 0n, plaintext: utf8("b") },
      ]),
    ).toThrow(/duplicate seq/);
  });
});
