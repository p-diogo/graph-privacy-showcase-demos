// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateBond} from "poc/PrivateBond.sol";

/// @notice The fifth anchor-writing entry point: post-maturity burn.
/// Appends the two zero-value output commitments the manifest classes as
/// `burn-output-zero` — structural artifacts of the contract's 2-in/2-out
/// shape, not disclosed records.
///
/// Requires block.timestamp >= maturity; the driver warps the local chain
/// clock before running this.
contract SeedBurnScript is Script {
    function run() external {
        string memory json = vm.readFile("../../build/lifecycle.json");
        address bondAddr = vm.parseJsonAddress(
            vm.readFile("../../build/deployment.json"),
            ".privateBond"
        );
        PrivateBond bond = PrivateBond(bondAddr);

        uint256 maturity = vm.parseJsonUint(json, ".maturityDate");
        require(
            block.timestamp >= maturity,
            "chain clock is before maturity: warp the node first"
        );

        vm.startBroadcast();
        bond.burn(
            vm.parseJsonBytes(json, ".proofPlaceholder"),
            vm.parseJsonBytes32(json, ".burn.root"),
            _pair(vm.parseJsonBytes32Array(json, ".burn.nullifiersIn")),
            _pair(vm.parseJsonBytes32Array(json, ".burn.commitmentsOut")),
            bytes32(maturity),
            bytes32(uint256(1))
        );
        vm.stopBroadcast();

        console.log("burn complete at timestamp", block.timestamp);
    }

    function _pair(bytes32[] memory xs) internal pure returns (bytes32[2] memory out) {
        require(xs.length == 2, "expected exactly 2 elements");
        out[0] = xs[0];
        out[1] = xs[1];
    }
}
