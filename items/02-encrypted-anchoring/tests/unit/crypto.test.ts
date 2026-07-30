import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "../../src/anchor-core/bytes.js";
import {
  AAD_LENGTH,
  ENC_KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  buildAad,
  decryptRecord,
  deriveEncKey,
  deriveNonce,
  encryptRecord,
} from "../../src/anchor-core/crypto.js";

const STREAM_KEY = fromHex("0xeb7fb7faae56b8169d716b878297e1f428124d99eeb2366ec77ca5a120a3f34c");
const STREAM_ID = fromHex("0x5be7cd098a9193fd81ad24e4bf014498cfc8e1fcfb796660cb9ee01eab8c373d");
const OTHER_STREAM_ID = fromHex("0x1111111111111111111111111111111111111111111111111111111111111111");
const PLAINTEXT = utf8('{"recordId":"SET-2026-0001","notional":"2500000.00"}');

function pythonCrossCheck(): { available: boolean; run: (key: string, nonce: string, aad: string, pt: string) => string } {
  let available = false;
  try {
    execFileSync("python3", ["-c", "from cryptography.hazmat.primitives.ciphers.aead import AESGCMSIV"], {
      stdio: "ignore",
    });
    available = true;
  } catch {
    available = false;
  }
  return {
    available,
    run(key, nonce, aad, plaintext) {
      const script = [
        "import sys",
        "from cryptography.hazmat.primitives.ciphers.aead import AESGCMSIV",
        "key, nonce, aad, pt = (bytes.fromhex(a) for a in sys.argv[1:5])",
        "sys.stdout.write(AESGCMSIV(key).encrypt(nonce, pt, aad).hex())",
      ].join("\n");
      return execFileSync("python3", ["-c", script, key, nonce, aad, plaintext], { encoding: "utf8" });
    },
  };
}

const python = pythonCrossCheck();

describe("deterministic record encryption", () => {
  it("derives a 32-byte key and a 12-byte nonce", () => {
    expect(deriveEncKey(STREAM_KEY, STREAM_ID).length).toBe(ENC_KEY_LENGTH);
    expect(deriveNonce(STREAM_KEY, STREAM_ID, 0n).length).toBe(NONCE_LENGTH);
  });

  it("binds the AAD to version, stream and position", () => {
    const aad = buildAad(STREAM_ID, 7n);
    expect(aad.length).toBe(AAD_LENGTH);
    expect(aad.length).toBe(41);
    expect(aad[0]).toBe(1);
    expect(toHex(aad.slice(1, 33))).toBe(toHex(STREAM_ID));
    expect(toHex(aad.slice(33))).toBe("0x0000000000000007");
  });

  it("produces byte-identical ciphertext when run twice", () => {
    const first = encryptRecord(STREAM_KEY, STREAM_ID, 3n, PLAINTEXT);
    const second = encryptRecord(STREAM_KEY, STREAM_ID, 3n, PLAINTEXT);
    expect(toHex(second)).toBe(toHex(first));
  });

  it("appends a 16-byte tag", () => {
    const ciphertext = encryptRecord(STREAM_KEY, STREAM_ID, 0n, PLAINTEXT);
    expect(ciphertext.length).toBe(PLAINTEXT.length + TAG_LENGTH);
  });

  it("gives equal plaintexts at different positions unrelated ciphertexts", () => {
    const atZero = encryptRecord(STREAM_KEY, STREAM_ID, 0n, PLAINTEXT);
    const atOne = encryptRecord(STREAM_KEY, STREAM_ID, 1n, PLAINTEXT);
    expect(toHex(atOne)).not.toBe(toHex(atZero));
    expect(toHex(deriveNonce(STREAM_KEY, STREAM_ID, 0n))).not.toBe(toHex(deriveNonce(STREAM_KEY, STREAM_ID, 1n)));
  });

  it("separates streams: same key material, different streamId, different key and nonce", () => {
    expect(toHex(deriveEncKey(STREAM_KEY, OTHER_STREAM_ID))).not.toBe(toHex(deriveEncKey(STREAM_KEY, STREAM_ID)));
    expect(toHex(deriveNonce(STREAM_KEY, OTHER_STREAM_ID, 0n))).not.toBe(toHex(deriveNonce(STREAM_KEY, STREAM_ID, 0n)));
  });

  it("round-trips decrypt at its own position", () => {
    const ciphertext = encryptRecord(STREAM_KEY, STREAM_ID, 5n, PLAINTEXT);
    expect(toHex(decryptRecord(STREAM_KEY, STREAM_ID, 5n, ciphertext))).toBe(toHex(PLAINTEXT));
  });

  it("fails tag verification when a ciphertext is transplanted to another seq", () => {
    const ciphertext = encryptRecord(STREAM_KEY, STREAM_ID, 5n, PLAINTEXT);
    expect(() => decryptRecord(STREAM_KEY, STREAM_ID, 6n, ciphertext)).toThrow();
  });

  it("fails tag verification when a ciphertext is transplanted to another stream", () => {
    const ciphertext = encryptRecord(STREAM_KEY, STREAM_ID, 5n, PLAINTEXT);
    expect(() => decryptRecord(STREAM_KEY, OTHER_STREAM_ID, 5n, ciphertext)).toThrow();
  });

  it("fails tag verification when a single ciphertext byte is flipped", () => {
    const ciphertext = encryptRecord(STREAM_KEY, STREAM_ID, 5n, PLAINTEXT);
    ciphertext[2] = ciphertext[2]! ^ 0x01;
    expect(() => decryptRecord(STREAM_KEY, STREAM_ID, 5n, ciphertext)).toThrow();
  });

  it.skipIf(!python.available)(
    "agrees byte-for-byte with an independent AES-256-GCM-SIV implementation (python cryptography / OpenSSL)",
    () => {
      for (const seq of [0n, 1n, 9n]) {
        const key = deriveEncKey(STREAM_KEY, STREAM_ID);
        const nonce = deriveNonce(STREAM_KEY, STREAM_ID, seq);
        const aad = buildAad(STREAM_ID, seq);
        const ours = toHex(encryptRecord(STREAM_KEY, STREAM_ID, seq, PLAINTEXT));
        const theirs = `0x${python.run(
          toHex(key).slice(2),
          toHex(nonce).slice(2),
          toHex(aad).slice(2),
          toHex(PLAINTEXT).slice(2),
        )}`;
        expect(theirs).toBe(ours);
      }
    },
  );
});
