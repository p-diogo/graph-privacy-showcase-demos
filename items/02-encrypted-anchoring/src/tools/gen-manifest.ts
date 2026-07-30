#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { optionalFlag, parseArgs, requireFlag } from "../anchor-core/cli-args.js";

/**
 * Render `src/subgraph/subgraph.template.yaml` into a deployable manifest.
 *
 * The three deployment-specific values (network, address, startBlock) are never
 * committed in a generated manifest: a pinned address that is not the one you
 * deployed is a lie waiting to be copied.
 *
 * --variant selects the mapping entry point:
 *   honest        the real index (default)
 *   badserver-gap a deliberately incomplete server (drops every 4th anchor)
 *   badserver-chain a server that breaks the hash chain at seq 5
 * The two bad-server variants exist so the negative tests have a dishonest
 * server to catch locally. They are never published anywhere.
 */
const VARIANTS: Record<string, { mappingFile: string; out: string }> = {
  honest: { mappingFile: "./src/mapping.ts", out: "subgraph.yaml" },
  "badserver-gap": { mappingFile: "./src/mapping-badserver-gap.ts", out: "subgraph.badserver-gap.yaml" },
  "badserver-chain": { mappingFile: "./src/mapping-badserver-chain.ts", out: "subgraph.badserver-chain.yaml" },
};

const args = parseArgs(process.argv.slice(2));
const variantName = optionalFlag(args, "variant") ?? "honest";
const variant = VARIANTS[variantName];
if (!variant) {
  process.stderr.write(`gen-manifest: unknown --variant ${variantName} (have: ${Object.keys(VARIANTS).join(", ")})\n`);
  process.exit(1);
}

const templatePath = optionalFlag(args, "template") ?? "src/subgraph/subgraph.template.yaml";
const outPath = optionalFlag(args, "out") ?? `src/subgraph/${variant.out}`;
const network = requireFlag(args, "network");
const address = requireFlag(args, "address");
const startBlock = optionalFlag(args, "start-block") ?? "0";

if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  process.stderr.write(`gen-manifest: --address must be a 20-byte hex address, got ${address}\n`);
  process.exit(1);
}

const rendered = readFileSync(templatePath, "utf8")
  .replace(/\{\{network\}\}/g, network)
  .replace(/\{\{address\}\}/g, address)
  .replace(/\{\{startBlock\}\}/g, startBlock)
  .replace(/\{\{mappingFile\}\}/g, variant.mappingFile);

if (rendered.includes("{{")) {
  process.stderr.write("gen-manifest: template still has unreplaced placeholders\n");
  process.exit(1);
}

writeFileSync(outPath, rendered);
process.stdout.write(`wrote ${outPath} (variant ${variantName}, network ${network}, address ${address}, startBlock ${startBlock})\n`);
