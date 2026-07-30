// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateBond} from "poc/PrivateBond.sol";

/// @notice Drives the first four of the five anchor-writing entry points
/// (spec §4.2): mint, mintBatch, transfer, atomicSwap.
///
/// The burn leg lives in SeedBurn.s.sol because it requires the chain clock to
/// be past maturity, and the time warp between the two is a node-level RPC
/// call the driver script makes (see src/seed/seed-local.sh).
///
/// All arguments come from build/lifecycle.json, produced by
/// `bond-replay seed-fixtures`. Poseidon lives in exactly one implementation
/// (Rust, the same crate the PoC wallet uses); this script only broadcasts.
///
/// The `proof` arguments are deterministic placeholder bytes. They are NOT
/// proofs and no artifact may present them as such; under MockVerifier they
/// are never inspected. They are non-empty so the subgraph's proof-digest
/// decode path sees real calldata.
contract SeedLifecycleScript is Script {
    function run() external {
        string memory json = vm.readFile("../../build/lifecycle.json");
        address bondAddr = vm.parseJsonAddress(
            vm.readFile("../../build/deployment.json"),
            ".privateBond"
        );
        PrivateBond bond = PrivateBond(bondAddr);

        bytes memory proof = vm.parseJsonBytes(json, ".proofPlaceholder");

        vm.startBroadcast();

        // 1 — mint: the global note tranche. 1 leaf.
        bytes32 mintCommitment = vm.parseJsonBytes32(json, ".mint.commitment");
        bond.mint(mintCommitment);
        console.log("mint          leaves ->", bond.commitments(0) == mintCommitment ? 1 : 0);

        // 2 — mintBatch: the zero-value auxiliary note. 1 leaf.
        bytes32[] memory batch = vm.parseJsonBytes32Array(json, ".mintBatch.commitments");
        bond.mintBatch(batch);

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

        console.log("leaves after four calls: 6 expected, got", _leafCount(bond));
    }

    function _pair(bytes32[] memory xs) internal pure returns (bytes32[2] memory out) {
        require(xs.length == 2, "expected exactly 2 elements");
        out[0] = xs[0];
        out[1] = xs[1];
    }

    function _leafCount(PrivateBond bond) internal view returns (uint256 n) {
        while (true) {
            try bond.commitments(n) returns (bytes32) {
                n++;
            } catch {
                return n;
            }
        }
    }
}
