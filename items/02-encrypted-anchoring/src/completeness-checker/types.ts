import type { Hex } from "../anchor-core/index.js";

export type SourceKind = "local" | "gateway" | "chain";

export interface ServedAnchor {
  seq: bigint;
  ciphertextDigest: Uint8Array;
  prevEnvelopeDigest: Uint8Array;
  envelopeDigest: Uint8Array;
  duplicateCount: bigint;
  submitter: Hex | null;
  txHash: Hex | null;
  blockNumber: bigint | null;
}

export interface ServedConflict {
  seq: bigint;
  envelopeDigest: Uint8Array;
  txHash: Hex | null;
  blockNumber: bigint | null;
}

export interface ServedMalformed {
  reason: string;
  payloadLength: number | null;
  txHash: Hex | null;
  blockNumber: bigint | null;
}

/**
 * What a source says the chain contains for one stream. Every source — a
 * network gateway, a local graph-node, or a raw block scan — produces this
 * same shape, so the verdict engine never knows which one it is checking.
 */
export interface ServedIndex {
  source: SourceKind;
  description: string;
  streamId: Uint8Array;
  anchors: ServedAnchor[];
  conflicts: ServedConflict[];
  malformed: ServedMalformed[];
  /** Block the answer is pinned to, when the source can pin one. */
  pinnedBlock: bigint | null;
  /**
   * Raw `graph-attestation` header, when the gateway returned one. This item
   * records attestations; verifying them (EIP-712 recovery against the
   * indexer's allocation) is item 01's deliverable and is not re-implemented
   * here. An attestation is a signature, not a validity proof.
   */
  attestation: string | null;
}
