// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateBond} from "poc/PrivateBond.sol";
import {MockVerifier} from "item01/MockVerifier.sol";

/// @notice Canonical Sepolia deployment of EthSystems' unmodified PrivateBond.
///
/// The contract deployed is theirs, byte-for-byte, at the pinned SHA
/// (src/poc/PIN). Only the deploy script is ours, for the same two reasons as
/// the local one: their `PrivateBond.s.sol` hardcodes the real `HonkVerifier`
/// and a bondId of `keccak256("US0378331005")` — a real Apple ISIN — so it can
/// express neither choice this item requires.
///
/// WHY MockVerifier, stated plainly and repeated in every artifact:
///
///   1. Spec §4.2 pre-decides it as the default, and it is the same contract
///      EthSystems use in their own Foundry tests (`MockVerifier` returning
///      true, empty proof bytes). Real-proof on-chain verification is not
///      exercised anywhere in their repo.
///   2. It is not merely unexercised, it is currently unsatisfiable. Their
///      bundled `Verifier.sol` declares `publicInputsSize = 21` with
///      `PAIRING_POINTS_SIZE = 16`, so `verify()` requires exactly 5 public
///      inputs, while the current `circuits/src/main.nr` declares 8 public
///      values. The bundled verifier and the current circuit are not from the
///      same revision. This is an internal finding about their PoC's maturity
///      (BUILD-REPORT §3.5) and MUST NOT appear in any external artifact.
///   3. Nothing this item claims depends on proof validity. Anchors land in
///      storage and calldata whether or not a proof verifies; our subject is
///      the read and audit leg, not their proving leg.
///
/// What this therefore does NOT demonstrate: that the PoC's ZK layer works.
/// No demo script, report, or conversation may present it as such.
///
/// The `proof` arguments carried by the seed scripts are placeholder bytes.
/// They are not proofs. Under MockVerifier they are never inspected.
contract DeploySepoliaScript is Script {
    /// Guard against fat-fingering the wrong chain. Overridable so the kit can
    /// be dry-run against anvil — a dry run has to say out loud that it is not
    /// Sepolia rather than silently pass.
    uint256 constant SEPOLIA = 11155111;

    function run() external {
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", SEPOLIA);
        require(
            block.chainid == expectedChainId,
            "chain id mismatch: refusing to deploy (set EXPECTED_CHAIN_ID for a dry run)"
        );

        string memory artifactDir = vm.envOr("ARTIFACT_DIR", string("./artifacts"));
        string memory bondIdString = vm.envOr("BOND_ID_STRING", string("XF0000000001"));
        bytes32 bondId = keccak256(bytes(bondIdString));

        vm.startBroadcast();
        MockVerifier verifier = new MockVerifier();
        PrivateBond bond = new PrivateBond(bondId, address(verifier), msg.sender);
        vm.stopBroadcast();

        require(address(bond) != address(0), "PrivateBond deployment failed");
        require(bond.bondId() == bondId, "bondId not set");

        console.log("PrivateBond  :", address(bond));
        console.log("MockVerifier :", address(verifier));
        console.log("owner        :", msg.sender);
        console.log("bondIdString :", bondIdString);
        console.log("chainId      :", block.chainid);
        // Deliberately not logging or recording a deploy block here.
        // `block.number` in a script is the *simulation* block, not the block
        // the transaction landed in — on a fresh chain it reads 0, and a
        // subgraph startBlock of 0 would index Sepolia from genesis.
        // 01-deploy.sh fills `deployBlock` in from the receipt.

        string memory obj = "deployment";
        vm.serializeAddress(obj, "privateBond", address(bond));
        vm.serializeAddress(obj, "verifier", address(verifier));
        vm.serializeAddress(obj, "owner", msg.sender);
        vm.serializeString(obj, "verifierKind", "MockVerifier");
        vm.serializeString(
            obj,
            "verifierNote",
            "MockVerifier always returns true. This deployment is NOT evidence that the PoC's ZK layer works."
        );
        vm.serializeString(obj, "bondIdString", bondIdString);
        vm.serializeBytes32(obj, "bondId", bondId);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory out = vm.serializeString(obj, "pocSha", "94f1e5c94b6c4896977ae68094b99479eef4c371");

        vm.writeJson(out, string.concat(artifactDir, "/deployment.json"));
        console.log("wrote        :", string.concat(artifactDir, "/deployment.json"));
    }
}
