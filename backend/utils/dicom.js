// Turn an uncompressed DICOM chest film into a PNG.
// CURV reads a raster image, not a DICOM container. The review page does too.

const { PNG } = require('pngjs');
const dcmjs = require('dcmjs');
const { shrinkForDisplay } = require('./displayFilm');

const COMPRESSED = /^1\.2\.840\.10008\.1\.2\.[45]/;
const MAX_EDGE = 1600;

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
  const pad = firstNumber(dataset.PixelPaddingValue, null);
  for (let i = 0; i < rows * cols * channels; i += 1) {
    let n;
    if (bits === 8) n = raw[i];
    else n = signed ? raw.readInt16LE(i * 2) : raw.readUInt16LE(i * 2);
    if (!signed && bits !== 8) n &= mask;
    values[i] = n;
  }
  let frameRows = rows;
  let frameCols = cols;
  let frameValues = values;
  // A viewer shows the exposed field. The black detector outside the
  // collimator is not part of the photograph.
  const field = exposedField(dataset, rows, cols);
  if (field) {
    const cropped = cropFrame(frameValues, frameRows, frameCols, channels, field);
    frameRows = cropped.rows;
    frameCols = cropped.cols;
    frameValues = cropped.values;
  }
  if (channels === 1) {
    const trimmed = dropEdgeBlankColumns(frameValues, frameRows, frameCols, pad);
    frameRows = trimmed.rows;
    frameCols = trimmed.cols;
    frameValues = trimmed.values;
  }
  if (channels !== 1) return { rows: frameRows, cols: frameCols, channels, values: frameValues };
  // Full-width zero rows through the chest (MIMIC-CXR blanks burned-in text).
  // The viewer shows the film with those rows left out. Edge collimation stays.
  const dropped = dropInteriorEmptyRows(frameValues, frameRows, frameCols, pad);
  return { rows: dropped.rows, cols: frameCols, channels, values: dropped.values };
}

function edgeValue(dataset, names, fallback) {
  for (const name of names) {
    if (dataset[name] != null && dataset[name] !== '') return firstNumber(dataset[name], fallback);
  }
  return fallback;
}

function exposedField(dataset, rows, cols) {
  const shape = String(dataset.CollimatorShape || dataset.ShutterShape || '').toUpperCase();
  const names = [
    'CollimatorLeftVerticalEdge', 'CollimatorRightVerticalEdge', 'CollimatorUpperHorizontalEdge', 'CollimatorLowerHorizontalEdge',
    'ShutterLeftVerticalEdge', 'ShutterRightVerticalEdge', 'ShutterUpperHorizontalEdge', 'ShutterLowerHorizontalEdge',
  ];
  const tagged = names.some((key) => dataset[key] != null && dataset[key] !== '');
  if (!tagged && shape !== 'RECTANGULAR') return null;
  let left = edgeValue(dataset, ['CollimatorLeftVerticalEdge', 'ShutterLeftVerticalEdge'], 0);
  let right = edgeValue(dataset, ['CollimatorRightVerticalEdge', 'ShutterRightVerticalEdge'], cols);
  let top = edgeValue(dataset, ['CollimatorUpperHorizontalEdge', 'ShutterUpperHorizontalEdge'], 0);
  let bottom = edgeValue(dataset, ['CollimatorLowerHorizontalEdge', 'ShutterLowerHorizontalEdge'], rows);
  if (![left, right, top, bottom].every(Number.isFinite)) return null;
  left = Math.max(0, Math.min(cols - 1, Math.round(left)));
  top = Math.max(0, Math.min(rows - 1, Math.round(top)));
  right = Math.max(0, Math.min(cols, Math.round(right)));
  bottom = Math.max(0, Math.min(rows, Math.round(bottom)));
  if (right - left < cols * 0.5 || bottom - top < rows * 0.5) return null;
  if (left === 0 && top === 0 && right === cols && bottom === rows) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function cropFrame(values, rows, cols, channels, field) {
  const { left, top, width, height } = field;
  const next = new Float32Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const src = ((top + y) * cols + left) * channels;
    next.set(values.subarray(src, src + width * channels), y * width * channels);
  }
  return { values: next, rows: height, cols: width, channels };
}

function dropEdgeBlankColumns(values, rows, cols, pad = null) {
  if (!values || rows < 1 || cols < 16) return { values, rows, cols };
  const blank = new Uint8Array(cols);
  for (let x = 0; x < cols; x += 1) {
    let n = 0;
    for (let y = 0; y < rows; y += 1) {
      const v = values[y * cols + x];
      if (v === 0 || (pad != null && v === pad)) n += 1;
    }
    blank[x] = n / rows > 0.95 ? 1 : 0;
  }
  let left = 0;
  while (left < cols && blank[left]) left += 1;
  let right = cols - 1;
  while (right >= left && blank[right]) right -= 1;
  if (left < 8) left = 0;
  if (cols - 1 - right < 8) right = cols - 1;
  const width = right - left + 1;
  if (width >= cols || width < cols * 0.5) return { values, rows, cols };
  return cropFrame(values, rows, cols, 1, { left, top: 0, width, height: rows });
}

function dropInteriorEmptyRows(values, rows, cols, pad = null) {
  if (!values || rows < 3 || cols < 1) return { values, rows };
  const blankFrac = new Float32Array(rows);
  for (let y = 0; y < rows; y += 1) {
    let blank = 0;
    const off = y * cols;
    for (let x = 0; x < cols; x += 1) {
      const n = values[off + x];
      if (n === 0 || (pad != null && n === pad)) blank += 1;
    }
    blankFrac[y] = blank / cols;
  }
  const drop = new Uint8Array(rows);
  let y = 0;
  let removed = 0;
  while (y < rows) {
    if (blankFrac[y] <= 0.95) {
      y += 1;
      continue;
    }
    let y0 = y;
    let y1 = y;
    while (y1 < rows && blankFrac[y1] > 0.95) y1 += 1;
    if (y0 > 0 && y1 < rows && (y1 - y0) >= 8) {
      while (y0 > 0 && blankFrac[y0 - 1] > 0.35) y0 -= 1;
      while (y1 < rows && blankFrac[y1] > 0.35) y1 += 1;
      // Keep a real edge. Do not eat the collimated border.
      if (y0 > 0 && y1 < rows) {
        drop.fill(1, y0, y1);
        removed += y1 - y0;
      }
    }
    y = Math.max(y + 1, y1);
  }
  if (!removed) return { values, rows };
  const next = new Float32Array((rows - removed) * cols);
  const src = [];
  let dst = 0;
  for (let r = 0; r < rows; r += 1) {
    if (drop[r]) continue;
    next.set(values.subarray(r * cols, (r + 1) * cols), dst * cols);
    src.push(r);
    dst += 1;
  }
  const keptRows = rows - removed;
  // Soften the cut where a blank band was removed. A long blend is what
  // drew the grey stripes; this only eases the two rows that now meet.
  const span = 18;
  if (keptRows > span * 4) {
    for (let i = 1; i < src.length; i += 1) {
      if (src[i] - src[i - 1] <= 1) continue;
      const a = Math.max(0, i - span);
      const b = Math.min(keptRows - 1, i + span - 1);
      const above = next.slice(a * cols, (a + 1) * cols);
      const below = next.slice(b * cols, (b + 1) * cols);
      const gap = b - a;
      for (let r = a; r <= b; r += 1) {
        const t = (r - a) / gap;
        const off = r * cols;
        for (let x = 0; x < cols; x += 1) next[off + x] = above[x] * (1 - t) + below[x] * t;
      }
    }
  }
  return { values: next, rows: keptRows };
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

function fittedSize(cols, rows) {
  const edge = Math.max(cols, rows);
  if (edge <= MAX_EDGE) return { cols, rows };
  const scale = MAX_EDGE / edge;
  return {
    cols: Math.max(1, Math.round(cols * scale)),
    rows: Math.max(1, Math.round(rows * scale)),
  };
}

function sampleAt(values, channels, cols, rows, x, y, channel) {
  const sx = Math.min(cols - 1, Math.max(0, x));
  const sy = Math.min(rows - 1, Math.max(0, y));
  return values[(sy * cols + sx) * channels + channel];
}

function renderDicom(buffer) {
  const dataset = readDataset(buffer);
  const raw = pixelBytes(dataset.PixelData);
  const frame = samples(dataset, raw);
  const { channels, values } = frame;
  const fit = fittedSize(frame.cols, frame.rows);
  const png = new PNG({ width: fit.cols, height: fit.rows, colorType: 6 });
  if (channels !== 1 && channels !== 3) {
    throw new Error('This DICOM pixel layout is not a chest-film grayscale or RGB image.');
  }
  const gray = channels === 1 ? toGray(dataset, values) : null;
  for (let y = 0; y < fit.rows; y += 1) {
    const sy = Math.floor(((y + 0.5) * frame.rows) / fit.rows);
    for (let x = 0; x < fit.cols; x += 1) {
      const sx = Math.floor(((x + 0.5) * frame.cols) / fit.cols);
      const o = (y * fit.cols + x) * 4;
      if (gray) {
        const g = gray[Math.min(gray.length - 1, sy * frame.cols + sx)];
        png.data[o] = g;
        png.data[o + 1] = g;
        png.data[o + 2] = g;
      } else {
        png.data[o] = sampleAt(values, 3, frame.cols, frame.rows, sx, sy, 0);
        png.data[o + 1] = sampleAt(values, 3, frame.cols, frame.rows, sx, sy, 1);
        png.data[o + 2] = sampleAt(values, 3, frame.cols, frame.rows, sx, sy, 2);
      }
      png.data[o + 3] = 255;
    }
  }
  return {
    buffer: PNG.sync.write(png),
    rows: frame.rows,
    cols: frame.cols,
    width: fit.cols,
    height: fit.rows,
  };
}

function dicomToPng(buffer) {
  return renderDicom(buffer).buffer;
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
  const rendered = renderDicom(buffer);
  const png = rendered.buffer;
  const display = shrinkForDisplay(png, 'image/png');
  const stored = display.shrunk ? display.buffer : png;
  const asJpeg = display.shrunk;
  const base = (name.replace(/\.dcm$/i, '') || 'xray').replace(/\.(png|jpe?g)$/i, '');
  let spacing = pixelSpacingMm(buffer);
  if (spacing && rendered.width && rendered.height) {
    spacing = [
      spacing[0] * (rendered.rows / rendered.height),
      spacing[1] * (rendered.cols / rendered.width),
    ];
  }
  return {
    buffer: stored,
    filename: `${base}.${asJpeg ? 'jpg' : 'png'}`,
    contentType: asJpeg ? 'image/jpeg' : 'image/png',
    size: stored.length,
    pixelSpacingMm: spacing,
  };
}

module.exports = {
  isDicomBuffer, dicomToPng, prepareFilm, fittedSize,
  dropInteriorEmptyRows, dropEdgeBlankColumns, exposedField, cropFrame,
};
