// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateBond} from "poc/PrivateBond.sol";
import {MockVerifier} from "../src/MockVerifier.sol";

/// @notice Pins the anchor semantics the subgraph and the replay CLI depend
/// on, by behaviour rather than by reading EthSystems' source.
///
/// Everything the read path claims rests on three facts about their contract:
/// the commitment array is append-only and globally ordered, every
/// anchor-appending call records a new root in `knownRoots`, and no event is
/// ever emitted. If an upstream change breaks any of them, this suite fails
/// before the subgraph silently starts serving a wrong anchor log.
contract PrivateBondAnchorsTest is Test {
    PrivateBond internal bond;
    MockVerifier internal verifier;

    bytes32 constant BOND_ID = keccak256("XF0000000001");
    uint256 constant MATURITY = 1893459600;

    // Placeholder calldata for the proof parameter. Under MockVerifier this is
    // never checked. It is NOT a proof and nothing may present it as one; it
    // exists so the subgraph's proof-digest decode path sees non-empty bytes.
    bytes constant PROOF_PLACEHOLDER = hex"deadbeefcafe";

    function setUp() public {
        verifier = new MockVerifier();
        bond = new PrivateBond(BOND_ID, address(verifier), address(this));
        vm.warp(MATURITY - 3600);
    }

    function test_contractEmitsNoEvents() public {
        // The whole call-handler design (spec §4.3) exists because of this.
        vm.recordLogs();

        bond.mint(bytes32(uint256(1)));
        bytes32[] memory batch = new bytes32[](1);
        batch[0] = bytes32(uint256(2));
        bond.mintBatch(batch);

        bytes32 root = bond.buildMerkleRoot();
        bond.transfer(
            PROOF_PLACEHOLDER,
            root,
            [bytes32(uint256(101)), bytes32(uint256(102))],
            [bytes32(uint256(3)), bytes32(uint256(4))]
        );

        assertEq(vm.getRecordedLogs().length, 0, "PrivateBond must emit no events");
    }

    function test_bondIdIsSetAtConstructionAndStable() public view {
        assertEq(bond.bondId(), BOND_ID);
    }

    function test_mintAppendsOneLeafAndRecordsRoot() public {
        bond.mint(bytes32(uint256(11)));

        assertEq(bond.commitments(0), bytes32(uint256(11)));
        assertTrue(bond.knownRoots(bond.buildMerkleRoot()));
        vm.expectRevert();
        bond.commitments(1);
    }

    function test_mintBatchAppendsInArrayOrder() public {
        bytes32[] memory batch = new bytes32[](3);
        batch[0] = bytes32(uint256(21));
        batch[1] = bytes32(uint256(22));
        batch[2] = bytes32(uint256(23));
        bond.mintBatch(batch);

        assertEq(bond.commitments(0), bytes32(uint256(21)));
        assertEq(bond.commitments(1), bytes32(uint256(22)));
        assertEq(bond.commitments(2), bytes32(uint256(23)));
    }

    /// The full five-entry-point lifecycle, in the order the seed script runs
    /// it, asserting the exact 8-leaf / 6-nullifier anchor log the CLI
    /// reconciles against.
    function test_fullLifecycleAnchorLog() public {
        bond.mint(bytes32(uint256(31)));

        bytes32[] memory batch = new bytes32[](1);
        batch[0] = bytes32(uint256(32));
        bond.mintBatch(batch);

        bytes32 rootAfterMints = bond.buildMerkleRoot();
        bond.transfer(
            PROOF_PLACEHOLDER,
            rootAfterMints,
            [bytes32(uint256(201)), bytes32(uint256(202))],
            [bytes32(uint256(33)), bytes32(uint256(34))]
        );

        bytes32 rootAfterTransfer = bond.buildMerkleRoot();
        bytes32[] memory piA = new bytes32[](4);
        piA[0] = rootAfterTransfer;
        piA[1] = bytes32(uint256(203));
        piA[2] = bytes32(uint256(35));
        piA[3] = bytes32(MATURITY);
        bytes32[] memory piB = new bytes32[](4);
        piB[0] = rootAfterTransfer;
        piB[1] = bytes32(uint256(204));
        piB[2] = bytes32(uint256(36));
        piB[3] = bytes32(MATURITY);
        bond.atomicSwap(PROOF_PLACEHOLDER, piA, PROOF_PLACEHOLDER, piB);

        bytes32 rootAfterSwap = bond.buildMerkleRoot();
        vm.warp(MATURITY + 1);
        bond.burn(
            PROOF_PLACEHOLDER,
            rootAfterSwap,
            [bytes32(uint256(205)), bytes32(uint256(206))],
            [bytes32(uint256(37)), bytes32(uint256(38))],
            bytes32(MATURITY),
            bytes32(uint256(1))
        );

        for (uint256 i = 0; i < 8; i++) {
            assertEq(bond.commitments(i), bytes32(uint256(31 + i)), "leaf order");
        }
        vm.expectRevert();
        bond.commitments(8);

        for (uint256 n = 201; n <= 206; n++) {
            assertTrue(bond.nullifiers(bytes32(n)), "nullifier not marked");
        }

        // Every intermediate root stays known: "replay the log against the
        // anchored roots" is plural, and the CLI checks all of them.
        assertTrue(bond.knownRoots(rootAfterMints));
        assertTrue(bond.knownRoots(rootAfterTransfer));
        assertTrue(bond.knownRoots(rootAfterSwap));
        assertTrue(bond.knownRoots(bond.buildMerkleRoot()));
    }

    function test_transferRejectsUnknownRoot() public {
        bond.mint(bytes32(uint256(41)));
        vm.expectRevert("Invalid Merkle Root");
        bond.transfer(
            PROOF_PLACEHOLDER,
            bytes32(uint256(0xbad)),
            [bytes32(uint256(301)), bytes32(uint256(302))],
            [bytes32(uint256(42)), bytes32(uint256(43))]
        );
    }

    function test_nullifierCannotBeReused() public {
        bond.mint(bytes32(uint256(51)));
        bytes32 root = bond.buildMerkleRoot();
        bond.transfer(
            PROOF_PLACEHOLDER,
            root,
            [bytes32(uint256(401)), bytes32(uint256(402))],
            [bytes32(uint256(52)), bytes32(uint256(53))]
        );

        // Read the root before arming the cheatcode: arguments are evaluated
        // after expectRevert, so an inline call would consume the expectation.
        bytes32 rootAfter = bond.buildMerkleRoot();

        vm.expectRevert("Note 0 already spent");
        bond.transfer(
            PROOF_PLACEHOLDER,
            rootAfter,
            [bytes32(uint256(401)), bytes32(uint256(403))],
            [bytes32(uint256(54)), bytes32(uint256(55))]
        );
    }

    function test_burnRequiresMaturity() public {
        bond.mint(bytes32(uint256(61)));
        bytes32 root = bond.buildMerkleRoot();

        vm.expectRevert("Bond not at maturity yet");
        bond.burn(
            PROOF_PLACEHOLDER,
            root,
            [bytes32(uint256(501)), bytes32(uint256(502))],
            [bytes32(uint256(62)), bytes32(uint256(63))],
            bytes32(MATURITY),
            bytes32(uint256(1))
        );
    }

    function test_mintIsOwnerOnly() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        bond.mint(bytes32(uint256(71)));
    }
}
