import { type Hex } from "./bytes.js";

/**
 * The writer's local archive: the owner's off-chain store of what was anchored.
 * Ciphertexts live here, plaintexts do not — the archive alone discloses
 * nothing without the keyfile.
 *
 * No timestamps or other ambient values are recorded, so two runs over the same
 * records with the same key produce byte-identical archives apart from tx
 * hashes and block numbers (which the chain assigns).
 */
export const ARCHIVE_FORMAT = "item02-anchor-archive";

export interface ArchiveAnchor {
  seq: string;
  ciphertext: Hex;
  ciphertextDigest: Hex;
  prevEnvelopeDigest: Hex;
  envelope: Hex;
  envelopeDigest: Hex;
  txHash: Hex | null;
  blockNumber: string | null;
}

export interface Archive {
  format: typeof ARCHIVE_FORMAT;
  version: 1;
  streamId: Hex;
  contract: Hex | null;
  chainId: number | null;
  startBlock: string | null;
  endBlock: string | null;
  submitted: boolean;
  anchors: ArchiveAnchor[];
}

export function parseArchive(json: string): Archive {
  const parsed = JSON.parse(json) as Partial<Archive>;
  if (parsed.format !== ARCHIVE_FORMAT) throw new Error(`not an ${ARCHIVE_FORMAT}: format=${String(parsed.format)}`);
  if (parsed.version !== 1) throw new Error(`unsupported archive version ${String(parsed.version)}`);
  if (!Array.isArray(parsed.anchors)) throw new Error("archive has no anchors array");
  return parsed as Archive;
}
