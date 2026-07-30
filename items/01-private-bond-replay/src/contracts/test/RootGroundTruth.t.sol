// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateBond} from "poc/PrivateBond.sol";
import {PoseidonT3} from "poc/PoseidonT3.sol";
import {MockVerifier} from "../src/MockVerifier.sol";

/// @notice Generates the ground-truth vectors the Rust replay CLI is tested
/// against (spec.md §7, "Root algorithm vs ground truth").
///
/// The authority for both the tree algorithm and the pairwise hash is the
/// deployed EthSystems contract, not our reimplementation. This test drives
/// `PrivateBond.buildMerkleRoot()` over 1..12 leaves — covering both parities
/// and several odd-leaf duplication edges — and writes the results to
/// build/fixtures/root-vectors.json. The Rust implementation must reproduce
/// every vector; see src/replay/tests/root_ground_truth.rs.
contract RootGroundTruthTest is Test {
    uint256 constant BN254_F =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// Largest leaf count generated. 12 exceeds the circuit's 8-leaf cap on
    /// purpose: the contract's own tree algorithm has no such cap, and the
    /// replay CLI reimplements the contract, not the circuit.
    uint256 constant MAX_LEAVES = 12;

    PrivateBond internal bond;

    function setUp() public {
        // `vm.writeJson` does not create parent directories, and on a clean
        // checkout `build/fixtures/` does not exist yet — so without this the
        // two fixture-writing tests fail with ENOENT and take the whole
        // downstream pipeline with them (the Rust suite reads what they write).
        // Creating it here keeps `forge test` self-sufficient rather than
        // relying on a setup step a reader has to know about.
        vm.createDir("../../build/fixtures", true);

        MockVerifier verifier = new MockVerifier();
        bond = new PrivateBond(keccak256("ground-truth"), address(verifier), address(this));
    }

    /// Deterministic in-field leaf values. Reduced mod the BN254 order here so
    /// the Rust side compares against exactly the value the contract hashed,
    /// with no implicit reduction on either side.
    function _leaf(uint256 i) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encodePacked("graph-privacy-showcase/leaf", i))) % BN254_F);
    }

    function test_writeRootVectors() public {
        string memory obj = "root-vectors";
        string memory json;

        for (uint256 n = 1; n <= MAX_LEAVES; n++) {
            bond.mint(_leaf(n - 1));

            bytes32[] memory leaves = new bytes32[](n);
            for (uint256 i = 0; i < n; i++) {
                leaves[i] = _leaf(i);
                assertEq(bond.commitments(i), leaves[i], "leaf mismatch in storage");
            }

            bytes32 root = bond.buildMerkleRoot();
            assertTrue(bond.knownRoots(root), "root not recorded by contract");

            string memory caseObj = string.concat("case", vm.toString(n));
            vm.serializeUint(caseObj, "leafCount", n);
            vm.serializeBytes32(caseObj, "leaves", leaves);
            string memory caseJson = vm.serializeBytes32(caseObj, "root", root);

            json = vm.serializeString(obj, vm.toString(n), caseJson);
        }

        vm.writeJson(json, "../../build/fixtures/root-vectors.json");
    }

    /// Pairwise-hash vectors. Isolates "does the Rust Poseidon match the
    /// contract's PoseidonT3" from "does the Rust tree shape match", so a
    /// failure in the tree test points at the tree and not at the hash.
    function test_writePoseidonPairVectors() public {
        string memory obj = "poseidon-pairs";
        string memory json;

        uint256[13] memory lefts = [
            uint256(0), 0, 1, 1, 100, 200, 12345, 0, 1, 7, 99, 2, 3
        ];
        uint256[13] memory rights = [
            uint256(0), 1, 0, 1, 200, 100, 67890, BN254_F - 1, BN254_F - 1, 7, 1, 3, 2
        ];

        for (uint256 i = 0; i < lefts.length; i++) {
            uint256 h = PoseidonT3.hash([lefts[i], rights[i]]);

            string memory caseObj = string.concat("pair", vm.toString(i));
            vm.serializeUint(caseObj, "left", lefts[i]);
            vm.serializeUint(caseObj, "right", rights[i]);
            string memory caseJson = vm.serializeUint(caseObj, "hash", h);

            json = vm.serializeString(obj, vm.toString(i), caseJson);
        }

        vm.writeJson(json, "../../build/fixtures/poseidon-pair-vectors.json");
    }

    /// The odd-leaf rule the CLI must copy: an unpaired node is hashed with
    /// itself, not with a zero sibling. Asserted directly against the contract
    /// so the rule is pinned by behaviour rather than by reading the source.
    function test_oddLeafIsDuplicatedNotZeroPadded() public {
        bytes32 a = _leaf(0);
        bytes32 b = _leaf(1);
        bytes32 c = _leaf(2);

        bond.mint(a);
        bond.mint(b);
        bond.mint(c);

        bytes32 ab = bytes32(PoseidonT3.hash([uint256(a), uint256(b)]));
        bytes32 cc = bytes32(PoseidonT3.hash([uint256(c), uint256(c)]));
        bytes32 expectedDuplicated = bytes32(PoseidonT3.hash([uint256(ab), uint256(cc)]));

        bytes32 cZero = bytes32(PoseidonT3.hash([uint256(c), uint256(0)]));
        bytes32 wouldBeZeroPadded = bytes32(PoseidonT3.hash([uint256(ab), uint256(cZero)]));

        assertEq(bond.buildMerkleRoot(), expectedDuplicated, "odd leaf must duplicate itself");
        assertTrue(bond.buildMerkleRoot() != wouldBeZeroPadded, "zero-padding must not match");
    }
}
