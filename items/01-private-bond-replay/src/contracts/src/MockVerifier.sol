// SPDX-License-Identifier: MIT
pragma solidity >=0.8.21;

// MockVerifier — always-true proof verifier.
//
// Copied verbatim from EthSystems' own test suite, at pinned SHA
// 94f1e5c94b6c4896977ae68094b99479eef4c371 of ethsystems/pocs:
//   pocs/private-bond/custom-utxo/contracts/test/PrivateBond.t.sol (L8-L12)
//
// This is the verifier the deployed PrivateBond uses in this item, per the
// spec's pre-decided default (spec.md 4.2). Generating real Honk proofs
// requires the Noir/Barretenberg toolchain (nargo + bb), which this item's
// local tranche does not run; with no proofs available the real HonkVerifier
// cannot be satisfied by construction.
//
// MUST NOT CLAIM: a deployment backed by this contract is not evidence that
// the PoC's ZK layer works, and says nothing about their circuit. This item's
// claims (E1/E2/E3) concern the audit-read leg only. Anchors land in storage
// and calldata regardless of proof validity, which is why the read path is
// invariant to this choice.
contract MockVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}
