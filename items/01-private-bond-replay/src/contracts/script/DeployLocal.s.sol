// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateBond} from "poc/PrivateBond.sol";
import {MockVerifier} from "../src/MockVerifier.sol";

/// @notice Deploys EthSystems' unmodified PrivateBond against MockVerifier.
///
/// This is our script, not theirs. Their own script
/// (contracts/script/PrivateBond.s.sol at the pin) hardcodes both the verifier
/// (real HonkVerifier) and the bondId (keccak256 of a real Apple ISIN), so it
/// cannot express either choice this item requires: the spec's pre-decided
/// MockVerifier default (spec §4.2) and a clearly-fictional bond identifier.
/// The *contract* deployed is theirs, byte-for-byte, at the pinned SHA.
///
/// BOND_ID_STRING defaults to a deliberately fictional ISIN-format string.
/// "XF" is not an ISO 3166-1 alpha-2 country code, so it cannot collide with
/// any issued ISIN.
contract DeployLocalScript is Script {
    function run() external {
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

        string memory obj = "deployment";
        vm.serializeAddress(obj, "privateBond", address(bond));
        vm.serializeAddress(obj, "verifier", address(verifier));
        vm.serializeAddress(obj, "owner", msg.sender);
        vm.serializeString(obj, "verifierKind", "MockVerifier");
        vm.serializeString(obj, "bondIdString", bondIdString);
        vm.serializeBytes32(obj, "bondId", bondId);
        vm.serializeUint(obj, "deployBlock", block.number);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory out = vm.serializeString(
            obj,
            "pocSha",
            "94f1e5c94b6c4896977ae68094b99479eef4c371"
        );

        vm.writeJson(out, "../../build/deployment.json");
    }
}
