/**
 * Minimal PDF writer.
 *
 * The export panel offers PDF, but the browser has no PDF encoder, so the old
 * code downloaded an SVG with the extension rewritten — the user asked for a
 * PDF and silently got a different file type. This produces a real PDF: a
 * single page holding the rendered artwork as a lossless Flate-compressed
 * image, with a soft mask so transparency survives.
 *
 * It is raster-backed rather than vector, so export at 2x/3x for print. A
 * vector writer (real paths and embedded font subsets) is the natural next
 * step and is what `crates/x-render`'s `export_pdf` already does natively.
 */

/** Deflate via CompressionStream, falling back to a stored (uncompressed)
 *  zlib stream when the browser lacks it, so export never hard-fails. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return zlibStored(bytes);
  try {
    const cs = new CS("deflate");
    const writer = cs.writable.getWriter();
    void writer.write(bytes);
    void writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return zlibStored(bytes);
  }
}

/** zlib container using only stored deflate blocks — valid input for any
 *  FlateDecode reader, just uncompressed. */
function zlibStored(data: Uint8Array<ArrayBuffer>): Uint8Array {
  const blocks: number[] = [0x78, 0x01]; // zlib header, no preset dictionary
  const MAX = 0xffff;
  for (let i = 0; i < data.length || i === 0; i += MAX) {
    const chunk = data.subarray(i, Math.min(i + MAX, data.length));
    const last = i + MAX >= data.length ? 1 : 0;
    blocks.push(last, chunk.length & 0xff, (chunk.length >> 8) & 0xff);
    blocks.push(~chunk.length & 0xff, (~chunk.length >> 8) & 0xff);
    for (const b of chunk) blocks.push(b);
    if (chunk.length === 0) break;
  }
  // Adler-32 of the uncompressed data.
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff);
  return new Uint8Array(blocks);
}

const enc = new TextEncoder();

/**
 * Build a one-page PDF from RGBA pixels.
 *
 * @param rgba   width*height*4 samples, straight (non-premultiplied) alpha.
 * @param wPx    pixel width of the bitmap.
 * @param hPx    pixel height of the bitmap.
 * @param ptW    page width in PDF points (72dpi), i.e. the design size.
 * @param ptH    page height in points.
 */
export async function buildPdf(
  rgba: Uint8Array<ArrayBuffer>,
  wPx: number,
  hPx: number,
  ptW: number,
  ptH: number,
  title = "",
): Promise<Blob> {
  const count = wPx * hPx;
  const rgb = new Uint8Array(new ArrayBuffer(count * 3));
  const alpha = new Uint8Array(new ArrayBuffer(count));
  let opaque = true;
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  const rgbZ = await deflate(rgb);
  const alphaZ = opaque ? null : await deflate(alpha);

  // Objects are emitted in order; `offsets` records each one's byte position
  // for the xref table, which must be exact or readers reject the file.
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (chunk: Uint8Array | string) => {
    const u8 = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(u8);
    pos += u8.length;
  };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  const smaskId = 6;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW.toFixed(2)} ${ptH.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  obj(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
      `/Length ${rgbZ.length}${alphaZ ? ` /SMask ${smaskId} 0 R` : ""} >>`,
    rgbZ,
  );
  // Place the image to cover the page; PDF's origin is bottom-left.
  const content = enc.encode(`q\n${ptW.toFixed(2)} 0 0 ${ptH.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`);
  obj(5, `<< /Length ${content.length} >>`, content);
  if (alphaZ) {
    obj(
      smaskId,
      `<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
        `/Length ${alphaZ.length} >>`,
      alphaZ,
    );
  }
  const infoId = alphaZ ? 7 : 6;
  obj(infoId, `<< /Title (${title.replace(/([()\\])/g, "\\$1")}) /Producer (X-Native) >>`);

  const maxId = infoId;
  const xref = pos;
  let table = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) {
    table += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(table);
  push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
