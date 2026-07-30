import { PostAnchorCall } from "../generated/AnchorDataEdge/AnchorDataEdge";
import { MODE_BREAK_CHAIN_AT_SEQ_FIVE, indexAnchorCall } from "./anchor";

/**
 * TEST FIXTURE — a server that rewrites one anchor's backward link (seq 5) and
 * keeps the row internally consistent, so only the hash-chain check can catch
 * it. Local-only, never published.
 */
export function handlePostAnchor(call: PostAnchorCall): void {
  indexAnchorCall(call, MODE_BREAK_CHAIN_AT_SEQ_FIVE);
}
