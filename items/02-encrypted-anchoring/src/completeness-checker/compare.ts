import { equalBytes, keccak256, toHex, ZERO32 } from "../anchor-core/bytes.js";
import { encodeEnvelope } from "../anchor-core/envelope.js";
import type { ComputedAnchor } from "../anchor-core/stream.js";
import type { ServedIndex } from "./types.js";

/**
 * Verdict codes double as exit codes. When several findings are present the
 * process exits with the *lowest* code among them; every finding is printed
 * regardless, so the exit code never hides a second problem.
 */
export const EXIT = {
  OK: 0,
  USAGE: 1,
  ALTERED: 2,
  MISSING: 3,
  GAP: 4,
  CHAIN_BREAK: 5,
  CONFLICT: 6,
  ENVELOPE_MISMATCH: 7,
  COUNT_MISMATCH: 8,
} as const;

export type FindingCode =
  | "ALTERED"
  | "MISSING"
  | "GAP"
  | "CHAIN-BREAK"
  | "CONFLICT"
  | "ENVELOPE-MISMATCH"
  | "COUNT-MISMATCH";

const EXIT_FOR_CODE: Record<FindingCode, number> = {
  ALTERED: EXIT.ALTERED,
  MISSING: EXIT.MISSING,
  GAP: EXIT.GAP,
  "CHAIN-BREAK": EXIT.CHAIN_BREAK,
  CONFLICT: EXIT.CONFLICT,
  "ENVELOPE-MISMATCH": EXIT.ENVELOPE_MISMATCH,
  "COUNT-MISMATCH": EXIT.COUNT_MISMATCH,
};

export interface Finding {
  code: FindingCode;
  seq: bigint | null;
  detail: string;
}

export interface Note {
  code: string;
  seq: bigint | null;
  detail: string;
}

export interface Verdict {
  ok: boolean;
  exitCode: number;
  findings: Finding[];
  notes: Note[];
  summary: {
    disclosedCount: number;
    servedCount: number;
    duplicateCount: string;
    conflictCount: number;
    malformedCount: number;
    checkedLinks: number;
    unresolvableLinks: number;
  };
}

function label(code: FindingCode, seq: bigint | null): string {
  return seq === null ? code : `${code} seq=${seq}`;
}

export function formatFinding(finding: Finding): string {
  return `${label(finding.code, finding.seq)}: ${finding.detail}`;
}

/**
 * Compare a disclosure's recomputed anchors against what a source served.
 *
 * Direction of trust: the on-chain anchor set is the reference and the
 * disclosure is what gets checked against it. Completeness here always means
 * "with respect to on-chain emissions" — never that the anchored set reflects
 * off-chain reality.
 *
 * Findings do not cascade. A chain link whose predecessor is already flagged
 * (altered, absent, or itself broken) is reported as a downstream note, so one
 * tamper produces one finding instead of a wall of consequences.
 */
export function compareDisclosureToIndex(expected: readonly ComputedAnchor[], served: ServedIndex): Verdict {
  const findings: Finding[] = [];
  const notes: Note[] = [];
  const seen = new Set<string>();

  const addFinding = (code: FindingCode, seq: bigint | null, detail: string): void => {
    const key = `${code}:${seq === null ? "-" : seq.toString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, seq, detail });
  };

  const expectedBySeq = new Map<bigint, ComputedAnchor>();
  for (const anchor of expected) expectedBySeq.set(anchor.seq, anchor);
  const servedBySeq = new Map<bigint, ServedIndex["anchors"][number]>();
  for (const anchor of served.anchors) servedBySeq.set(anchor.seq, anchor);

  // --- served-side integrity: every row is self-consistent -------------------
  const inconsistent = new Set<bigint>();
  for (const anchor of served.anchors) {
    const rebuilt = encodeEnvelope({
      version: 1,
      streamId: served.streamId,
      seq: anchor.seq,
      ciphertextDigest: anchor.ciphertextDigest,
      prevEnvelopeDigest: anchor.prevEnvelopeDigest,
    });
    if (!equalBytes(keccak256(rebuilt), anchor.envelopeDigest)) {
      inconsistent.add(anchor.seq);
      addFinding(
        "ENVELOPE-MISMATCH",
        anchor.seq,
        `served envelopeDigest ${toHex(anchor.envelopeDigest)} does not equal keccak256 of the envelope ` +
          `rebuilt from the served fields (${toHex(keccak256(rebuilt))}) — the index is internally inconsistent`,
      );
    }
    if (anchor.duplicateCount > 0n) {
      notes.push({
        code: "DUPLICATE",
        seq: anchor.seq,
        detail: `${anchor.duplicateCount} identical re-submission(s) of this envelope were anchored; benign, recorded for completeness`,
      });
    }
  }

  // --- served-side completeness: contiguity from seq 0 ------------------------
  const servedSeqs = [...servedBySeq.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const maxServed = servedSeqs.length > 0 ? (servedSeqs[servedSeqs.length - 1] as bigint) : null;
  const maxDisclosed = expected.length > 0 ? (expected[expected.length - 1] as ComputedAnchor).seq : null;
  const highWater =
    maxServed === null ? maxDisclosed : maxDisclosed === null ? maxServed : maxServed > maxDisclosed ? maxServed : maxDisclosed;

  if (highWater !== null) {
    for (let seq = 0n; seq <= highWater; seq++) {
      if (servedBySeq.has(seq)) continue;
      if (expectedBySeq.has(seq)) {
        addFinding(
          "GAP",
          seq,
          `the disclosure claims an anchor at seq ${seq} but the served index has none while serving seq ${
            maxServed ?? "none"
          } — a server that is missing anchors the chain has`,
        );
      } else if (maxServed !== null && seq < maxServed) {
        addFinding("GAP", seq, `served index skips seq ${seq} while serving higher seqs — the sequence is not contiguous`);
      }
    }
  }

  // --- disclosure vs served, per seq -----------------------------------------
  const altered = new Set<bigint>();
  for (const anchor of expected) {
    const servedAnchor = servedBySeq.get(anchor.seq);
    if (!servedAnchor) continue; // already reported as GAP above
    if (!equalBytes(anchor.ciphertextDigest, servedAnchor.ciphertextDigest)) {
      altered.add(anchor.seq);
      addFinding(
        "ALTERED",
        anchor.seq,
        `disclosed record re-encrypts to ciphertext digest ${toHex(anchor.ciphertextDigest)} but the chain anchored ` +
          `${toHex(servedAnchor.ciphertextDigest)} — the disclosed record is not the record that was anchored`,
      );
    }
  }

  for (const anchor of served.anchors) {
    if (!expectedBySeq.has(anchor.seq)) {
      addFinding(
        "MISSING",
        anchor.seq,
        `the chain anchors seq ${anchor.seq} (ciphertext digest ${toHex(anchor.ciphertextDigest)}) but the ` +
          "disclosure contains no record for it — the disclosure is incomplete",
      );
    }
  }

  // --- chain integrity --------------------------------------------------------
  let checkedLinks = 0;
  let unresolvableLinks = 0;
  const broken = new Set<bigint>();

  /**
   * A served row is trustworthy as a chain anchor point only if it is
   * internally consistent and not itself already broken. Links resting on an
   * untrustworthy predecessor are downstream consequences, not new failures.
   */
  const servedRowTrusted = (seq: bigint): boolean => !inconsistent.has(seq) && !broken.has(seq);

  /**
   * The two sides agree about seq's envelope: same ciphertext digest, same
   * backward link, same digest. Only an agreed predecessor can turn a link
   * mismatch at seq+1 into a finding of its own.
   */
  const bothSidesAgree = (seq: bigint): boolean => {
    if (seq < 0n) return true; // the zero link before seq 0 is definitional
    const expectedAnchor = expectedBySeq.get(seq);
    const servedAnchor = servedBySeq.get(seq);
    if (!expectedAnchor || !servedAnchor) return false;
    if (altered.has(seq) || inconsistent.has(seq) || broken.has(seq)) return false;
    if (expectedAnchor.envelopeDigest === null) return false;
    return equalBytes(expectedAnchor.envelopeDigest, servedAnchor.envelopeDigest);
  };

  for (const seq of servedSeqs) {
    const anchor = servedBySeq.get(seq) as ServedIndex["anchors"][number];
    // served self-chain: prev link must equal the previous served envelope digest
    const predecessorDigest = seq === 0n ? ZERO32 : servedBySeq.get(seq - 1n)?.envelopeDigest;
    if (predecessorDigest === undefined) {
      unresolvableLinks++;
      notes.push({
        code: "UNRESOLVABLE-LINK",
        seq,
        detail: `served index has no seq ${seq - 1n}, so this anchor's chain link cannot be checked`,
      });
      continue;
    }
    checkedLinks++;
    if (!equalBytes(anchor.prevEnvelopeDigest, predecessorDigest)) {
      if (seq > 0n && !servedRowTrusted(seq - 1n)) {
        notes.push({
          code: "DOWNSTREAM",
          seq,
          detail: `chain link differs because seq ${seq - 1n} is already flagged; not counted as a separate failure`,
        });
      } else {
        broken.add(seq);
        addFinding(
          "CHAIN-BREAK",
          seq,
          `anchor points back to ${toHex(anchor.prevEnvelopeDigest)} but the served seq ${seq - 1n} envelope hashes ` +
            `to ${toHex(predecessorDigest)} — the served hash chain is broken here`,
        );
      }
    }
  }

  // disclosure-side chain comparison, where the disclosure can resolve a link
  for (const anchor of expected) {
    const servedAnchor = servedBySeq.get(anchor.seq);
    if (!servedAnchor) continue;
    if (anchor.prevEnvelopeDigest === null) {
      notes.push({
        code: "UNRESOLVABLE-LINK",
        seq: anchor.seq,
        detail: `the disclosure omits seq ${anchor.seq - 1n}, so the expected chain link at seq ${anchor.seq} cannot be recomputed`,
      });
      continue;
    }
    if (!equalBytes(anchor.prevEnvelopeDigest, servedAnchor.prevEnvelopeDigest)) {
      if (!bothSidesAgree(anchor.seq - 1n) || broken.has(anchor.seq)) {
        notes.push({
          code: "DOWNSTREAM",
          seq: anchor.seq,
          detail: "expected chain link differs as a consequence of an already-flagged anchor",
        });
      } else {
        addFinding(
          "CHAIN-BREAK",
          anchor.seq,
          `recomputed chain link ${toHex(anchor.prevEnvelopeDigest)} != served ${toHex(servedAnchor.prevEnvelopeDigest)}`,
        );
      }
    } else if (
      anchor.envelopeDigest !== null &&
      !altered.has(anchor.seq) &&
      !equalBytes(anchor.envelopeDigest, servedAnchor.envelopeDigest)
    ) {
      addFinding(
        "ENVELOPE-MISMATCH",
        anchor.seq,
        `recomputed envelope digest ${toHex(anchor.envelopeDigest)} != served ${toHex(servedAnchor.envelopeDigest)}`,
      );
    }
  }

  // --- conflicts, malformed, counts -------------------------------------------
  for (const conflict of served.conflicts) {
    addFinding(
      "CONFLICT",
      conflict.seq,
      `a second, different envelope was anchored at seq ${conflict.seq} (digest ${toHex(conflict.envelopeDigest)}, tx ${
        conflict.txHash ?? "unknown"
      }) — the stream has competing anchors at one position`,
    );
  }

  for (const malformed of served.malformed) {
    notes.push({
      code: "MALFORMED",
      seq: null,
      detail: `an undecodable payload was posted to the anchor contract (${malformed.reason}, tx ${
        malformed.txHash ?? "unknown"
      }); recorded, not silently dropped — anyone may call postAnchor`,
    });
  }

  if (expected.length !== served.anchors.length) {
    addFinding(
      "COUNT-MISMATCH",
      null,
      `the disclosure contains ${expected.length} records but the served index has ${served.anchors.length} anchors`,
    );
  }

  const exitCode = findings.reduce(
    (code, finding) => Math.min(code, EXIT_FOR_CODE[finding.code]),
    Number.MAX_SAFE_INTEGER,
  );

  let duplicateCount = 0n;
  for (const anchor of served.anchors) duplicateCount += anchor.duplicateCount;

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? EXIT.OK : exitCode,
    findings,
    notes,
    summary: {
      disclosedCount: expected.length,
      servedCount: served.anchors.length,
      duplicateCount: duplicateCount.toString(),
      conflictCount: served.conflicts.length,
      malformedCount: served.malformed.length,
      checkedLinks,
      unresolvableLinks,
    },
  };
}

/** Entity-for-entity equality of two served indexes (checker cross-check mode). */
export function compareIndexes(a: ServedIndex, b: ServedIndex): string[] {
  const differences: string[] = [];
  const bySeq = (index: ServedIndex) => new Map(index.anchors.map((anchor) => [anchor.seq, anchor]));
  const left = bySeq(a);
  const right = bySeq(b);
  const seqs = [...new Set([...left.keys(), ...right.keys()])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

  for (const seq of seqs) {
    const l = left.get(seq);
    const r = right.get(seq);
    if (!l) {
      differences.push(`seq ${seq}: present in ${b.source} but not in ${a.source}`);
      continue;
    }
    if (!r) {
      differences.push(`seq ${seq}: present in ${a.source} but not in ${b.source}`);
      continue;
    }
    if (!equalBytes(l.ciphertextDigest, r.ciphertextDigest)) {
      differences.push(
        `seq ${seq}: ciphertextDigest ${toHex(l.ciphertextDigest)} (${a.source}) != ${toHex(r.ciphertextDigest)} (${b.source})`,
      );
    }
    if (!equalBytes(l.envelopeDigest, r.envelopeDigest)) {
      differences.push(
        `seq ${seq}: envelopeDigest ${toHex(l.envelopeDigest)} (${a.source}) != ${toHex(r.envelopeDigest)} (${b.source})`,
      );
    }
    if (!equalBytes(l.prevEnvelopeDigest, r.prevEnvelopeDigest)) {
      differences.push(`seq ${seq}: prevEnvelopeDigest differs between ${a.source} and ${b.source}`);
    }
  }

  if (a.conflicts.length !== b.conflicts.length) {
    differences.push(`conflict count ${a.conflicts.length} (${a.source}) != ${b.conflicts.length} (${b.source})`);
  }
  if (a.malformed.length !== b.malformed.length) {
    differences.push(`malformed count ${a.malformed.length} (${a.source}) != ${b.malformed.length} (${b.source})`);
  }
  return differences;
}
