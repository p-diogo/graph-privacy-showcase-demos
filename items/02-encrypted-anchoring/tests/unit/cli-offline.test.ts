import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArchive } from "../../src/anchor-core/archive.js";
import { readDisclosure } from "../../src/anchor-core/disclosure.js";

/**
 * The CLIs as a stranger runs them, minus the chain: `post --dry-run` computes
 * and archives every anchor without submitting anything, which is also what
 * makes the golden vectors checkable without a node.
 */
const WRITER = "dist/anchor-writer/cli.js";
const TAMPER = "dist/tools/tamper.js";

let workdir: string;

function run(script: string, args: string[]): string {
  return execFileSync("node", [script, ...args], { encoding: "utf8" });
}

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], { stdio: "ignore" });
  workdir = mkdtempSync(join(tmpdir(), "item02-cli-"));
});

afterAll(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
});

describe("anchor-writer (offline)", () => {
  it("generates a keystore without printing the key", () => {
    const keystore = join(workdir, "fresh-keystore.json");
    const output = run(WRITER, ["init", "--keystore", keystore]);

    expect(output).toContain("streamId 0x");
    expect(output).toContain("streamKey withheld from stdout");
    const keyfile = JSON.parse(readFileSync(keystore, "utf8")) as { streamKey: string; warning: string };
    expect(output).not.toContain(keyfile.streamKey);
    expect(keyfile.warning).toContain("DEMO-GRADE");
    expect(keyfile.streamKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses to overwrite an existing keystore without --force", () => {
    const keystore = join(workdir, "guarded-keystore.json");
    run(WRITER, ["init", "--keystore", keystore]);
    expect(() => run(WRITER, ["init", "--keystore", keystore])).toThrow(/already exists/);
  });

  it("computes the archive from a dry run and reproduces the golden envelopes", () => {
    const archive = join(workdir, "archive.json");
    const output = run(WRITER, [
      "post",
      "--records",
      "fixtures/records.jsonl",
      "--keystore",
      "fixtures/demo-keyfile.json",
      "--contract",
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      "--archive",
      archive,
      "--dry-run",
    ]);
    expect(output).toContain("dry run: computed 10 anchors, submitted none");

    const parsed = parseArchive(readFileSync(archive, "utf8"));
    const golden = JSON.parse(readFileSync("fixtures/golden/anchors.json", "utf8")) as {
      anchors: { envelope: string; envelopeDigest: string; ciphertext: string }[];
    };
    expect(parsed.submitted).toBe(false);
    expect(parsed.anchors.length).toBe(10);
    parsed.anchors.forEach((anchor, index) => {
      expect(anchor.envelope).toBe(golden.anchors[index]!.envelope);
      expect(anchor.envelopeDigest).toBe(golden.anchors[index]!.envelopeDigest);
      expect(anchor.ciphertext).toBe(golden.anchors[index]!.ciphertext);
      expect(anchor.txHash).toBeNull();
    });
  });

  it("builds a disclosure bundle carrying seqs explicitly", () => {
    const archive = join(workdir, "archive-for-disclosure.json");
    run(WRITER, [
      "post",
      "--records",
      "fixtures/records.jsonl",
      "--keystore",
      "fixtures/demo-keyfile.json",
      "--contract",
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      "--archive",
      archive,
      "--dry-run",
    ]);
    const disclosureDir = join(workdir, "disclosure");
    run(WRITER, [
      "disclose",
      "--archive",
      archive,
      "--records",
      "fixtures/records.jsonl",
      "--keystore",
      "fixtures/demo-keyfile.json",
      "--out",
      disclosureDir,
    ]);

    const disclosure = readDisclosure(disclosureDir);
    expect(disclosure.manifest.anchorCount).toBe(10);
    expect(disclosure.manifest.seqs).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(disclosure.manifest.note).toContain("Not a proof of reserves");
    expect(disclosure.records.length).toBe(10);
  });
});

describe("tamper tool", () => {
  it("alters exactly one record and leaves the seq map intact", () => {
    const source = join(workdir, "disclosure");
    const target = join(workdir, "disclosure-altered");
    const output = run(TAMPER, ["alter", "--disclosure", source, "--out", target, "--seq", "3"]);
    expect(output).toContain("altered seq 3");

    const before = readDisclosure(source);
    const after = readDisclosure(target);
    expect(after.manifest.seqs).toEqual(before.manifest.seqs);
    expect(after.records[3]!.text).not.toBe(before.records[3]!.text);
    expect(after.records.filter((record, index) => record.text !== before.records[index]!.text).length).toBe(1);
  });

  it("suppresses a record together with its seq", () => {
    const source = join(workdir, "disclosure");
    const target = join(workdir, "disclosure-suppressed");
    run(TAMPER, ["suppress", "--disclosure", source, "--out", target, "--seq", "5"]);

    const after = readDisclosure(target);
    expect(after.records.length).toBe(9);
    expect(after.manifest.seqs).toEqual(["0", "1", "2", "3", "4", "6", "7", "8", "9"]);
    expect(after.manifest.anchorCount).toBe(9);
  });

  it("refuses a seq the disclosure does not contain", () => {
    expect(() =>
      run(TAMPER, ["alter", "--disclosure", join(workdir, "disclosure"), "--out", join(workdir, "x"), "--seq", "99"]),
    ).toThrow(/no record at seq 99/);
  });
});
