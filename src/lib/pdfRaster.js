// The PDF writer in reportExport.js uses the standard Helvetica font, which has no Chinese. Text it cannot
// draw (the 繁體中文 lay summary, or a Chinese name) is drawn here on a canvas, with the viewer's own CJK font,
// and written into the PDF as one small image per line. Only the browser is needed, nothing is downloaded.

import { PAGE } from "./reportExport.js";

// What WinAnsi (the PDF font) can show; anything else needs drawing.
const WIN_ANSI_OK = /^[\u0000-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]*$/;
export const needsRaster = (text) => !WIN_ANSI_OK.test(String(text ?? ""));

const CJK = "\\u2e80-\\u9fff\\uff00-\\uffef\\u3000-\\u303f";
const TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, "g");
const NO_LINE_START = /^[，。、；：！？）】」』》,.;:!?)\]]$/;
const FONT = '"PingFang TC","Microsoft JhengHei","Noto Sans CJK TC","Heiti TC","Hiragino Sans CNS","Arial Unicode MS",sans-serif';
const SCALE = 3;
const WIDTH_PT = PAGE.width - PAGE.margin * 2;

/** Break text into lines no wider than `fits` allows. Chinese may break between any two characters. */
export function wrapLines(text, fits) {
  const lines = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const token of para.match(TOKEN) || []) {
      if (line && !fits(line + token) && !NO_LINE_START.test(token)) {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(token) ? "" : token;
      } else line += token;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Draw `text` as lines of JPEG. Resolves to [{ film, w, h }] in PDF points. */
export async function rasterText(text, { size = 11, bold = false } = {}) {
  const lineHeight = Math.round(size * 1.45);
  const probe = document.createElement("canvas").getContext("2d");
  const font = `${bold ? "bold " : ""}${size * SCALE}px ${FONT}`;
  probe.font = font;
  const lines = wrapLines(text, (s) => probe.measureText(s).width / SCALE <= WIDTH_PT);
  const out = [];
  for (const line of lines) {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH_PT * SCALE;
    canvas.height = lineHeight * SCALE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(line, 0, size * SCALE * 1.05);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    out.push({ film: { bytes, width: canvas.width, height: canvas.height, components: 3 }, w: WIDTH_PT, h: lineHeight });
  }
  return out;
}

const STYLE = { title: [16, true], heading: [12, true], section: [11, true], signature: [11, false], field: [11, false], line: [11, false] };

/** Swap every block the PDF font cannot draw for `rasterlines`. Other blocks are left as they are. */
export async function rasterBlocks(blocks, raster = rasterText) {
  const out = [];
  for (const b of blocks) {
    const text = b.type === "field" ? `${b.label}: ${b.value}` : b.text;
    if (STYLE[b.type] && needsRaster(text)) {
      const [size, bold] = STYLE[b.type];
      out.push({ type: "rasterlines", lines: await raster(text, { size, bold }), gap: 0 });
    } else out.push(b);
  }
  return out;
}
