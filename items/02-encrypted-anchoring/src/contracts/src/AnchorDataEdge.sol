// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.12;

/// Anchor Data Edge: stores nothing, executes nothing, emits nothing.
/// Anchors live entirely in calldata; a subgraph gives them meaning.
///
/// Shape precedent: GIP-0025 "DataEdge" (GRC-0001). Deliberate deviation from
/// the canonical fallback-only shape: a real named function, so the selector is
/// self-documenting on explorers and the call handler matches a signature the
/// contract actually implements. No storage, no events, no owner, non-payable.
contract AnchorDataEdge {
    function postAnchor(bytes calldata) external {
        // no-op
    }
}
