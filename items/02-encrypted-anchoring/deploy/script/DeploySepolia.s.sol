// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.12;

import {Script, console} from "forge-std/Script.sol";
import {AnchorDataEdge} from "item02/AnchorDataEdge.sol";

/// @notice Canonical Sepolia deployment of the anchor contract.
///
/// `AnchorDataEdge` stores nothing, executes nothing, emits nothing: anchors
/// live entirely in calldata and a subgraph gives them meaning. That is the
/// GRC-0001 "Data Edge" shape, with one deliberate deviation — a real named
/// `postAnchor(bytes)` instead of fallback + phantom selector (spec §4.1).
///
/// Two properties of this contract that the runbook depends on:
///
///   1. It is permissionless. Anyone can call `postAnchor` with any payload.
///      That is by design — the index reports what the chain contains and the
///      checker adjudicates — but it means the canonical stream can be
///      polluted by a third party who holds the stream key. Which is why the
///      canonical keyfile stays out of this repository until the disclosure
///      bundle is deliberately published.
///   2. It holds no funds and has no owner, so there is nothing to strand and
///      nothing to rotate. A bad deployment is abandoned, not recovered.
contract DeploySepoliaScript is Script {
    uint256 constant SEPOLIA = 11155111;

    function run() external {
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", SEPOLIA);
        require(
            block.chainid == expectedChainId,
            "chain id mismatch: refusing to deploy (set EXPECTED_CHAIN_ID for a dry run)"
        );

        string memory artifactDir = vm.envOr("ARTIFACT_DIR", string("./artifacts"));

        vm.startBroadcast();
        AnchorDataEdge deployed = new AnchorDataEdge();
        vm.stopBroadcast();

        require(address(deployed) != address(0), "AnchorDataEdge deployment failed");

        console.log("AnchorDataEdge :", address(deployed));
        console.log("chainId        :", block.chainid);
        console.log("selector       : postAnchor(bytes) = 0x330a5405");
        // No deploy block recorded here on purpose: `block.number` in a script
        // is the simulation block, not the block the transaction landed in.
        // 01-deploy.sh fills `deployBlock` in from the receipt, because a
        // subgraph startBlock of 0 would index Sepolia from genesis.

        string memory obj = "deployment";
        vm.serializeAddress(obj, "anchorDataEdge", address(deployed));
        vm.serializeAddress(obj, "deployer", msg.sender);
        vm.serializeString(obj, "selector", "0x330a5405");
        string memory out = vm.serializeUint(obj, "chainId", block.chainid);

        vm.writeJson(out, string.concat(artifactDir, "/deployment.json"));
        console.log("wrote          :", string.concat(artifactDir, "/deployment.json"));
    }
}
