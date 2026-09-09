// Zero-dependency ULID (https://github.com/ulid/spec) built on node:crypto.
// Monotonicity within a millisecond is NOT guaranteed (not required here).

import { randomBytes } from "node:crypto";

/** Crockford base32 alphabet (no I, L, O, U). */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const DECODE: Record<string, number> = {};
for (let i = 0; i < ENCODING.length; i++) {
  const ch = ENCODING[i];
  if (ch !== undefined) DECODE[ch] = i;
}

function encodeTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
    throw new RangeError(`ulid: time must be an integer in [0, 2^48), got ${timeMs}`);
  }
  let t = timeMs;
  const chars = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    chars[i] = ENCODING[t % 32] as string;
    t = Math.floor(t / 32);
  }
  return chars.join("");
}

function encodeRandom(): string {
  // 80 bits of randomness -> 16 base32 chars (5 bits each).
  const bytes = randomBytes(10);
  let out = "";
  let buffer = 0;
  let bitsInBuffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      out += ENCODING[(buffer >>> bitsInBuffer) & 0x1f];
      buffer &= (1 << bitsInBuffer) - 1;
    }
  }
  return out;
}

/** Generate a ULID for the given timestamp (defaults to now). */
export function ulid(timeMs: number = Date.now()): string {
  return encodeTime(timeMs) + encodeRandom();
}

/** Decode the millisecond timestamp encoded in a ULID. Throws on malformed input. */
export function ulidTime(id: string): number {
  if (typeof id !== "string" || id.length !== TIME_LEN + RANDOM_LEN || !ULID_RE.test(id)) {
    throw new TypeError(`ulid: malformed ULID "${id}"`);
  }
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const ch = id[i] as string;
    const v = DECODE[ch];
    if (v === undefined) {
      throw new TypeError(`ulid: invalid character "${ch}" in "${id}"`);
    }
    t = t * 32 + v;
  }
  return t;
}

/** True if the string is a well-formed ULID. */
export function isUlid(id: string): boolean {
  return ULID_RE.test(id);
}
