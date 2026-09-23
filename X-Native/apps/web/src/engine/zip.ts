/**
 * Minimal ZIP reader.
 *
 * A `.sketch` file is a ZIP archive of JSON documents, so opening one needs
 * nothing more than central-directory parsing plus inflate. The browser
 * supplies inflate via DecompressionStream, so this stays dependency-free
 * rather than pulling a ZIP library in for one format.
 *
 * Reads the central directory (not the local headers) because only the
 * central directory is authoritative about compressed sizes — streamed
 * archives write zeroes into the local header and defer the real values to a
 * data descriptor.
 */

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;

export class Zip {
  private view: DataView;
  private bytes: Uint8Array<ArrayBuffer>;
  private entries = new Map<string, Entry>();

  constructor(buf: ArrayBuffer) {
    this.bytes = new Uint8Array(buf);
    this.view = new DataView(buf);
    this.readCentralDirectory();
  }

  /** Every file path in the archive. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  private readCentralDirectory() {
    // The end-of-central-directory record sits at the tail, after a comment of
    // unknown length, so scan backwards for its signature.
    let eocd = -1;
    const min = Math.max(0, this.bytes.length - 0xffff - 22);
    for (let i = this.bytes.length - 22; i >= min; i--) {
      if (this.view.getUint32(i, true) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a ZIP archive");

    let count = this.view.getUint16(eocd + 10, true);
    let dirStart = this.view.getUint32(eocd + 16, true);

    // ZIP64: the 32-bit fields saturate and the real values live in a separate
    // record. Sketch files with many pages can cross that boundary.
    if (dirStart === 0xffffffff || count === 0xffff) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (this.view.getUint32(i, true) === EOCD64_LOCATOR) {
          const z64 = Number(this.view.getBigUint64(i + 8, true));
          count = Number(this.view.getBigUint64(z64 + 32, true));
          dirStart = Number(this.view.getBigUint64(z64 + 48, true));
          break;
        }
      }
    }

    let p = dirStart;
    for (let i = 0; i < count; i++) {
      if (this.view.getUint32(p, true) !== CENTRAL) break;
      const method = this.view.getUint16(p + 10, true);
      let compressedSize = this.view.getUint32(p + 20, true);
      const nameLen = this.view.getUint16(p + 28, true);
      const extraLen = this.view.getUint16(p + 30, true);
      const commentLen = this.view.getUint16(p + 32, true);
      let offset = this.view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(this.bytes.subarray(p + 46, p + 46 + nameLen));

      // Oversized values are parked in the ZIP64 extra field.
      if (compressedSize === 0xffffffff || offset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e < end) {
          const id = this.view.getUint16(e, true);
          const size = this.view.getUint16(e + 2, true);
          if (id === 0x0001) {
            let q = e + 4;
            // Fields appear only if the corresponding 32-bit value saturated,
            // in a fixed order: uncompressed, compressed, offset.
            q += 8; // uncompressed size, unused here
            if (compressedSize === 0xffffffff) {
              compressedSize = Number(this.view.getBigUint64(q, true));
              q += 8;
            }
            if (offset === 0xffffffff) offset = Number(this.view.getBigUint64(q, true));
            break;
          }
          e += 4 + size;
        }
      }

      this.entries.set(name, { name, method, compressedSize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** Raw bytes of one entry, inflating if needed. */
  async read(name: string): Promise<Uint8Array<ArrayBuffer>> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`missing ${name}`);
    // The local header repeats the name and extra field with its own lengths,
    // which may differ from the central directory's.
    const nameLen = this.view.getUint16(e.offset + 26, true);
    const extraLen = this.view.getUint16(e.offset + 28, true);
    const start = e.offset + 30 + nameLen + extraLen;
    const raw = this.bytes.subarray(start, start + e.compressedSize) as Uint8Array<ArrayBuffer>;
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`unsupported compression ${e.method} in ${name}`);
    const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    if (!DS) throw new Error("this browser cannot inflate ZIP entries");
    const ds = new DS("deflate-raw");
    const w = ds.writable.getWriter();
    void w.write(raw);
    void w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  async readText(name: string): Promise<string> {
    return new TextDecoder().decode(await this.read(name));
  }

  async readJson(name: string): Promise<unknown> {
    return JSON.parse(await this.readText(name));
  }
}
