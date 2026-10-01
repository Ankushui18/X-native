import { buildPdf } from "../pdf.ts";

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

const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const pdf = await buildPdf(rgba, 2, 1, 2, 1, "quality", jpeg);
const bytes = new Uint8Array(await pdf.arrayBuffer());
const text = new TextDecoder("latin1").decode(bytes);

t("PDF declares the article's 1.7 format", text.startsWith("%PDF-1.7"));
t("PDF embeds the quality-encoded JPEG with DCTDecode", text.includes("/Filter /DCTDecode"));
t("transparent pixels retain a soft mask", text.includes("/SMask 6 0 R") && text.includes("/ColorSpace /DeviceGray"));
t("JPEG stream bytes are embedded", bytes.some((byte, i) => byte === 0xff && bytes[i + 1] === 0xd8));

const lossless = await buildPdf(new Uint8Array([1, 2, 3, 255]), 1, 1, 1, 1);
const losslessText = await lossless.text();
t("the lossless fallback stays Flate-compressed", losslessText.includes("/Filter /FlateDecode"));

console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
if (fail) process.exitCode = 1;
