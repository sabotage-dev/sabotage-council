/*
 * A minimal protocol-buffer field walker for the one antigravity record the ratifier reads: the conversation DB's
 * `gen_metadata.data`, one row per model call. agy publishes no schema; the field numbers below were read from
 * records on 1.5.7 (and match the 1.4.12 research notes), so they are declared per tested version and anything
 * that does not decode fails closed.
 */

export interface PbField {
  field: number;
  wire: number;
  /** Varint value (wire 0). */
  int: bigint | null;
  /** Bytes (wire 2, or the raw 8 or 4 bytes of wire 1 and 5). */
  bytes: Uint8Array | null;
}

/** Decodes one message level. Throws on a truncated or unknown wire type. */
export function pbFields(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++] as number;
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) return result;
      if (shift > 70n) throw new Error('varint too long');
    }
  };
  const take = (n: number): Uint8Array => {
    if (i + n > buf.length) throw new Error('truncated field');
    const b = buf.subarray(i, i + n);
    i += n;
    return b;
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, int: varint(), bytes: null });
    else if (wire === 2) out.push({ field, wire, int: null, bytes: take(Number(varint())) });
    else if (wire === 1) out.push({ field, wire, int: null, bytes: take(8) });
    else if (wire === 5) out.push({ field, wire, int: null, bytes: take(4) });
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** The bytes of every length-delimited field at a path of field numbers (each step may repeat). */
export function pbAt(buf: Uint8Array, path: readonly number[]): Uint8Array[] {
  let level: Uint8Array[] = [buf];
  for (const step of path) {
    const next: Uint8Array[] = [];
    for (const b of level) for (const f of pbFields(b)) if (f.field === step && f.wire === 2 && f.bytes) next.push(f.bytes);
    level = next;
  }
  return level;
}

export const utf8 = (b: Uint8Array): string => Buffer.from(b).toString('utf8');
