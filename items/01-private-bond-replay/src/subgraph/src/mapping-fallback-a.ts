// Fallback A (spec §4.6): index the anchor log without traces.
//
// If the network go/no-go gate finds trace serving unavailable, this becomes
// the design rather than a contingency. It uses a block handler plus eth_call
// storage reads instead of call handlers: on each block it walks the
// `commitments` array forward from the last known leaf until the getter
// reverts, appending whatever is new.
//
// What this costs, stated plainly rather than glossed:
//
//   * `sourceFunction` is UNKNOWN for every leaf. Which entry point appended a
//     commitment lives in calldata, which this path never sees.
//   * No `Nullifier` entities. Nullifiers live in a `mapping(bytes32 => bool)`
//     with no enumeration and no length, so they are unreadable without either
//     calldata or storage-slot archaeology.
//   * No `RootClaimed` entities. The cited root is a calldata argument.
//   * `LifecycleCall` records one synthetic entry per block in which the leaf
//     count changed, not one per contract call. A block containing two
//     anchor-writing calls collapses into a single entry.
//
// What survives, and it is the part that matters: the ordered commitment log
// itself, at the same leaf indices, with the same values. That is what the
// replay CLI rebuilds roots from, so reconciliation and the root replay against
// `knownRoots` work unchanged. The CLI falls back to the manifest's call
// boundaries when the served lifecycle log cannot supply them.
//
// This path is also strictly more expensive per block: one eth_call minimum
// per block, plus one per new leaf.

import { Address, BigInt, Bytes, dataSource, ethereum, log } from '@graphprotocol/graph-ts'
import { PrivateBond } from '../generated/PrivateBond/PrivateBond'
import { Bond, Commitment, LifecycleCall } from '../generated/schema'

const BOND_ID = 'bond'
const ID_WIDTH = 12

// Guard against an unbounded loop if a block somehow adds a huge batch: the
// walk resumes on the next block rather than stalling the handler.
const MAX_NEW_LEAVES_PER_BLOCK = 512

function padded(n: BigInt): string {
  let s = n.toString()
  while (s.length < ID_WIDTH) {
    s = '0' + s
  }
  return s
}

export function handleBlock(block: ethereum.Block): void {
  const address: Address = dataSource.address()
  const contract = PrivateBond.bind(address)

  let bond = Bond.load(BOND_ID)
  if (bond == null) {
    const bondIdResult = contract.try_bondId()
    if (bondIdResult.reverted) {
      // Before deployment, or wrong address. Nothing to index yet.
      return
    }
    bond = new Bond(BOND_ID)
    bond.address = address
    bond.bondId = bondIdResult.value
    bond.leafCount = BigInt.zero()
    bond.nullifierCount = BigInt.zero()
    bond.callCount = BigInt.zero()
    bond.save()
  }

  const startingLeafCount = bond.leafCount
  let appended = 0

  while (appended < MAX_NEW_LEAVES_PER_BLOCK) {
    const next = contract.try_commitments(bond.leafCount)
    if (next.reverted) {
      // Out-of-bounds on a public array getter reverts. That is the end of the
      // array, not an error.
      break
    }

    const entity = new Commitment(padded(bond.leafCount))
    entity.leafIndex = bond.leafCount
    entity.value = next.value
    entity.sourceFunction = 'UNKNOWN'
    entity.call = padded(bond.callCount)
    entity.txHash = Bytes.fromUint8Array(new Uint8Array(0))
    entity.blockNumber = block.number
    entity.timestamp = block.timestamp
    entity.caller = Bytes.fromUint8Array(new Uint8Array(0))
    entity.save()

    bond.leafCount = bond.leafCount.plus(BigInt.fromI32(1))
    appended += 1
  }

  if (bond.leafCount.equals(startingLeafCount)) {
    bond.save()
    return
  }

  // One synthetic lifecycle entry per block in which the log grew. Deliberately
  // not presented as a per-call record: without calldata this path cannot tell
  // one call from two within a block.
  const lifecycle = new LifecycleCall(padded(bond.callCount))
  lifecycle.sequence = bond.callCount
  lifecycle.function_ = 'UNKNOWN'
  lifecycle.leafCountAfter = bond.leafCount
  lifecycle.proofHash = Bytes.fromUint8Array(new Uint8Array(0))
  lifecycle.proofLength = BigInt.zero()
  lifecycle.txHash = Bytes.fromUint8Array(new Uint8Array(0))
  lifecycle.blockNumber = block.number
  lifecycle.timestamp = block.timestamp
  lifecycle.caller = Bytes.fromUint8Array(new Uint8Array(0))
  lifecycle.save()

  bond.callCount = bond.callCount.plus(BigInt.fromI32(1))
  bond.save()

  log.info('fallback-a: leaf count {} -> {} at block {}', [
    startingLeafCount.toString(),
    bond.leafCount.toString(),
    block.number.toString(),
  ])
}
