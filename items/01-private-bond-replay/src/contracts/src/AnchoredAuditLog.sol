// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AnchoredAuditLog — Fallback B stand-in (spec.md §4.6)
/// @notice OUR CODE, NOT ETHSYSTEMS'. This contract is the showcase's own
/// stand-in, written to mirror the architecture *described* in the map's
/// `pattern-l2-encrypted-offchain-audit` card: an audit contract that accepts
/// `AuditCommit(bytes32)` record entries and periodic Merkle roots over an
/// off-chain encrypted log.
///
/// Every artifact that shows this contract must label it as our stand-in. It
/// is not part of EthSystems' private-bond PoC and implies nothing about it.
///
/// Why it exists: the primary design indexes the PoC via call handlers, which
/// need trace-capable chain data. Fallback A (block handler + eth_call) covers
/// the no-trace case for the PoC itself. This contract covers the residual
/// case where neither serves on the network, because it is events-only and
/// therefore indexable by any indexer with no trace requirement.
///
/// Trigger (spec §4.6): only if both the primary and Fallback A fail network
/// serving by end of build week 2, or earlier by Pedro's call.
contract AnchoredAuditLog {
    /// @notice One entry of the off-chain audit log, anchored by its hash.
    /// @param recordHash commitment to the off-chain record (opaque on-chain)
    /// @param index append-only position, mirrors the PoC's leaf index
    event AuditCommit(bytes32 indexed recordHash, uint256 index);

    /// @notice A periodic Merkle root over a contiguous range of entries.
    /// @param root Merkle root as computed off-chain by the committer
    /// @param fromIndex first entry index covered (inclusive)
    /// @param toIndex last entry index covered (inclusive)
    event RootAnchored(bytes32 indexed root, uint64 fromIndex, uint64 toIndex);

    address public immutable committer;

    /// @notice Append-only record hashes, in commit order.
    bytes32[] public records;

    /// @notice Every root this contract has anchored, for replay checks.
    mapping(bytes32 => bool) public anchoredRoots;

    uint64 public lastAnchoredIndex;
    bool private anyRootAnchored;

    error NotCommitter();
    error EmptyRange();
    error RangeOutOfBounds();

    modifier onlyCommitter() {
        if (msg.sender != committer) revert NotCommitter();
        _;
    }

    constructor(address _committer) {
        committer = _committer;
    }

    function commitRecord(bytes32 recordHash) external onlyCommitter {
        uint256 index = records.length;
        records.push(recordHash);
        emit AuditCommit(recordHash, index);
    }

    function anchorRoot(bytes32 root, uint64 fromIndex, uint64 toIndex) external onlyCommitter {
        if (toIndex < fromIndex) revert EmptyRange();
        if (toIndex >= records.length) revert RangeOutOfBounds();

        anchoredRoots[root] = true;
        lastAnchoredIndex = toIndex;
        anyRootAnchored = true;
        emit RootAnchored(root, fromIndex, toIndex);
    }

    function recordCount() external view returns (uint256) {
        return records.length;
    }

    function hasAnchoredRoot() external view returns (bool) {
        return anyRootAnchored;
    }
}
