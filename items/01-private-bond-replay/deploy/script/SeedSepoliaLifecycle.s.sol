// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateBond} from "poc/PrivateBond.sol";

/// @notice Phase 1 of the canonical seed: the four pre-maturity anchor-writing
/// entry points — mint, mintBatch, transfer, atomicSwap. Six leaves.
///
/// Split from the burn leg because `atomicSwap` reverts once the bond has
/// matured and `burn` reverts before it has. Locally the driver warps the
/// node's clock between the two; on a public chain there is no warp, so the
/// canonical run picks a real maturity shortly after deploy, runs this
/// immediately, and waits for the wall clock before phase 2.
///
/// All arguments come from artifacts/lifecycle.json, produced by
/// `bond-replay seed-fixtures --maturity <ts>`. Poseidon lives in exactly one
/// implementation (Rust, the crate the PoC wallet pins); this script only
/// broadcasts.
///
/// The `proof` arguments are deterministic placeholder bytes. They are NOT
/// proofs and no artifact may present them as such; under MockVerifier they
/// are never inspected. They are non-empty so the subgraph's proof-digest
/// decode path sees real calldata.
contract SeedSepoliaLifecycleScript is Script {
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
            block.timestamp < maturity,
            "chain clock is already past maturity: atomicSwap would revert. Re-seed with a later maturity."
        );

        // Bind the fixtures to this deployment. Maturity is an input to every
        // commitment, so fixtures generated for a different maturity would
        // produce an entirely wrong anchor log — and the mismatch would only
        // surface much later, during reconciliation. bondId is the cheap
        // proxy: it is set at construction and it comes from the same
        // generator run as the commitments.
        require(
            bond.bondId() == vm.parseJsonBytes32(json, ".bondId"),
            "deployed bondId != fixtures bondId: wrong deployment, or fixtures regenerated since deploy"
        );

        bytes memory proof = vm.parseJsonBytes(json, ".proofPlaceholder");

        vm.startBroadcast();

        // 1 — mint: the global note tranche. 1 leaf.
        bond.mint(vm.parseJsonBytes32(json, ".mint.commitment"));

        // 2 — mintBatch: the zero-value auxiliary note. 1 leaf.
        bond.mintBatch(vm.parseJsonBytes32Array(json, ".mintBatch.commitments"));

        // 3 — transfer: spend [global, aux] into investor A + issuer change.
        //     2 leaves, 2 nullifiers.
        bond.transfer(
            proof,
            vm.parseJsonBytes32(json, ".transfer.root"),
            _pair(vm.parseJsonBytes32Array(json, ".transfer.nullifiersIn")),
            _pair(vm.parseJsonBytes32Array(json, ".transfer.commitmentsOut"))
        );

        // 4 — atomicSwap: the A<->B trade leg. 2 leaves, 2 nullifiers.
        //     Public-input layout [0]=root, [1]=nullifier, [2]=commitment,
        //     [3]=maturity, per EthSystems' own tests.
        bond.atomicSwap(
            proof,
            vm.parseJsonBytes32Array(json, ".atomicSwap.publicInputsA"),
            proof,
            vm.parseJsonBytes32Array(json, ".atomicSwap.publicInputsB")
        );

        vm.stopBroadcast();

        console.log("phase 1 complete. maturity (unix):", maturity);
        console.log("burn is runnable at/after that timestamp; wait, then run SeedSepoliaBurn.");
    }

    function _pair(bytes32[] memory xs) internal pure returns (bytes32[2] memory out) {
        require(xs.length == 2, "expected exactly 2 elements");
        out[0] = xs[0];
        out[1] = xs[1];
    }
}
