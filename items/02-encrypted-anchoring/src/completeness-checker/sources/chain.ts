import { createPublicClient, http, type Hex as ViemHex } from "viem";
import { decodeAbiParameters } from "viem";
import { equalBytes, fromHex, keccak256, toHex, type Hex } from "../../anchor-core/bytes.js";
import { EnvelopeDecodeError, decodeEnvelope, envelopeDigest } from "../../anchor-core/envelope.js";
import { POST_ANCHOR_SELECTOR } from "../../anchor-core/index.js";
import type { ServedAnchor, ServedConflict, ServedIndex, ServedMalformed } from "../types.js";

export interface ChainScanOptions {
  rpcUrl: string;
  contract: Hex;
  streamId: Uint8Array;
  fromBlock: bigint;
  toBlock: bigint | null;
}

/**
 * Rebuild the anchor set straight from blocks — no Graph component anywhere in
 * the trust path. This is the third-party cross-check of §5.2, and it is also
 * the reference implementation of the mapping's rules: first occurrence of a
 * (streamId, seq) wins, identical re-submissions count as duplicates,
 * differing ones are conflicts, undecodable payloads are recorded not dropped.
 *
 * Scope boundary, stated because it matters: a raw block scan sees only
 * top-level transactions. An internal call into the anchor contract would be
 * invisible here while a trace-fed call handler would see it. The writer only
 * ever sends top-level transactions, so the two agree for this demo — that
 * agreement is asserted by the integration suite, not assumed.
 */
export async function scanChain(options: ChainScanOptions): Promise<ServedIndex> {
  const client = createPublicClient({ transport: http(options.rpcUrl) });
  const head = options.toBlock ?? (await client.getBlockNumber());

  const anchors = new Map<bigint, ServedAnchor>();
  const conflicts: ServedConflict[] = [];
  const malformed: ServedMalformed[] = [];
  const contract = options.contract.toLowerCase();

  for (let blockNumber = options.fromBlock; blockNumber <= head; blockNumber++) {
    const block = await client.getBlock({ blockNumber, includeTransactions: true });
    for (const tx of block.transactions) {
      if (typeof tx === "string") continue;
      if ((tx.to ?? "").toLowerCase() !== contract) continue;
      const input = tx.input as ViemHex;
      if (!input.toLowerCase().startsWith(POST_ANCHOR_SELECTOR)) continue;

      let payload: Uint8Array;
      try {
        const [decoded] = decodeAbiParameters([{ type: "bytes" }], `0x${input.slice(10)}` as ViemHex);
        payload = fromHex(decoded as string);
      } catch (error) {
        malformed.push({
          reason: `ABI_DECODE_FAILED: ${(error as Error).message}`,
          payloadLength: null,
          txHash: tx.hash as Hex,
          blockNumber,
        });
        continue;
      }

      let fields;
      try {
        fields = decodeEnvelope(payload);
      } catch (error) {
        malformed.push({
          reason: error instanceof EnvelopeDecodeError ? error.reason : `DECODE_FAILED: ${(error as Error).message}`,
          payloadLength: payload.length,
          txHash: tx.hash as Hex,
          blockNumber,
        });
        continue;
      }

      if (!equalBytes(fields.streamId, options.streamId)) continue;

      const digest = envelopeDigest(payload);
      const existing = anchors.get(fields.seq);
      if (!existing) {
        anchors.set(fields.seq, {
          seq: fields.seq,
          ciphertextDigest: fields.ciphertextDigest,
          prevEnvelopeDigest: fields.prevEnvelopeDigest,
          envelopeDigest: digest,
          duplicateCount: 0n,
          submitter: (tx.from as Hex) ?? null,
          txHash: tx.hash as Hex,
          blockNumber,
        });
      } else if (equalBytes(existing.envelopeDigest, digest)) {
        existing.duplicateCount += 1n;
      } else {
        conflicts.push({ seq: fields.seq, envelopeDigest: digest, txHash: tx.hash as Hex, blockNumber });
      }
    }
  }

  const sorted = [...anchors.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  return {
    source: "chain",
    description: `raw block scan of ${options.contract} over blocks ${options.fromBlock}..${head} via ${options.rpcUrl}`,
    streamId: options.streamId,
    anchors: sorted,
    conflicts,
    malformed,
    pinnedBlock: head,
    attestation: null,
  };
}

/** Exposed for tests: the digest of an envelope as the scanner computes it. */
export function scannerEnvelopeDigest(payload: Uint8Array): Hex {
  return toHex(keccak256(payload));
}
