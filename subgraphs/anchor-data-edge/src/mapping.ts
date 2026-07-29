import { PostAnchorCall } from "../generated/AnchorDataEdge/AnchorDataEdge";
import { MODE_HONEST, indexAnchorCall } from "./anchor";

/** The real index. This is the only mapping that is ever deployed. */
export function handlePostAnchor(call: PostAnchorCall): void {
  indexAnchorCall(call, MODE_HONEST);
}
