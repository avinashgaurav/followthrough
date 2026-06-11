// ULID: 48-bit timestamp + 80-bit randomness, Crockford base32. Sortable, unique.
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = now;
  const t = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    t[i] = ENC[time % 32]!;
    time = Math.floor(time / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let r = "";
  for (let i = 0; i < 16; i++) r += ENC[rand[i]! % 32]!;
  return t.join("") + r;
}

/** Short human-facing handle for an insight id, e.g. INS-3F8KQ2 */
export function insightHandle(id: string): string {
  return `INS-${id.slice(-6)}`;
}
