import { fromHex, toHex, type Hex } from "../../anchor-core/bytes.js";
import type { ServedAnchor, ServedConflict, ServedIndex, ServedMalformed, SourceKind } from "../types.js";

const PAGE_SIZE = 1000;

export interface GraphQlSourceOptions {
  endpoint: string;
  streamId: Uint8Array;
  /** Block to pin every entity query to. Runs without one are not reproducible. */
  block: bigint | null;
  headers?: Record<string, string>;
  source: SourceKind;
  description: string;
}

interface RawAnchor {
  seq: string;
  ciphertextDigest: string;
  prevEnvelopeDigest: string;
  envelopeDigest: string;
  duplicateCount: string;
  submitter: string | null;
  txHash: string | null;
  blockNumber: string | null;
}

interface RawConflict {
  seq: string;
  envelopeDigest: string;
  txHash: string | null;
  blockNumber: string | null;
}

interface RawMalformed {
  reason: string;
  payloadLength: string | null;
  txHash: string | null;
  blockNumber: string | null;
}

function blockArg(block: bigint | null): string {
  return block === null ? "" : `, block: { number: ${block} }`;
}

function buildQuery(block: bigint | null): string {
  return `query Anchors($streamId: Bytes!, $first: Int!, $skip: Int!) {
  anchors(
    where: { stream: $streamId }
    orderBy: seq
    orderDirection: asc
    first: $first
    skip: $skip${blockArg(block)}
  ) {
    seq
    ciphertextDigest
    prevEnvelopeDigest
    envelopeDigest
    duplicateCount
    submitter
    txHash
    blockNumber
  }
  conflictingAnchors(
    where: { stream: $streamId }
    orderBy: seq
    orderDirection: asc
    first: $first
    skip: $skip${blockArg(block)}
  ) {
    seq
    envelopeDigest
    txHash
    blockNumber
  }
  malformedAnchors(first: $first, skip: $skip${blockArg(block)}) {
    reason
    payloadLength
    txHash
    blockNumber
  }
}`;
}

export interface GraphQlResult {
  index: ServedIndex;
  /** Raw response bodies, in page order — evidence a verifier can re-inspect. */
  responses: string[];
}

export async function fetchServedIndex(options: GraphQlSourceOptions): Promise<GraphQlResult> {
  const anchors: ServedAnchor[] = [];
  const conflicts: ServedConflict[] = [];
  const malformed: ServedMalformed[] = [];
  const responses: string[] = [];
  let attestation: string | null = null;

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const body = JSON.stringify({
      query: buildQuery(options.block),
      variables: { streamId: toHex(options.streamId), first: PAGE_SIZE, skip },
    });

    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body,
    });

    const text = await response.text();
    responses.push(text);
    if (!response.ok) {
      throw new Error(`${options.source} source: HTTP ${response.status} from ${options.endpoint}: ${text.slice(0, 400)}`);
    }
    // Recorded, not verified: attestation verification is item 01's deliverable.
    attestation = attestation ?? response.headers.get("graph-attestation");

    const parsed = JSON.parse(text) as {
      data?: { anchors: RawAnchor[]; conflictingAnchors: RawConflict[]; malformedAnchors: RawMalformed[] };
      errors?: { message: string }[];
    };
    if (parsed.errors && parsed.errors.length > 0) {
      throw new Error(`${options.source} source: GraphQL errors: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    if (!parsed.data) throw new Error(`${options.source} source: response contained no data`);

    for (const raw of parsed.data.anchors) {
      anchors.push({
        seq: BigInt(raw.seq),
        ciphertextDigest: fromHex(raw.ciphertextDigest),
        prevEnvelopeDigest: fromHex(raw.prevEnvelopeDigest),
        envelopeDigest: fromHex(raw.envelopeDigest),
        duplicateCount: BigInt(raw.duplicateCount),
        submitter: (raw.submitter as Hex) ?? null,
        txHash: (raw.txHash as Hex) ?? null,
        blockNumber: raw.blockNumber === null ? null : BigInt(raw.blockNumber),
      });
    }
    for (const raw of parsed.data.conflictingAnchors) {
      conflicts.push({
        seq: BigInt(raw.seq),
        envelopeDigest: fromHex(raw.envelopeDigest),
        txHash: (raw.txHash as Hex) ?? null,
        blockNumber: raw.blockNumber === null ? null : BigInt(raw.blockNumber),
      });
    }
    for (const raw of parsed.data.malformedAnchors) {
      malformed.push({
        reason: raw.reason,
        payloadLength: raw.payloadLength === null ? null : Number(raw.payloadLength),
        txHash: (raw.txHash as Hex) ?? null,
        blockNumber: raw.blockNumber === null ? null : BigInt(raw.blockNumber),
      });
    }

    const pageFull =
      parsed.data.anchors.length === PAGE_SIZE ||
      parsed.data.conflictingAnchors.length === PAGE_SIZE ||
      parsed.data.malformedAnchors.length === PAGE_SIZE;
    if (!pageFull) break;
  }

  return {
    index: {
      source: options.source,
      description: options.description,
      streamId: options.streamId,
      anchors: anchors.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)),
      conflicts,
      malformed,
      pinnedBlock: options.block,
      attestation,
    },
    responses,
  };
}
