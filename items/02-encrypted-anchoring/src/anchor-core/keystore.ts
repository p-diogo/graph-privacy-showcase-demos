import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fromHex, toHex, type Hex } from "./bytes.js";
import { STREAM_KEY_LENGTH } from "./crypto.js";
import { SIZE } from "./envelope.js";

export const KEYFILE_FORMAT = "item02-anchor-keyfile";
export const KEYFILE_WARNING =
  "DEMO-GRADE KEY MATERIAL. This file holds the stream key in cleartext. " +
  "Item 02 makes no custody, KMS, or HSM claim; keys never leave the writer " +
  "process, and nothing in this repo is production key management.";

export interface Keyfile {
  format: typeof KEYFILE_FORMAT;
  version: 1;
  warning: string;
  streamId: Hex;
  streamKey: Hex;
}

export interface KeyMaterial {
  streamId: Uint8Array;
  streamKey: Uint8Array;
}

export function generateKeyfile(): Keyfile {
  return {
    format: KEYFILE_FORMAT,
    version: 1,
    warning: KEYFILE_WARNING,
    streamId: toHex(new Uint8Array(randomBytes(SIZE.streamId))),
    streamKey: toHex(new Uint8Array(randomBytes(STREAM_KEY_LENGTH))),
  };
}

export function keyMaterial(keyfile: Keyfile): KeyMaterial {
  const streamId = fromHex(keyfile.streamId);
  const streamKey = fromHex(keyfile.streamKey);
  if (streamId.length !== SIZE.streamId) throw new Error(`keyfile streamId must be ${SIZE.streamId} bytes`);
  if (streamKey.length !== STREAM_KEY_LENGTH) throw new Error(`keyfile streamKey must be ${STREAM_KEY_LENGTH} bytes`);
  return { streamId, streamKey };
}

export function parseKeyfile(json: string): Keyfile {
  const parsed = JSON.parse(json) as Partial<Keyfile>;
  if (parsed.format !== KEYFILE_FORMAT) throw new Error(`not an ${KEYFILE_FORMAT}: format=${String(parsed.format)}`);
  if (parsed.version !== 1) throw new Error(`unsupported keyfile version ${String(parsed.version)}`);
  if (typeof parsed.streamId !== "string" || typeof parsed.streamKey !== "string") {
    throw new Error("keyfile is missing streamId or streamKey");
  }
  const keyfile: Keyfile = {
    format: KEYFILE_FORMAT,
    version: 1,
    warning: typeof parsed.warning === "string" ? parsed.warning : KEYFILE_WARNING,
    streamId: parsed.streamId as Hex,
    streamKey: parsed.streamKey as Hex,
  };
  keyMaterial(keyfile);
  return keyfile;
}

export function readKeyfile(path: string): Keyfile {
  return parseKeyfile(readFileSync(path, "utf8"));
}

export function writeKeyfile(path: string, keyfile: Keyfile): void {
  writeFileSync(path, `${JSON.stringify(keyfile, null, 2)}\n`, { mode: 0o600 });
}
