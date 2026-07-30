import { keccak_256 } from "@noble/hashes/sha3.js";

export type Hex = `0x${string}`;

const HEX_CHARS = "0123456789abcdef";

export function toHex(bytes: Uint8Array): Hex {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_CHARS[b >> 4];
    out += HEX_CHARS[b & 0x0f];
  }
  return `0x${out}`;
}

export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new Error(`not a hex string: ${hex}`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** uint64 big-endian, the on-wire encoding of `seq` (spec §4.2). */
export function u64be(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`seq out of uint64 range: ${value}`);
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function readU64be(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[offset + i] as number);
  return v;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export const ZERO32 = new Uint8Array(32);

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
