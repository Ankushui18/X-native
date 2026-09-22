/**
 * Kiwi binary decoder.
 *
 * Kiwi is the self-describing wire format Figma uses inside `.fig`: every file
 * carries its own schema, so the decoder needs no baked-in field dictionary
 * and keeps working as Figma's format evolves.
 *
 * Ported from `crates/x-format/src/kiwi.rs`, which is unreachable from the web
 * app (no wasm bridge is buildable in this environment). Decode only — writing
 * `.fig` is not a goal.
 */

export type KiwiValue =
  | boolean
  | number
  | string
  | KiwiValue[]
  | { [k: string]: KiwiValue };

type TyTag =
  | { b: "bool" | "byte" | "int" | "uint" | "float" | "str" | "int64" | "uint64" }
  | { def: number };

interface Field {
  name: string;
  ty: TyTag;
  isArray: boolean;
  value: number;
}

interface Def {
  name: string;
  kind: "enum" | "struct" | "message";
  fields: Field[];
}

export interface Schema {
  defs: Def[];
}

const BUILTINS = ["bool", "byte", "int", "uint", "float", "str", "int64", "uint64"] as const;
const KINDS = ["enum", "struct", "message"] as const;
const MAX_DEPTH = 512;

class Reader {
  i = 0;
  constructor(readonly d: Uint8Array) {}

  byte(): number {
    if (this.i >= this.d.length) throw new Error("kiwi: read past end");
    return this.d[this.i++];
  }

  varuint(): number {
    let v = 0;
    let sh = 0;
    for (;;) {
      const b = this.byte();
      // >>> 0 keeps the accumulator unsigned; JS bitwise ops are signed 32-bit.
      v = (v | ((b & 127) << sh)) >>> 0;
      sh += 7;
      if ((b & 128) === 0 || sh >= 35) break;
    }
    return v;
  }

  varint(): number {
    const v = this.varuint();
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }

  varuint64(): bigint {
    let v = 0n;
    let sh = 0n;
    for (;;) {
      const b = this.byte();
      if (b & 128 && sh < 56n) {
        v |= BigInt(b & 127) << sh;
        sh += 7n;
      } else {
        v |= BigInt(b) << sh;
        break;
      }
    }
    return v;
  }

  varint64(): bigint {
    const v = this.varuint64();
    const x = v >> 1n;
    return v & 1n ? ~x : x;
  }

  string(): string {
    const start = this.i;
    while (this.i < this.d.length && this.d[this.i] !== 0) this.i++;
    if (this.i >= this.d.length) throw new Error("kiwi: unterminated string");
    const s = new TextDecoder().decode(this.d.subarray(start, this.i));
    this.i++; // NUL
    return s;
  }

  /** Kiwi's compact float: a single 0 byte means 0.0, otherwise four bytes
   *  little-endian with the bits rotated right by 9. */
  varfloat(): number {
    if (this.i >= this.d.length) throw new Error("kiwi: read past end");
    if (this.d[this.i] === 0) {
      this.i++;
      return 0;
    }
    if (this.i + 4 > this.d.length) throw new Error("kiwi: truncated float");
    const bits =
      (this.d[this.i] |
        (this.d[this.i + 1] << 8) |
        (this.d[this.i + 2] << 16) |
        (this.d[this.i + 3] << 24)) >>>
      0;
    this.i += 4;
    const rot = ((bits >>> 9) | (bits << 23)) >>> 0;
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, rot, true);
    return new DataView(buf).getFloat32(0, true);
  }

  bytes(n: number): Uint8Array {
    const e = this.i + n;
    if (e > this.d.length) throw new Error("kiwi: read past end");
    const b = this.d.subarray(this.i, e);
    this.i = e;
    return b;
  }
}

/** Negative type codes are builtins (~index); non-negative are definition
 *  indices into the schema's own def list. */
function bindType(t: number): TyTag {
  if (t < 0) {
    const name = BUILTINS[~t] ?? "uint";
    return { b: name };
  }
  return { def: t };
}

export function decodeSchema(data: Uint8Array): Schema {
  const r = new Reader(data);
  const n = r.varuint();
  if (n > 100_000) throw new Error("kiwi: implausible schema");
  const defs: Def[] = [];
  for (let i = 0; i < n; i++) {
    const name = r.string();
    const kind = KINDS[r.byte()];
    if (!kind) throw new Error("kiwi: bad definition kind");
    const fc = r.varuint();
    if (fc > 4000) throw new Error("kiwi: implausible field count");
    const fields: Field[] = [];
    for (let f = 0; f < fc; f++) {
      const fname = r.string();
      const t = r.varint();
      const isArray = (r.byte() & 1) !== 0;
      const value = r.varuint();
      fields.push({ name: fname, ty: bindType(t), isArray, value });
    }
    defs.push({ name, kind, fields });
  }
  // Enum members carry no stored type: the value slot is the member index and
  // the payload is a plain varuint.
  for (const d of defs) {
    if (d.kind === "enum") for (const f of d.fields) f.ty = { b: "uint" };
  }
  return { defs };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export class Decoder {
  private r: Reader;
  constructor(
    private schema: Schema,
    data: Uint8Array,
  ) {
    this.r = new Reader(data);
  }

  get consumed(): number {
    return this.r.i;
  }
  get total(): number {
    return this.r.d.length;
  }

  decodeRoot(root: string): KiwiValue {
    const idx = this.schema.defs.findIndex((d) => d.name === root);
    if (idx < 0) throw new Error(`kiwi: no definition ${root}`);
    return this.decodeDef(idx, 0);
  }

  private decodeDef(idx: number, depth: number): KiwiValue {
    if (depth > MAX_DEPTH) throw new Error("kiwi: nesting limit");
    const d = this.schema.defs[idx];
    if (!d) throw new Error("kiwi: definition index out of range");

    if (d.kind === "enum") {
      const v = this.r.varuint();
      return d.fields.find((f) => f.value === v)?.name ?? `#${v}`;
    }

    const out: Record<string, KiwiValue> = {};
    if (d.kind === "struct") {
      // Structs write every field in declaration order, with no selectors.
      for (const f of d.fields) out[f.name] = this.decodeField(f, depth);
      return out;
    }
    // Messages are a selector-tagged stream terminated by a 0 selector.
    for (;;) {
      const sel = this.r.varuint();
      if (sel === 0) break;
      const f = d.fields.find((x) => x.value === sel);
      if (!f) throw new Error(`kiwi: unknown field ${sel} in ${d.name}`);
      out[f.name] = this.decodeField(f, depth);
    }
    return out;
  }

  private decodeField(f: Field, depth: number): KiwiValue {
    if (f.isArray) {
      const n = this.r.varuint();
      // A byte array is binary payload, not a list of numbers; hex keeps it
      // printable and matches what the Rust importer produces.
      if ("b" in f.ty && f.ty.b === "byte") return hex(this.r.bytes(n));
      const arr: KiwiValue[] = [];
      const limit = Math.min(n, 4_000_000);
      for (let i = 0; i < limit; i++) arr.push(this.decodeOne(f.ty, depth + 1));
      return arr;
    }
    return this.decodeOne(f.ty, depth);
  }

  private decodeOne(ty: TyTag, depth: number): KiwiValue {
    if ("def" in ty) return this.decodeDef(ty.def, depth);
    switch (ty.b) {
      case "bool":
        return this.r.byte() !== 0;
      case "byte":
        return this.r.byte();
      case "int":
        return this.r.varint();
      case "uint":
        return this.r.varuint();
      case "float":
        return this.r.varfloat();
      case "str":
        return this.r.string();
      case "int64":
        return Number(this.r.varint64());
      case "uint64":
        return Number(this.r.varuint64());
    }
  }
}
