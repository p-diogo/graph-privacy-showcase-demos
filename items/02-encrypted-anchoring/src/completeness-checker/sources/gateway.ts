import { fetchServedIndex, type GraphQlResult } from "./graphql.js";

/**
 * Network serving through the decentralized gateway.
 *
 * STATUS: NOT EXERCISED. This build tranche is local-only — no subgraph has
 * been published to the network, no gateway request has been made, and no
 * attestation has been captured. The code below is written to the documented
 * contract (POST GraphQL, `graph-attestation` response header) and is the
 * shape the network leg will run, but nothing in this repo has observed it
 * working. Treat every claim about network serving as pending until the
 * smoke gate in spec §4.6 runs and REPRODUCE.md step 9 is executed.
 *
 * What this mode does and does not do when it runs:
 *  - records the raw `graph-attestation` header alongside the response bytes;
 *  - does NOT verify the attestation signature or resolve the signer to an
 *    indexer — that is item 01's deliverable and is reused, not duplicated;
 *  - an attestation is a signature over request/response bytes bound to a
 *    staked allocation. It is not a validity proof, and a response with a
 *    perfectly valid attestation can still be wrong. What makes it useful is
 *    that it is non-repudiable and economically backed.
 */
export interface GatewayOptions {
  /** Full query URL, e.g. https://gateway.thegraph.com/api/subgraphs/id/<id> */
  url: string;
  apiKey: string;
  streamId: Uint8Array;
  block: bigint | null;
}

export const GATEWAY_UNEXERCISED_NOTICE =
  "gateway mode has never been exercised in this build: no network publish, no gateway request, no attestation captured";

export async function fetchFromGateway(options: GatewayOptions): Promise<GraphQlResult> {
  return fetchServedIndex({
    endpoint: options.url,
    streamId: options.streamId,
    block: options.block,
    headers: { authorization: `Bearer ${options.apiKey}` },
    source: "gateway",
    description: `gateway ${options.url} (attestation recorded, not verified here)`,
  });
}
