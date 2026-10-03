const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function readU32(data: Uint8Array, at: number): number {
  return ((data[at] * 0x1000000) + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3]) >>> 0;
}

function writeU32(data: Uint8Array, at: number, value: number): void {
  data[at] = (value >>> 24) & 0xff;
  data[at + 1] = (value >>> 16) & 0xff;
  data[at + 2] = (value >>> 8) & 0xff;
  data[at + 3] = value & 0xff;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, content: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(content.length + 12);
  writeU32(chunk, 0, content.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(content, 8);
  writeU32(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}

function withPngDpi(data: Uint8Array, dpi: number): Uint8Array {
  if (data.length < 33 || !PNG_SIGNATURE.every((byte, i) => data[i] === byte)) return data;
  const ppm = Math.max(1, Math.round(dpi / 0.0254));
  const phys = new Uint8Array(9);
  writeU32(phys, 0, ppm);
  writeU32(phys, 4, ppm);
  phys[8] = 1; // pixels per metre
  const physChunk = pngChunk("pHYs", phys);
  const chunks: Uint8Array[] = [data.subarray(0, 8)];
  let insertAfter = -1;
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = readU32(data, offset);
    const end = offset + 12 + length;
    if (end > data.length) return data;
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (type === "IHDR") {
      insertAfter = chunks.length;
      chunks.push(data.subarray(offset, end));
    } else if (type !== "pHYs") {
      chunks.push(data.subarray(offset, end));
    }
    offset = end;
  }
  if (offset !== data.length || insertAfter < 0) return data;
  chunks.splice(insertAfter + 1, 0, physChunk);
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    output.set(chunk, at);
    at += chunk.length;
  }
  return output;
}

function jpegDensitySegment(dpi: number): Uint8Array {
  const density = Math.max(1, Math.min(65535, Math.round(dpi)));
  // APP0 JFIF segment: 1 inch units, equal horizontal and vertical density.
  return new Uint8Array([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x01,
    (density >>> 8) & 0xff, density & 0xff,
    (density >>> 8) & 0xff, density & 0xff,
    0x00, 0x00,
  ]);
}

function withJpegDpi(data: Uint8Array, dpi: number): Uint8Array {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) return data;
  let offset = 2;
  while (offset + 4 <= data.length && data[offset] === 0xff) {
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of image data
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (data[offset + 2] << 8) | data[offset + 3];
    if (length < 2 || offset + 2 + length > data.length) return data;
    const jfif = marker === 0xe0 && length >= 16 &&
      data[offset + 4] === 0x4a && data[offset + 5] === 0x46 &&
      data[offset + 6] === 0x49 && data[offset + 7] === 0x46 && data[offset + 8] === 0;
    if (jfif) {
      const out = data.slice();
      const density = Math.max(1, Math.min(65535, Math.round(dpi)));
      out[offset + 11] = 1; // inches
      out[offset + 12] = (density >>> 8) & 0xff;
      out[offset + 13] = density & 0xff;
      out[offset + 14] = (density >>> 8) & 0xff;
      out[offset + 15] = density & 0xff;
      return out;
    }
    offset += 2 + length;
  }
  const header = jpegDensitySegment(dpi);
  const out = new Uint8Array(data.length + header.length);
  out.set(data.subarray(0, 2), 0);
  out.set(header, 2);
  out.set(data.subarray(2), 2 + header.length);
  return out;
}

/** Add Figma-compatible 72 × export-scale DPI metadata to a canvas PNG/JPEG. */
export async function setRasterExportDpi(blob: Blob, format: "PNG" | "JPG", scale: number): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dpi = Math.max(1, 72 * (Number.isFinite(scale) ? scale : 1));
  const tagged = format === "PNG" ? withPngDpi(bytes, dpi) : withJpegDpi(bytes, dpi);
  if (tagged === bytes) return blob;
  const buffer = tagged.buffer.slice(tagged.byteOffset, tagged.byteOffset + tagged.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: blob.type });
}
