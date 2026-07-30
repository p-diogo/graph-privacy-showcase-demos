#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import {
  UsageError,
  optionalFlag,
  parseArgs,
  readDisclosure,
  requireFlag,
  writeDisclosure,
  type Disclosure,
} from "../anchor-core/index.js";

/**
 * Produce a tampered disclosure so the checker has something to catch.
 *
 * This tool only ever edits a *copy* of a disclosure bundle — the auditor-side
 * artifact. It never touches the chain and never touches anyone else's index:
 * the two dishonest-server cases live in local-only subgraph variants instead.
 *
 *   alter    --seq k   restate one record after the fact (the classic tamper)
 *   suppress --seq k   drop a record and its seq from the disclosure
 */
function loadCopy(disclosureDir: string, outDir: string): Disclosure {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  cpSync(disclosureDir, outDir, { recursive: true });
  return readDisclosure(outDir);
}

function alterRecord(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed["notional"] === "string") {
    const original = parsed["notional"];
    const restated = original.startsWith("1") ? `9${original.slice(1)}` : `1${original.slice(1)}`;
    parsed["notional"] = restated;
  } else if (typeof parsed["status"] === "string") {
    parsed["status"] = "restated";
  } else {
    parsed["restated"] = true;
  }
  return JSON.stringify(parsed);
}

const args = parseArgs(process.argv.slice(2));
const command = args.command;

try {
  const disclosureDir = requireFlag(args, "disclosure");
  const outDir = requireFlag(args, "out");
  const seq = BigInt(requireFlag(args, "seq"));

  if (command !== "alter" && command !== "suppress") {
    throw new UsageError(`unknown command ${command ?? "(none)"}; expected alter or suppress`);
  }

  const disclosure = loadCopy(disclosureDir, outDir);
  const position = disclosure.manifest.seqs.findIndex((value) => BigInt(value) === seq);
  if (position < 0) throw new UsageError(`disclosure has no record at seq ${seq}`);

  if (command === "alter") {
    const record = disclosure.records[position] as (typeof disclosure.records)[number];
    const altered = alterRecord(record.text);
    disclosure.records[position] = {
      index: record.index,
      text: altered,
      plaintext: new TextEncoder().encode(altered),
    };
    writeDisclosure(outDir, disclosure);
    process.stdout.write(`altered seq ${seq} in ${outDir}\n  was: ${record.text}\n  now: ${altered}\n`);
  } else {
    const [removed] = disclosure.records.splice(position, 1);
    disclosure.manifest.seqs.splice(position, 1);
    disclosure.manifest.anchorCount = disclosure.records.length;
    writeDisclosure(outDir, disclosure);
    process.stdout.write(`suppressed seq ${seq} in ${outDir}\n  removed: ${removed?.text ?? ""}\n`);
  }

  const label = optionalFlag(args, "label");
  if (label) process.stdout.write(`(${label})\n`);
} catch (error) {
  process.stderr.write(`tamper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
