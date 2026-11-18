import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

function encode(n: bigint, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = ALPHABET[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

/** Sortable random id: 10 chars of millisecond time + 10 chars of randomness (ULID-like, lowercase). */
export function newId(now: number = Date.now()): string {
  const rand = BigInt("0x" + randomBytes(7).toString("hex")) & ((1n << 50n) - 1n);
  return encode(BigInt(now), 10) + encode(rand, 10);
}

export function shortRandom(len = 4): string {
  return encode(BigInt("0x" + randomBytes(4).toString("hex")), 7).slice(-len);
}

/** A valid entity key (see KEY_PATTERN) derived from free text. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "x";
}
