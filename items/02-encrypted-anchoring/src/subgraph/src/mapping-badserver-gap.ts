import { PostAnchorCall } from "../generated/AnchorDataEdge/AnchorDataEdge";
import { MODE_DROP_EVERY_FOURTH, indexAnchorCall } from "./anchor";

/**
 * TEST FIXTURE — a deliberately incomplete server that withholds every fourth
 * anchor. Deployed only to a local graph-node, so the completeness checker has
 * a real bad index to catch (spec §7: never tamper-test a stranger's infra).
 */
export function handlePostAnchor(call: PostAnchorCall): void {
  indexAnchorCall(call, MODE_DROP_EVERY_FOURTH);
}
