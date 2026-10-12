// Turn an uncompressed DICOM chest film into a PNG.
// CURV reads a raster image, not a DICOM container. The review page does too.

const { PNG } = require('pngjs');
const dcmjs = require('dcmjs');

const COMPRESSED = /^1\.2\.840\.10008\.1\.2\.[45]/;

function isDicomBuffer(buffer, filename = '', mimetype = '') {
  if (/\.dcm$/i.test(filename) || /dicom/i.test(mimetype)) return true;
  return buffer && buffer.length > 132 && buffer.slice(128, 132).toString('ascii') === 'DICM';
}

function firstNumber(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return firstNumber(value[0], fallback);
  const n = parseFloat(String(value).split('\\')[0]);
  return Number.isFinite(n) ? n : fallback;
}

function pixelBytes(pixelData) {
  if (pixelData instanceof ArrayBuffer) return Buffer.from(pixelData);
  if (ArrayBuffer.isView(pixelData)) {
    return Buffer.from(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);
  }
  if (Array.isArray(pixelData)) {
    const parts = pixelData.map((part) => {
      if (part instanceof ArrayBuffer) return Buffer.from(part);
      if (ArrayBuffer.isView(part)) return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      return null;
    }).filter(Boolean);
    if (parts.length === 1) return parts[0];
    if (parts.length > 1) {
      throw new Error('This DICOM uses compressed pixels. Export an uncompressed chest film, or upload a PNG.');
    }
  }
  throw new Error('This DICOM has no pixel data.');
}

function readDataset(buffer) {
  const copy = Buffer.from(buffer);
  const dicom = dcmjs.data.DicomMessage.readFile(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
  const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict);
  const syntax = dicom.meta?.TransferSyntaxUID || dataset.TransferSyntaxUID || '';
  if (COMPRESSED.test(String(syntax))) {
    throw new Error('This DICOM uses compressed pixels. Export an uncompressed chest film, or upload a PNG.');
  }
  return dataset;
}

function samples(dataset, raw) {
  const rows = firstNumber(dataset.Rows, 0);
  const cols = firstNumber(dataset.Columns, 0);
  const bits = firstNumber(dataset.BitsAllocated, 16);
  const stored = firstNumber(dataset.BitsStored, bits);
  const signed = firstNumber(dataset.PixelRepresentation, 0) === 1;
  const channels = firstNumber(dataset.SamplesPerPixel, 1);
  if (!rows || !cols) throw new Error('This DICOM does not say how large the film is.');
  const bytesPer = bits === 8 ? 1 : 2;
  const expected = rows * cols * channels * bytesPer;
  if (raw.length < expected) throw new Error('This DICOM pixel data is shorter than the film size.');
  const mask = stored > 0 && stored < bits ? (1 << stored) - 1 : 0xffff;
  const values = new Float32Array(rows * cols * channels);
  for (let i = 0; i < rows * cols * channels; i += 1) {
    let n;
    if (bits === 8) n = raw[i];
    else n = signed ? raw.readInt16LE(i * 2) : raw.readUInt16LE(i * 2);
    if (!signed && bits !== 8) n &= mask;
    values[i] = n;
  }
  return { rows, cols, channels, values };
}

function toGray(dataset, frame) {
  const slope = firstNumber(dataset.RescaleSlope, 1);
  const intercept = firstNumber(dataset.RescaleIntercept, 0);
  const scaled = frame.map((n) => n * slope + intercept);
  let low;
  let high;
  const center = firstNumber(dataset.WindowCenter, null);
  const width = firstNumber(dataset.WindowWidth, null);
  if (center != null && width != null && width > 0) {
    low = center - width / 2;
    high = center + width / 2;
  } else {
    low = Infinity;
    high = -Infinity;
    for (const n of scaled) {
      if (n < low) low = n;
      if (n > high) high = n;
    }
    if (!Number.isFinite(low) || high <= low) {
      low = 0;
      high = 1;
    }
  }
  const invert = String(dataset.PhotometricInterpretation || '').toUpperCase() === 'MONOCHROME1';
  const gray = new Uint8Array(scaled.length);
  for (let i = 0; i < scaled.length; i += 1) {
    let y = (scaled[i] - low) / (high - low);
    if (y < 0) y = 0;
    if (y > 1) y = 1;
    if (invert) y = 1 - y;
    gray[i] = Math.round(y * 255);
  }
  return gray;
}

function pixelSpacingMm(buffer) {
  try {
    const dataset = readDataset(buffer);
    const raw = dataset.PixelSpacing || dataset.ImagerPixelSpacing;
    if (raw == null || raw === '') return null;
    const parts = Array.isArray(raw) ? raw : String(raw).split('\\');
    const row = parseFloat(parts[0]);
    const col = parseFloat(parts[1] != null ? parts[1] : parts[0]);
    if (!Number.isFinite(row) || !Number.isFinite(col) || row <= 0 || col <= 0) return null;
    return [row, col];
  } catch {
    return null;
  }
}

function dicomToPng(buffer) {
  const dataset = readDataset(buffer);
  const raw = pixelBytes(dataset.PixelData);
  const { rows, cols, channels, values } = samples(dataset, raw);
  const png = new PNG({ width: cols, height: rows });
  if (channels === 3) {
    for (let i = 0; i < rows * cols; i += 1) {
      const o = i * 4;
      png.data[o] = values[i * 3];
      png.data[o + 1] = values[i * 3 + 1];
      png.data[o + 2] = values[i * 3 + 2];
      png.data[o + 3] = 255;
    }
  } else if (channels === 1) {
    const gray = toGray(dataset, values);
    for (let i = 0; i < gray.length; i += 1) {
      const o = i * 4;
      png.data[o] = gray[i];
      png.data[o + 1] = gray[i];
      png.data[o + 2] = gray[i];
      png.data[o + 3] = 255;
    }
  } else {
    throw new Error('This DICOM pixel layout is not a chest-film grayscale or RGB image.');
  }
  return PNG.sync.write(png);
}

function prepareFilm(file) {
  const name = file.originalname || 'xray';
  const type = file.mimetype || '';
  const buffer = file.buffer;
  if (!isDicomBuffer(buffer, name, type)) {
    return {
      buffer,
      filename: name,
      contentType: type || 'image/jpeg',
      size: file.size || buffer.length,
    };
  }
  const png = dicomToPng(buffer);
  const base = name.replace(/\.dcm$/i, '') || 'xray';
  return {
    buffer: png,
    filename: base.toLowerCase().endsWith('.png') ? base : `${base}.png`,
    contentType: 'image/png',
    size: png.length,
    pixelSpacingMm: pixelSpacingMm(buffer),
  };
}

module.exports = { isDicomBuffer, dicomToPng, prepareFilm };
