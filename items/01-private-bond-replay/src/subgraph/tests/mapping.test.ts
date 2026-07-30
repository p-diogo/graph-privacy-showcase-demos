// Unit tests for the anchor-log mappings (spec §7, unit layer).
//
// These cover the decode logic in isolation: leaf ordering across entry
// points, the running counters, the nullifier and claimed-root records, and
// the two places the mapping could quietly produce plausible-but-wrong data
// (the proof digest for entry points that take no proof, and a short
// atomicSwap public-input array).
//
// The live counterpart is tests/integration/run-local-e2e.sh, which asserts
// the same entity log after a real graph-node has indexed a real chain.

import { Address, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import {
  afterEach,
  assert,
  clearStore,
  createMockedFunction,
  describe,
  newMockCall,
  test,
} from 'matchstick-as/assembly/index'

import {
  handleAtomicSwap,
  handleBurn,
  handleMint,
  handleMintBatch,
  handleTransfer,
} from '../src/mapping'
import {
  AtomicSwapCall,
  BurnCall,
  MintBatchCall,
  MintCall,
  TransferCall,
} from '../generated/PrivateBond/PrivateBond'

const CONTRACT = Address.fromString('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0')
const CALLER = Address.fromString('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
const BOND_ID = '0x4fa70ac1719c2bc2414780925b865735615b835f2b84f2831ea9c6e69b3d08a3'

// keccak256 of zero-length input. Pinning it here is what makes the
// "mint records no proof" test meaningful rather than self-referential.
const KECCAK_OF_EMPTY = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'

function b32(hex: string): Bytes {
  return Bytes.fromHexString(hex) as Bytes
}

function leaf(n: i32): Bytes {
  let s = n.toString()
  while (s.length < 2) s = '0' + s
  return b32('0x' + s.repeat(32))
}

function mockBondId(): void {
  createMockedFunction(CONTRACT, 'bondId', 'bondId():(bytes32)')
    .returns([ethereum.Value.fromFixedBytes(b32(BOND_ID))])
}

function baseCall(): ethereum.Call {
  const call = newMockCall()
  call.to = CONTRACT
  call.from = CALLER
  call.block.number = BigInt.fromI32(4)
  call.block.timestamp = BigInt.fromI32(1893456000)
  return call
}

function mintCall(commitment: Bytes): ethereum.Call {
  const call = baseCall()
  call.inputValues = [
    new ethereum.EventParam('_commitment', ethereum.Value.fromFixedBytes(commitment)),
  ]
  return call
}

describe('anchor-log mappings', () => {
  afterEach(() => {
    clearStore()
  })

  test('mint appends one leaf and reads bondId once', () => {
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    assert.entityCount('Commitment', 1)
    assert.fieldEquals('Commitment', '000000000000', 'leafIndex', '0')
    assert.fieldEquals('Commitment', '000000000000', 'sourceFunction', 'MINT')
    assert.fieldEquals('Bond', 'bond', 'leafCount', '1')
    assert.fieldEquals('Bond', 'bond', 'bondId', BOND_ID)
  })

  test('mint records no proof, not four zero bytes', () => {
    // graph-ts `Bytes.empty()` returns ByteArray.fromI32(0), which is four
    // zero bytes. Using it here would report proofLength 4 and a digest of
    // keccak256(0x00000000) for an entry point that takes no proof at all —
    // wrong, and plausible enough to pass a casual read.
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    assert.fieldEquals('LifecycleCall', '000000000000', 'proofLength', '0')
    assert.fieldEquals('LifecycleCall', '000000000000', 'proofHash', KECCAK_OF_EMPTY)
  })

  test('leaf indices continue across entry points in call order', () => {
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    const batch = baseCall()
    batch.inputValues = [
      new ethereum.EventParam(
        '_commitments',
        ethereum.Value.fromFixedBytesArray([leaf(2), leaf(3)]),
      ),
    ]
    handleMintBatch(changetype<MintBatchCall>(batch))

    assert.entityCount('Commitment', 3)
    assert.fieldEquals('Commitment', '000000000001', 'sourceFunction', 'MINT_BATCH')
    assert.fieldEquals('Commitment', '000000000002', 'sourceFunction', 'MINT_BATCH')
    assert.fieldEquals('Bond', 'bond', 'leafCount', '3')
    // Two calls, and leafCountAfter reflects what each actually appended.
    assert.fieldEquals('LifecycleCall', '000000000000', 'leafCountAfter', '1')
    assert.fieldEquals('LifecycleCall', '000000000001', 'leafCountAfter', '3')
  })

  test('transfer records two leaves, two nullifiers and the cited root', () => {
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    const call = baseCall()
    call.inputValues = [
      new ethereum.EventParam('proof', ethereum.Value.fromBytes(b32('0xdeadbeef'))),
      new ethereum.EventParam('root', ethereum.Value.fromFixedBytes(leaf(9))),
      new ethereum.EventParam(
        'nullifiersIn',
        ethereum.Value.fromFixedBytesArray([leaf(20), leaf(21)]),
      ),
      new ethereum.EventParam(
        'commitmentsOut',
        ethereum.Value.fromFixedBytesArray([leaf(30), leaf(31)]),
      ),
    ]
    handleTransfer(changetype<TransferCall>(call))

    assert.entityCount('Commitment', 3)
    assert.entityCount('Nullifier', 2)
    assert.entityCount('RootClaimed', 1)
    assert.fieldEquals('Bond', 'bond', 'nullifierCount', '2')
    assert.fieldEquals('RootClaimed', '000000000001-root', 'root', leaf(9).toHexString())
    // The two outputs land in calldata order.
    assert.fieldEquals('Commitment', '000000000001', 'value', leaf(30).toHexString())
    assert.fieldEquals('Commitment', '000000000002', 'value', leaf(31).toHexString())
  })

  test('atomicSwap reads root, nullifier and commitment from both legs', () => {
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    const call = baseCall()
    call.inputValues = [
      new ethereum.EventParam('proofA', ethereum.Value.fromBytes(b32('0xaa'))),
      new ethereum.EventParam(
        'publicInputsA',
        ethereum.Value.fromFixedBytesArray([leaf(9), leaf(40), leaf(50), leaf(60)]),
      ),
      new ethereum.EventParam('proofB', ethereum.Value.fromBytes(b32('0xbb'))),
      new ethereum.EventParam(
        'publicInputsB',
        ethereum.Value.fromFixedBytesArray([leaf(9), leaf(41), leaf(51), leaf(60)]),
      ),
    ]
    handleAtomicSwap(changetype<AtomicSwapCall>(call))

    assert.entityCount('Nullifier', 2)
    assert.entityCount('RootClaimed', 2)
    // Both commitments are appended after both legs, matching the contract.
    assert.fieldEquals('Commitment', '000000000001', 'value', leaf(50).toHexString())
    assert.fieldEquals('Commitment', '000000000002', 'value', leaf(51).toHexString())
  })

  test('a short atomicSwap leg is skipped rather than indexed as zeros', () => {
    // The public-input arrays are caller-supplied and the contract only reads
    // fixed positions from them. Indexing a missing element as zero would
    // fabricate an anchor, which is strictly worse than omitting one.
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    const call = baseCall()
    call.inputValues = [
      new ethereum.EventParam('proofA', ethereum.Value.fromBytes(b32('0xaa'))),
      new ethereum.EventParam(
        'publicInputsA',
        ethereum.Value.fromFixedBytesArray([leaf(9), leaf(40)]),
      ),
      new ethereum.EventParam('proofB', ethereum.Value.fromBytes(b32('0xbb'))),
      new ethereum.EventParam(
        'publicInputsB',
        ethereum.Value.fromFixedBytesArray([leaf(9), leaf(41), leaf(51), leaf(60)]),
      ),
    ]
    handleAtomicSwap(changetype<AtomicSwapCall>(call))

    // Only leg B contributed.
    assert.entityCount('Commitment', 2)
    assert.entityCount('Nullifier', 1)
    assert.fieldEquals('Commitment', '000000000001', 'value', leaf(51).toHexString())
    assert.fieldEquals('LifecycleCall', '000000000001', 'leafCountAfter', '2')
  })

  test('burn appends its zero-value outputs like any other anchor', () => {
    mockBondId()
    handleMint(changetype<MintCall>(mintCall(leaf(1))))

    const call = baseCall()
    call.inputValues = [
      new ethereum.EventParam('proof', ethereum.Value.fromBytes(b32('0xcc'))),
      new ethereum.EventParam('root', ethereum.Value.fromFixedBytes(leaf(9))),
      new ethereum.EventParam(
        'nullifiersIn',
        ethereum.Value.fromFixedBytesArray([leaf(70), leaf(71)]),
      ),
      new ethereum.EventParam(
        'commitmentsOut',
        ethereum.Value.fromFixedBytesArray([leaf(80), leaf(81)]),
      ),
      new ethereum.EventParam('inputMaturityDate', ethereum.Value.fromFixedBytes(leaf(0))),
      new ethereum.EventParam('isRedeem', ethereum.Value.fromFixedBytes(leaf(1))),
    ]
    handleBurn(changetype<BurnCall>(call))

    assert.entityCount('Commitment', 3)
    assert.fieldEquals('Commitment', '000000000001', 'sourceFunction', 'BURN')
    assert.fieldEquals('Commitment', '000000000002', 'sourceFunction', 'BURN')
    // The subgraph does not class these as structural; the auditor's manifest
    // does. Here they are anchors like any other.
    assert.fieldEquals('Bond', 'bond', 'leafCount', '3')
  })
})
