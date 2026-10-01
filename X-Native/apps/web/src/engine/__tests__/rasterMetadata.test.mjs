import { setRasterExportDpi } from "../rasterMetadata.ts";

let pass = 0;
let fail = 0;
const t = (name, condition) => {
  if (condition) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
};
const u32 = (bytes, at) => ((bytes[at] * 0x1000000) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const png = () => new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82, ...Array(13).fill(0), 0, 0, 0, 0,
  0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
]);

const source = png();
const taggedPng = new Uint8Array(await (await setRasterExportDpi(new Blob([source], { type: "image/png" }), "PNG", 2)).arrayBuffer());
let offset = 8;
let phys;
let physCount = 0;
let afterIhdr = false;
while (offset + 12 <= taggedPng.length) {
  const length = u32(taggedPng, offset);
  const type = String.fromCharCode(...taggedPng.subarray(offset + 4, offset + 8));
  const end = offset + 12 + length;
  if (type === "IHDR") afterIhdr = true;
  if (type === "pHYs") {
    phys = taggedPng.subarray(offset + 8, offset + 8 + length);
    physCount++;
    t("PNG pHYs checksum is valid", u32(taggedPng, end - 4) === crc32(taggedPng.subarray(offset + 4, end - 4)));
    t("PNG DPI chunk follows IHDR", afterIhdr);
  }
  offset = end;
}
t("PNG metadata declares 144 DPI at 2x", !!phys && u32(phys, 0) === 5669 && u32(phys, 4) === 5669 && phys[8] === 1);
t("PNG contains one DPI chunk", physCount === 1);
const retaggedPng = new Uint8Array(await (await setRasterExportDpi(new Blob([taggedPng]), "PNG", 3)).arrayBuffer());
t("updating PNG DPI replaces rather than duplicates pHYs", (String.fromCharCode(...retaggedPng).match(/pHYs/g) ?? []).length === 1);

const jpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
  0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
  0x00, 0x60, 0x00, 0x60, 0x00, 0x00,
  0xff, 0xda, 0x00, 0x02, 0xff, 0xd9,
]);
const taggedJpeg = new Uint8Array(await (await setRasterExportDpi(new Blob([jpeg], { type: "image/jpeg" }), "JPG", 2)).arrayBuffer());
t("JPEG retains one JFIF density marker", taggedJpeg.length === jpeg.length);
t("JPEG density uses inches and 144 DPI", taggedJpeg[13] === 1 && taggedJpeg[14] === 0 && taggedJpeg[15] === 144 && taggedJpeg[16] === 0 && taggedJpeg[17] === 144);
const noJfif = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
const insertedJpeg = new Uint8Array(await (await setRasterExportDpi(new Blob([noJfif]), "JPG", 1)).arrayBuffer());
t("JPEG without JFIF receives a density segment", insertedJpeg[2] === 0xff && insertedJpeg[3] === 0xe0 && insertedJpeg[15] === 72);

console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
if (fail) process.exitCode = 1;
