// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.12;

import {Script, console} from "forge-std/Script.sol";
import {AnchorDataEdge} from "../src/AnchorDataEdge.sol";

/// Deploys the anchor contract and prints the two values the subgraph manifest
/// needs pinned: address and deployment block.
///
/// Usage (local harness):
///   forge script script/DeployAnchorDataEdge.s.sol:DeployAnchorDataEdge \
///     --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast
contract DeployAnchorDataEdge is Script {
    function run() external returns (address edge, uint256 deployBlock) {
        vm.startBroadcast();
        AnchorDataEdge deployed = new AnchorDataEdge();
        vm.stopBroadcast();

        edge = address(deployed);
        deployBlock = block.number;

        console.log("ANCHOR_DATA_EDGE_ADDRESS=%s", edge);
        console.log("ANCHOR_DATA_EDGE_START_BLOCK=%s", deployBlock);
    }
}
