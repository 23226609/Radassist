// A full-size DICOM becomes a multi-megabyte PNG. The examination page and
// the Word/PDF report only need a film that fits on screen.

const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const MAX_EDGE = 1600;
const JPEG_QUALITY = 82;

function isPng(buffer) {
  return buffer && buffer.length > 8 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG';
}

function isJpeg(buffer) {
  return buffer && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function fittedSize(cols, rows) {
  const edge = Math.max(cols, rows);
  if (!edge || edge <= MAX_EDGE) {
    return { cols, rows, rowScale: 1, colScale: 1 };
  }
  const scale = MAX_EDGE / edge;
  const outCols = Math.max(1, Math.round(cols * scale));
  const outRows = Math.max(1, Math.round(rows * scale));
  return {
    cols: outCols,
    rows: outRows,
    rowScale: rows / outRows,
    colScale: cols / outCols,
  };
}

function sampleRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    const srcRow = sy * sw;
    const dstRow = y * dw;
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const s = (srcRow + sx) * 4;
      const d = (dstRow + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = 255;
    }
  }
  return out;
}

function encodeJpeg(rgba, width, height) {
  const data = rgba instanceof Uint8Array && rgba.byteOffset === 0
    ? rgba
    : Uint8Array.from(rgba);
  const encoded = jpeg.encode({ data, width, height }, JPEG_QUALITY);
  return Buffer.from(encoded.data);
}

function shrinkForDisplay(buffer, contentType = '') {
  const png = isPng(buffer);
  const jpg = isJpeg(buffer);
  if (!png && !jpg) {
    return {
      buffer,
      contentType: contentType || 'application/octet-stream',
      rowScale: 1,
      colScale: 1,
      shrunk: false,
    };
  }
  const image = png
    ? PNG.sync.read(buffer)
    : jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  const fit = fittedSize(image.width, image.height);
  const rgba = fit.cols === image.width && fit.rows === image.height
    ? image.data
    : sampleRGBA(image.data, image.width, image.height, fit.cols, fit.rows);
  const encoded = encodeJpeg(rgba, fit.cols, fit.rows);
  const smaller = encoded.length + (80 * 1024) < buffer.length;
  const resized = fit.rowScale !== 1 || fit.colScale !== 1;
  if (!smaller && !resized) {
    return {
      buffer,
      contentType: jpg ? 'image/jpeg' : (contentType || 'image/png'),
      rowScale: 1,
      colScale: 1,
      shrunk: false,
      width: image.width,
      height: image.height,
    };
  }
  return {
    buffer: encoded,
    contentType: 'image/jpeg',
    rowScale: fit.rowScale,
    colScale: fit.colScale,
    shrunk: true,
    width: fit.cols,
    height: fit.rows,
  };
}

module.exports = { shrinkForDisplay, fittedSize };
