import { describe, expect, it } from "vitest";

import { fractionalRootBits, sha256Hex } from "./sha256.js";

// The forty-step search the derivation used before, kept as an oracle.
function referenceRoot(radicand: bigint, degree: bigint): bigint {
  let low = 0n;
  let high = 1n << 40n;
  while (low + 1n < high) {
    const middle = (low + high) >> 1n;
    if (middle ** degree <= radicand) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

async function platformSha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("synchronous SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("matches the FIPS 180-4 vector for %j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it.each([
    ["first round constant", 2n << 96n, 3n, 0x428a2f98],
    ["last round constant", 311n << 96n, 3n, 0xc67178f2],
    ["first initial hash word", 2n << 64n, 2n, 0x6a09e667],
    ["last initial hash word", 19n << 64n, 2n, 0x5be0cd19],
    ["exact cube", 125n, 3n, 5],
  ])(
    "settles the %s exactly from any starting estimate",
    (_label, radicand, degree, expected) => {
      const exact = referenceRoot(radicand, degree);
      expect(Number(exact & 0xffffffffn)).toBe(expected);
      expect(fractionalRootBits(radicand, degree)).toBe(expected);
      for (const offset of [-1000n, -3n, -1n, 0n, 1n, 3n, 1000n]) {
        expect(fractionalRootBits(radicand, degree, exact + offset)).toBe(
          expected,
        );
      }
    },
  );

  it.each([
    ["multi-block", "OpenCookie policy identity\n".repeat(40)],
    ["Unicode", "OpenCookie 🔐 🍪 汉字 e\u0301".repeat(20)],
  ])("matches the platform oracle for %s input", async (_label, input) => {
    expect(sha256Hex(input)).toBe(await platformSha256Hex(input));
  });
});
