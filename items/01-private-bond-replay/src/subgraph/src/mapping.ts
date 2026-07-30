// Anchor-log mappings for EthSystems' PrivateBond.
//
// The contract emits no events, so every handler here is a call handler and
// every anchor value is read out of calldata.
//
// Determinism is the requirement these mappings are written against. Two
// indexers processing the same blocks must produce byte-identical entities, so
// nothing below depends on anything but the call itself and the store state
// the previous calls left. In particular there is exactly one eth_call — for
// the immutable `bondId` — and it is made once, at the first handler.

import { BigInt, Bytes, crypto, ethereum, log } from '@graphprotocol/graph-ts'
import {
  AtomicSwapCall,
  BurnCall,
  MintBatchCall,
  MintCall,
  PrivateBond,
  TransferCall,
} from '../generated/PrivateBond/PrivateBond'
import { Bond, Commitment, LifecycleCall, Nullifier, RootClaimed } from '../generated/schema'

const BOND_ID = 'bond'

// Zero-padding width for ids. Lexicographic order over padded decimals equals
// numeric order, which is what lets a consumer sort by id and get execution
// order without parsing block and transaction positions.
const ID_WIDTH = 12

// A genuinely zero-length Bytes.
//
// NOT `Bytes.empty()`: that returns `ByteArray.fromI32(0)`, which is four zero
// bytes, so mint and mintBatch would report proofLength 4 and a proofHash of
// keccak256(0x00000000). Both are wrong — those entry points take no proof
// argument at all — and both look plausible enough to go unnoticed.
function noProof(): Bytes {
  return Bytes.fromUint8Array(new Uint8Array(0))
}

function padded(n: BigInt): string {
  let s = n.toString()
  while (s.length < ID_WIDTH) {
    s = '0' + s
  }
  return s
}

function loadBond(call: ethereum.Call): Bond {
  let bond = Bond.load(BOND_ID)
  if (bond != null) {
    return bond as Bond
  }

  bond = new Bond(BOND_ID)
  bond.address = call.to
  bond.leafCount = BigInt.zero()
  bond.nullifierCount = BigInt.zero()
  bond.callCount = BigInt.zero()

  // The only eth_call in these mappings. `bondId` is set in the constructor
  // and never written again, so reading it once is deterministic: any indexer
  // reading it at any block after deployment gets the same answer.
  const contract = PrivateBond.bind(call.to)
  const result = contract.try_bondId()
  if (result.reverted) {
    // Recorded rather than guessed. A zero bondId in served data is visible as
    // wrong; a fabricated one would not be.
    log.error('bondId() reverted at {}; recording zero', [call.to.toHexString()])
    bond.bondId = Bytes.fromHexString(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    )
  } else {
    bond.bondId = result.value
  }

  bond.save()
  return bond as Bond
}

function recordCall(call: ethereum.Call, fn: string, proof: Bytes, bond: Bond): LifecycleCall {
  const sequence = bond.callCount
  const entity = new LifecycleCall(padded(sequence))

  entity.sequence = sequence
  // codegen escapes the `function` field to `function_`, since `function` is
  // an AssemblyScript keyword. The GraphQL field is still named `function`,
  // so consumers query it unescaped.
  entity.function_ = fn
  // Provisional; finalizeCall writes the true value once the leaves this call
  // appended are known. Never predicted from the argument shape, because a
  // caller-supplied array can be shorter than the layout expects.
  entity.leafCountAfter = bond.leafCount
  // Digest and length only: full proofs are large and nothing downstream
  // verifies them, so carrying the bytes would inflate every audit response
  // for no assurance gain.
  entity.proofHash = Bytes.fromByteArray(crypto.keccak256(proof))
  entity.proofLength = BigInt.fromI32(proof.length)
  entity.txHash = call.transaction.hash
  entity.blockNumber = call.block.number
  entity.timestamp = call.block.timestamp
  entity.caller = call.from
  entity.save()

  bond.callCount = sequence.plus(BigInt.fromI32(1))
  return entity
}

/// Record how many leaves existed once this call returned.
///
/// The replay CLI derives the root-history prefix lengths from this field, so
/// it must reflect what was actually appended rather than what the function
/// signature implies.
function finalizeCall(lifecycle: LifecycleCall, bond: Bond): void {
  lifecycle.leafCountAfter = bond.leafCount
  lifecycle.save()
  bond.save()
}

function appendCommitment(
  call: ethereum.Call,
  lifecycle: LifecycleCall,
  bond: Bond,
  value: Bytes,
  fn: string,
): void {
  const leafIndex = bond.leafCount
  const entity = new Commitment(padded(leafIndex))

  entity.leafIndex = leafIndex
  entity.value = value
  entity.sourceFunction = fn
  entity.call = lifecycle.id
  entity.txHash = call.transaction.hash
  entity.blockNumber = call.block.number
  entity.timestamp = call.block.timestamp
  entity.caller = call.from
  entity.save()

  bond.leafCount = leafIndex.plus(BigInt.fromI32(1))
}

function markNullifier(
  call: ethereum.Call,
  lifecycle: LifecycleCall,
  bond: Bond,
  value: Bytes,
  fn: string,
): void {
  // Keyed by the nullifier value: the contract's own mapping is keyed that
  // way, and a repeat would have reverted, so collisions cannot occur in
  // valid history.
  const entity = new Nullifier(value.toHexString())

  entity.value = value
  entity.sourceFunction = fn
  entity.call = lifecycle.id
  entity.txHash = call.transaction.hash
  entity.blockNumber = call.block.number
  entity.timestamp = call.block.timestamp
  entity.caller = call.from
  entity.save()

  bond.nullifierCount = bond.nullifierCount.plus(BigInt.fromI32(1))
}

function recordClaimedRoot(
  call: ethereum.Call,
  lifecycle: LifecycleCall,
  root: Bytes,
  fn: string,
  suffix: string,
): void {
  const entity = new RootClaimed(lifecycle.id + '-' + suffix)

  entity.root = root
  entity.sourceFunction = fn
  entity.call = lifecycle.id
  entity.txHash = call.transaction.hash
  entity.blockNumber = call.block.number
  entity.timestamp = call.block.timestamp
  entity.save()
}

export function handleMint(call: MintCall): void {
  const bond = loadBond(call)
  const lifecycle = recordCall(call, 'MINT', noProof(), bond)
  appendCommitment(call, lifecycle, bond, call.inputs._commitment, 'MINT')
  finalizeCall(lifecycle, bond)
}

export function handleMintBatch(call: MintBatchCall): void {
  const bond = loadBond(call)
  const commitments = call.inputs._commitments
  const lifecycle = recordCall(call, 'MINT_BATCH', noProof(), bond)

  // Array order is the order the contract pushed them in.
  for (let i = 0; i < commitments.length; i++) {
    appendCommitment(call, lifecycle, bond, commitments[i], 'MINT_BATCH')
  }
  finalizeCall(lifecycle, bond)
}

export function handleTransfer(call: TransferCall): void {
  const bond = loadBond(call)
  const lifecycle = recordCall(call, 'TRANSFER', call.inputs.proof, bond)

  recordClaimedRoot(call, lifecycle, call.inputs.root, 'TRANSFER', 'root')

  const nullifiers = call.inputs.nullifiersIn
  for (let i = 0; i < nullifiers.length; i++) {
    markNullifier(call, lifecycle, bond, nullifiers[i], 'TRANSFER')
  }

  // The contract pushes commitmentsOut[0] then commitmentsOut[1].
  const commitments = call.inputs.commitmentsOut
  for (let i = 0; i < commitments.length; i++) {
    appendCommitment(call, lifecycle, bond, commitments[i], 'TRANSFER')
  }
  finalizeCall(lifecycle, bond)
}

export function handleBurn(call: BurnCall): void {
  const bond = loadBond(call)
  const lifecycle = recordCall(call, 'BURN', call.inputs.proof, bond)

  recordClaimedRoot(call, lifecycle, call.inputs.root, 'BURN', 'root')

  const nullifiers = call.inputs.nullifiersIn
  for (let i = 0; i < nullifiers.length; i++) {
    markNullifier(call, lifecycle, bond, nullifiers[i], 'BURN')
  }

  // Zero-value outputs, appended to preserve the tree's 2-in/2-out shape.
  // They are anchors like any other and are served as such; the auditor's
  // manifest is what classes them as structural rather than disclosed.
  const commitments = call.inputs.commitmentsOut
  for (let i = 0; i < commitments.length; i++) {
    appendCommitment(call, lifecycle, bond, commitments[i], 'BURN')
  }
  finalizeCall(lifecycle, bond)
}

export function handleAtomicSwap(call: AtomicSwapCall): void {
  const bond = loadBond(call)
  const lifecycle = recordCall(call, 'ATOMIC_SWAP', call.inputs.proofA, bond)

  // Public-input layout [0]=root, [1]=nullifier, [2]=commitment,
  // [3]=maturity, per EthSystems' own tests for this entry point. The arrays
  // are caller-supplied and unvalidated by the contract beyond these reads, so
  // a short array is possible in principle; short ones are skipped with a log
  // rather than indexed as zeros, because a fabricated anchor is worse than a
  // missing one.
  const legs: Array<Array<Bytes>> = [call.inputs.publicInputsA, call.inputs.publicInputsB]
  const legNames: Array<string> = ['A', 'B']

  for (let leg = 0; leg < legs.length; leg++) {
    const inputs = legs[leg]
    if (inputs.length < 4) {
      log.error('atomicSwap leg {} has {} public inputs, expected at least 4; tx {}', [
        legNames[leg],
        inputs.length.toString(),
        call.transaction.hash.toHexString(),
      ])
      continue
    }
    recordClaimedRoot(call, lifecycle, inputs[0], 'ATOMIC_SWAP', 'root' + legNames[leg])
    markNullifier(call, lifecycle, bond, inputs[1], 'ATOMIC_SWAP')
  }

  // Both commitments are pushed after both legs' checks, matching the
  // contract's ordering: publicInputsA[2] then publicInputsB[2].
  for (let leg = 0; leg < legs.length; leg++) {
    const inputs = legs[leg]
    if (inputs.length < 4) {
      continue
    }
    appendCommitment(call, lifecycle, bond, inputs[2], 'ATOMIC_SWAP')
  }

  finalizeCall(lifecycle, bond)
}
