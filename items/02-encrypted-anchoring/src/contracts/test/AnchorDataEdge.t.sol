// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.12;

import {Test, Vm} from "forge-std/Test.sol";
import {AnchorDataEdge} from "../src/AnchorDataEdge.sol";

/// The contract's job is to be inert: accept any payload, keep nothing, emit
/// nothing. These tests assert exactly that, plus the selector the subgraph
/// manifest and the checker's chain-scan mode both hard-code.
contract AnchorDataEdgeTest is Test {
    AnchorDataEdge internal edge;

    /// The 105-byte envelope of spec §4.2, filled with recognisable bytes.
    bytes internal constant ENVELOPE_105 =
        hex"01"
        hex"1111111111111111111111111111111111111111111111111111111111111111"
        hex"0000000000000007"
        hex"2222222222222222222222222222222222222222222222222222222222222222"
        hex"3333333333333333333333333333333333333333333333333333333333333333";

    function setUp() public {
        edge = new AnchorDataEdge();
    }

    function test_SelectorIsStable() public pure {
        assertEq(AnchorDataEdge.postAnchor.selector, bytes4(0x330a5405));
        assertEq(bytes4(keccak256("postAnchor(bytes)")), bytes4(0x330a5405));
    }

    function test_EnvelopeIs105Bytes() public pure {
        assertEq(ENVELOPE_105.length, 105);
    }

    function test_PostAnchorAcceptsEnvelopeAndEmitsNothing() public {
        vm.recordLogs();
        edge.postAnchor(ENVELOPE_105);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "anchor contract must emit nothing");
    }

    function test_PostAnchorAcceptsEmptyAndOversizedPayloads() public {
        edge.postAnchor("");
        edge.postAnchor(new bytes(4096));
    }

    function testFuzz_PostAnchorNeverReverts(bytes calldata payload) public {
        vm.assume(payload.length <= 8192);
        edge.postAnchor(payload);
    }

    function test_NoStorageIsWritten() public {
        edge.postAnchor(ENVELOPE_105);
        for (uint256 slot = 0; slot < 8; slot++) {
            assertEq(vm.load(address(edge), bytes32(slot)), bytes32(0));
        }
    }

    function test_RawCalldataWithSelectorSucceeds() public {
        // What the writer actually puts on the wire: selector + ABI-encoded bytes.
        bytes memory calldataBlob = abi.encodeWithSelector(AnchorDataEdge.postAnchor.selector, ENVELOPE_105);
        // 4 selector + 32 offset + 32 length + 128 padded payload = 196 bytes (spec §4.2).
        assertEq(calldataBlob.length, 196);
        (bool ok, bytes memory ret) = address(edge).call(calldataBlob);
        assertTrue(ok);
        assertEq(ret.length, 0);
    }

    function test_UnknownSelectorReverts() public {
        // No fallback: only the named function is callable. This is why the
        // subgraph can match on a real signature rather than a phantom one.
        (bool ok,) = address(edge).call(hex"deadbeef");
        assertFalse(ok);
    }

    function test_RejectsValue() public {
        (bool ok,) =
            address(edge).call{value: 1 wei}(abi.encodeWithSelector(AnchorDataEdge.postAnchor.selector, ENVELOPE_105));
        assertFalse(ok, "non-payable: nothing can be stranded");
    }

    function test_AnchorGasIsUnderThirtyThousand() public {
        // Spec §4.2 claims an anchor tx stays under ~30k gas. Measured here as
        // call gas; a real tx adds the 21k intrinsic cost on top of calldata
        // pricing, which is the number the spec's estimate refers to.
        uint256 before = gasleft();
        edge.postAnchor(ENVELOPE_105);
        uint256 used = before - gasleft();
        assertLt(used, 30000);
    }
}
