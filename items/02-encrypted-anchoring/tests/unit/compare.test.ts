import { describe, expect, it } from "vitest";
import { keccak256, utf8 } from "../../src/anchor-core/bytes.js";
import { computeAnchors } from "../../src/anchor-core/stream.js";
import { EXIT, compareDisclosureToIndex, compareIndexes } from "../../src/completeness-checker/compare.js";
import { fixtureStream, servedFrom, withBrokenChainAt, withoutSeqs } from "../helpers/served.js";

const { streamId, streamKey, anchors } = fixtureStream();
const served = servedFrom(streamId, anchors);

function codes(findings: { code: string }[]): string[] {
  return findings.map((finding) => finding.code);
}

function recompute(records: { seq: bigint; plaintext: Uint8Array }[]) {
  return computeAnchors(streamKey, streamId, records);
}

const honestRecords = anchors.map((anchor) => ({ seq: anchor.seq, plaintext: anchor.plaintext }));

describe("verdict engine", () => {
  it("passes when the disclosure and the served index agree", () => {
    const verdict = compareDisclosureToIndex(anchors, served);
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.exitCode).toBe(EXIT.OK);
    expect(verdict.summary.disclosedCount).toBe(10);
    expect(verdict.summary.servedCount).toBe(10);
    expect(verdict.summary.checkedLinks).toBe(10);
    expect(verdict.summary.unresolvableLinks).toBe(0);
  });

  it("reports ALTERED at exactly the seq whose record was restated", () => {
    const tampered = honestRecords.map((record) =>
      record.seq === 3n ? { seq: record.seq, plaintext: utf8('{"recordId":"SET-2026-0003","notional":"1.00"}') } : record,
    );
    const verdict = compareDisclosureToIndex(recompute(tampered), served);

    expect(codes(verdict.findings)).toEqual(["ALTERED"]);
    expect(verdict.findings[0]!.seq).toBe(3n);
    expect(verdict.exitCode).toBe(EXIT.ALTERED);
    // The tamper changes every downstream chain link too; those are notes, not
    // separate failures, so one tamper reads as one finding.
    expect(verdict.notes.some((note) => note.code === "DOWNSTREAM")).toBe(true);
  });

  it("reports MISSING and a count mismatch when a record is suppressed", () => {
    const suppressed = honestRecords.filter((record) => record.seq !== 5n);
    const verdict = compareDisclosureToIndex(recompute(suppressed), served);

    expect(codes(verdict.findings).sort()).toEqual(["COUNT-MISMATCH", "MISSING"]);
    expect(verdict.findings.find((finding) => finding.code === "MISSING")!.seq).toBe(5n);
    expect(verdict.exitCode).toBe(EXIT.MISSING);
    expect(verdict.summary.disclosedCount).toBe(9);
    expect(verdict.summary.servedCount).toBe(10);
    // seq 6 cannot resolve its link without seq 5: missing evidence, not tampering.
    expect(verdict.notes.some((note) => note.code === "UNRESOLVABLE-LINK" && note.seq === 6n)).toBe(true);
  });

  it("reports GAP at every position a bad server withheld", () => {
    const incomplete = withoutSeqs(served, [3n, 7n]);
    const verdict = compareDisclosureToIndex(anchors, incomplete);

    expect(verdict.findings.filter((finding) => finding.code === "GAP").map((finding) => finding.seq)).toEqual([3n, 7n]);
    expect(codes(verdict.findings)).toContain("COUNT-MISMATCH");
    expect(verdict.exitCode).toBe(EXIT.GAP);
  });

  it("reports CHAIN-BREAK once, at the anchor whose backward link was rewritten", () => {
    const broken = withBrokenChainAt(served, 5n);
    const verdict = compareDisclosureToIndex(anchors, broken);

    const chainBreaks = verdict.findings.filter((finding) => finding.code === "CHAIN-BREAK");
    expect(chainBreaks.map((finding) => finding.seq)).toEqual([5n]);
    expect(verdict.exitCode).toBe(EXIT.CHAIN_BREAK);
    expect(verdict.notes.some((note) => note.code === "DOWNSTREAM" && note.seq === 6n)).toBe(true);
  });

  it("catches a served row that is internally inconsistent", () => {
    const inconsistent = {
      ...served,
      anchors: served.anchors.map((anchor) =>
        anchor.seq === 2n ? { ...anchor, envelopeDigest: keccak256(utf8("not the envelope")) } : anchor,
      ),
    };
    const verdict = compareDisclosureToIndex(anchors, inconsistent);

    expect(codes(verdict.findings)).toEqual(["ENVELOPE-MISMATCH"]);
    expect(verdict.findings[0]!.seq).toBe(2n);
    expect(verdict.exitCode).toBe(EXIT.ENVELOPE_MISMATCH);
    expect(verdict.notes.filter((note) => note.code === "DOWNSTREAM").map((note) => note.seq)).toEqual([3n]);
  });

  it("fails on a conflicting anchor and passes duplicates through as notes", () => {
    const withConflict = {
      ...served,
      conflicts: [
        { seq: 4n, envelopeDigest: keccak256(utf8("competing envelope")), txHash: "0xabc" as const, blockNumber: 140n },
      ],
      anchors: served.anchors.map((anchor) => (anchor.seq === 1n ? { ...anchor, duplicateCount: 2n } : anchor)),
    };
    const verdict = compareDisclosureToIndex(anchors, withConflict);

    expect(codes(verdict.findings)).toEqual(["CONFLICT"]);
    expect(verdict.exitCode).toBe(EXIT.CONFLICT);
    expect(verdict.notes.some((note) => note.code === "DUPLICATE" && note.seq === 1n)).toBe(true);
    expect(verdict.summary.duplicateCount).toBe("2");
  });

  it("records malformed payloads without failing the disclosure", () => {
    const withJunk = {
      ...served,
      malformed: [{ reason: "WRONG_LENGTH", payloadLength: 5, txHash: "0xdef" as const, blockNumber: 150n }],
    };
    const verdict = compareDisclosureToIndex(anchors, withJunk);

    expect(verdict.ok).toBe(true);
    expect(verdict.notes.some((note) => note.code === "MALFORMED")).toBe(true);
    expect(verdict.summary.malformedCount).toBe(1);
  });

  it("takes the lowest exit code when several findings coincide", () => {
    const tampered = honestRecords
      .filter((record) => record.seq !== 5n)
      .map((record) => (record.seq === 3n ? { seq: record.seq, plaintext: utf8('{"x":1}') } : record));
    const verdict = compareDisclosureToIndex(recompute(tampered), served);

    expect(codes(verdict.findings)).toContain("ALTERED");
    expect(codes(verdict.findings)).toContain("MISSING");
    expect(verdict.exitCode).toBe(EXIT.ALTERED);
  });

  it("finds no difference between two honest sources and finds one when they diverge", () => {
    const chainView = { ...served, source: "chain" as const, description: "raw block scan" };
    expect(compareIndexes(served, chainView)).toEqual([]);
    const divergent = withoutSeqs(chainView, [9n]);
    expect(compareIndexes(served, divergent)).toEqual(["seq 9: present in local but not in chain"]);
  });
});
