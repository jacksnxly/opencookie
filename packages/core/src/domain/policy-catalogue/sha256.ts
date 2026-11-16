// Synchronous SHA-256 derived from the operations and constants specified by
// NIST FIPS 180-4. It stays package-private so policy identities have no
// caller-supplied digest or verifier boundary.
//
// FIPS 180-4 defines the round constants as the first 32 fractional bits of
// the cube roots of the first 64 primes and the initial hash as the same
// bits of the square roots of the first 8 primes. Deriving them through
// exact integer roots reproduces the specified table bit for bit on every
// engine. Floating-point exponentiation is only implementation-approximated,
// so it only seeds the root and exact integer comparisons settle it: a few
// big-integer powers per constant at every load, not a forty-step search.
const PRIMES: bigint[] = [];
for (let candidate = 2n; PRIMES.length < 64; candidate += 1n) {
  if (PRIMES.every((prime) => candidate % prime !== 0n)) PRIMES.push(candidate);
}

/** Low 32 bits of the floor of `radicand`'s `degree`-th root. */
export function fractionalRootBits(
  radicand: bigint,
  degree: bigint,
  estimate = BigInt(Math.floor(Number(radicand) ** (1 / Number(degree)))),
): number {
  let root = estimate;
  while (root ** degree > radicand) root -= 1n;
  while ((root + 1n) ** degree <= radicand) root += 1n;
  return Number(root & 0xffffffffn);
}

const ROUND_CONSTANTS = new Uint32Array(
  PRIMES.map((prime) => fractionalRootBits(prime << 96n, 3n)),
);

const INITIAL_HASH = new Uint32Array(
  PRIMES.slice(0, 8).map((prime) => fractionalRootBits(prime << 64n, 2n)),
);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function paddedMessage(input: string): Uint8Array {
  const message = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const bitLength = message.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  return padded;
}

/** Package-private synchronous SHA-256 over the UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
  const message = paddedMessage(input);
  const words = new Uint32Array(64);
  const state = INITIAL_HASH.slice();

  for (let offset = 0; offset < message.length; offset += 64) {
    const view = new DataView(message.buffer, offset, 64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] as number;
      const word2 = words[index - 2] as number;
      const sigma0 =
        rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 =
        rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] =
        (words[index - 16] as number) +
        sigma0 +
        (words[index - 7] as number) +
        sigma1;
    }

    // The eight working registers a..h live in one array so the per-round
    // rotation is a single copyWithin; Uint32Array assignment already wraps
    // modulo 2^32 exactly like the >>> 0 the scalar form needed.
    const working = state.slice();
    for (let index = 0; index < 64; index += 1) {
      const a = working[0] as number;
      const e = working[4] as number;
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice =
        (e & (working[5] as number)) ^ (~e & (working[6] as number));
      const temporary1 =
        (working[7] as number) +
        sum1 +
        choice +
        (ROUND_CONSTANTS[index] as number) +
        (words[index] as number);
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority =
        (a & (working[1] as number)) ^
        (a & (working[2] as number)) ^
        ((working[1] as number) & (working[2] as number));

      working.copyWithin(1, 0);
      working[4] = (working[4] as number) + temporary1;
      working[0] = temporary1 + sum0 + majority;
    }

    for (let index = 0; index < 8; index += 1) {
      state[index] = (state[index] as number) + (working[index] as number);
    }
  }

  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}
