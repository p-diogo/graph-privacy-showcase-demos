// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateBond} from "poc/PrivateBond.sol";

/// @notice Phase 2 of the canonical seed: the fifth anchor-writing entry
/// point, post-maturity `burn`. Appends the two zero-value output commitments
/// the manifest classes as `burn-output-zero` — structural artefacts of the
/// contract's 2-in/2-out shape, not disclosed records.
///
/// Requires `block.timestamp >= maturity`. On a public chain that means
/// waiting; there is no warp. Run this only after phase 1 has confirmed.
contract SeedSepoliaBurnScript is Script {
    uint256 constant SEPOLIA = 11155111;

    function run() external {
        require(
            block.chainid == vm.envOr("EXPECTED_CHAIN_ID", SEPOLIA),
            "chain id mismatch: refusing to seed (set EXPECTED_CHAIN_ID for a dry run)"
        );

        string memory artifactDir = vm.envOr("ARTIFACT_DIR", string("./artifacts"));
        string memory json = vm.readFile(string.concat(artifactDir, "/lifecycle.json"));
        address bondAddr =
            vm.parseJsonAddress(vm.readFile(string.concat(artifactDir, "/deployment.json")), ".privateBond");
        PrivateBond bond = PrivateBond(bondAddr);

        uint256 maturity = vm.parseJsonUint(json, ".maturityDate");
        require(
            block.timestamp >= maturity,
            "chain clock is before maturity: wait for it. Nothing is wrong; the bond has not matured yet."
        );
        require(
            bond.bondId() == vm.parseJsonBytes32(json, ".bondId"),
            "deployed bondId != fixtures bondId: wrong deployment, or fixtures regenerated since deploy"
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
        console.log("the anchor log is now 8 leaves across all five entry points");
    }

    function _pair(bytes32[] memory xs) internal pure returns (bytes32[2] memory out) {
        require(xs.length == 2, "expected exactly 2 elements");
        out[0] = xs[0];
        out[1] = xs[1];
    }
}
