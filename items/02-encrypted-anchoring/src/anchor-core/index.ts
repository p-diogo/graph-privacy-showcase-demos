export * from "./archive.js";
export * from "./bytes.js";
export * from "./cli-args.js";
export * from "./crypto.js";
export * from "./disclosure.js";
export * from "./envelope.js";
export * from "./keystore.js";
export * from "./records.js";
export * from "./stream.js";

/** ABI of the deployed anchor contract, as emitted by `forge build`. */
export const ANCHOR_ABI = [
  {
    type: "function",
    name: "postAnchor",
    inputs: [{ name: "", type: "bytes", internalType: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** bytes4(keccak256("postAnchor(bytes)")) — asserted in the contract tests. */
export const POST_ANCHOR_SELECTOR = "0x330a5405";
