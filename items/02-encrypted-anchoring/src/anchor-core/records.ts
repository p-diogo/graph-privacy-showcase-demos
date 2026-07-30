import { utf8 } from "./bytes.js";

/**
 * A record's plaintext is the raw bytes of its line in `records.jsonl`, with
 * the line terminator excluded — not a re-serialisation of the parsed JSON.
 * This removes every canonicalisation question (key order, spacing, unicode
 * escapes) from the determinism story: the same file always encrypts to the
 * same ciphertext. Lines are still required to parse as JSON so that a
 * disclosure is human-readable and structurally valid.
 */
export interface RecordLine {
  /** 0-based position in the file. */
  index: number;
  text: string;
  plaintext: Uint8Array;
}

export function parseRecordsJsonl(content: string): RecordLine[] {
  const withoutBom = content.startsWith("﻿") ? content.slice(1) : content;
  const rawLines = withoutBom.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length === 0) throw new Error("records file is empty");

  return rawLines.map((raw, index) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text.trim().length === 0) {
      throw new Error(`records file line ${index + 1} is blank; blank lines are not records`);
    }
    try {
      JSON.parse(text);
    } catch (error) {
      throw new Error(`records file line ${index + 1} is not valid JSON: ${(error as Error).message}`);
    }
    return { index, text, plaintext: utf8(text) };
  });
}

export function serializeRecordsJsonl(lines: readonly RecordLine[]): string {
  return lines.map((line) => line.text).join("\n") + "\n";
}
