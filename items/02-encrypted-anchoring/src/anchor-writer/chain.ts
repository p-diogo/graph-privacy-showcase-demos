import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Hex as ViemHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANCHOR_ABI } from "../anchor-core/index.js";

export interface AnchorSubmission {
  txHash: ViemHex;
  blockNumber: bigint;
}

export function encodePostAnchor(envelope: Uint8Array): ViemHex {
  return encodeFunctionData({
    abi: ANCHOR_ABI,
    functionName: "postAnchor",
    args: [`0x${Buffer.from(envelope).toString("hex")}` as ViemHex],
  });
}

export interface WriterChain {
  chainId: number;
  sender: ViemHex;
  submit(contract: ViemHex, envelope: Uint8Array): Promise<AnchorSubmission>;
  currentBlock(): Promise<bigint>;
}

/**
 * Anchors are submitted one at a time, each awaited to a receipt: sequential
 * submission from a single EOA is what makes seq order and block order agree,
 * which is what makes the served index order-deterministic (spec §4.4).
 */
export async function connectWriterChain(rpcUrl: string, privateKey: string): Promise<WriterChain> {
  const normalizedKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as ViemHex;
  const account = privateKeyToAccount(normalizedKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return {
    chainId,
    sender: account.address,
    async submit(contract, envelope) {
      const txHash = await wallet.sendTransaction({ to: contract, data: encodePostAnchor(envelope) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`anchor tx ${txHash} reverted`);
      return { txHash, blockNumber: receipt.blockNumber };
    },
    async currentBlock() {
      return publicClient.getBlockNumber();
    },
  };
}
