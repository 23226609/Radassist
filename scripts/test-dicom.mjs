// A tiny uncompressed DICOM chest film becomes a PNG CURV can read.
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { PNG } = require("pngjs");
const dcmjs = require("dcmjs");
const { prepareFilm, dicomToPng, fittedSize, dropInteriorEmptyRows, dropEdgeBlankColumns, exposedField } = require("./utils/dicom.js");
const { shrinkForDisplay } = require("./utils/displayFilm.js");

const DICOM = Buffer.from(
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABESUNNAgAAAFVMBADOAAAAAgABAE9CAAACAAAAAAECAAIAVUkaADEuMi44NDAuMTAwMDguNS4xLjQuMS4xLjEAAgADAFVJQAAxLjIuODI2LjAuMS4zNjgwMDQzLjguNDk4Ljg0NTc5MDQ0ODEzMjQzMzQ4Nzg5Mjk0MjUxNTg4NDY0MjA3NzExAgAQAFVJFAAxLjIuODQwLjEwMDA4LjEuMi4xAAIAEgBVSRwAMS4yLjgyNi4wLjEuMzY4MDA0My44LjQ5OC4xAAIAEwBTSA4AUFlESUNPTSAzLjAuMiAIABYAVUkaADEuMi44NDAuMTAwMDguNS4xLjQuMS4xLjEACAAYAFVJQAAxLjIuODI2LjAuMS4zNjgwMDQzLjguNDk4Ljg0NTc5MDQ0ODEzMjQzMzQ4Nzg5Mjk0MjUxNTg4NDY0MjA3NzExCABgAENTAgBDUigAAgBVUwIAAQAoAAQAQ1MMAE1PTk9DSFJPTUUyICgAEABVUwIAAgAoABEAVVMCAAIAKAAAAVVTAgAQACgAAQFVUwIADAAoAAIBVVMCAAsAKAADAVVTAgAAACgAUBBEUwYAMjAwMC4wKABREERTBgA0MDAwLjAoAFIQRFMEADAuMCAoAFMQRFMEADEuMCDgfxAAT1cAAAgAAAAAAOgDuAugDw==",
  "base64"
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failed += 1;
  }
}

console.log("\n=== dicom film ===");

test("renders an uncompressed DICOM to a 2x2 PNG", () => {
  const png = dicomToPng(DICOM);
  assert.equal(png.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
  const image = PNG.sync.read(png);
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.equal(image.data[0], 0);
  assert.ok(image.data[4] > 40 && image.data[4] < 90);
  assert.ok(image.data[12] > 250);
});

test("a large film is stored at most 1600 pixels on the long edge", () => {
  const fit = fittedSize(3000, 2000);
  assert.equal(Math.max(fit.cols, fit.rows), 1600);
  assert.equal(fit.cols, 1600);
  assert.equal(fit.rows, 1067);
  assert.deepEqual(fittedSize(2, 2), { cols: 2, rows: 2 });
});

test("a large film is stored as a smaller jpeg", () => {
  const { PNG } = require("pngjs");
  const jpeg = require("jpeg-js");
  const png = new PNG({ width: 1800, height: 40 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = i % 255;
    png.data[i + 1] = i % 255;
    png.data[i + 2] = i % 255;
    png.data[i + 3] = 255;
  }
  const raw = PNG.sync.write(png);
  const display = shrinkForDisplay(raw, "image/png");
  assert.equal(display.shrunk, true);
  assert.equal(display.contentType, "image/jpeg");
  assert.ok(display.buffer.length < raw.length);
  const decoded = jpeg.decode(display.buffer);
  assert.equal(decoded.width, 1600);
  assert.ok(display.colScale > 1);
});

function filmWithBlackSide({ collimator = false, black = 12, cols = 40, rows = 20 } = {}) {
  const pixels = new Uint16Array(rows * cols);
  for (let y = 0; y < rows; y += 1) {
    for (let x = black; x < cols; x += 1) pixels[y * cols + x] = 3000;
  }
  const dataset = {
    _meta: { TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"] } },
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.1.1",
    SOPInstanceUID: "1.2.3.4.5",
    StudyInstanceUID: "1.2.3.4",
    SeriesInstanceUID: "1.2.3.4.6",
    Modality: "DX",
    Rows: rows,
    Columns: cols,
    BitsAllocated: 16,
    BitsStored: 12,
    HighBit: 11,
    PixelRepresentation: 0,
    SamplesPerPixel: 1,
    PhotometricInterpretation: "MONOCHROME2",
    WindowCenter: 2048,
    WindowWidth: 4096,
    RescaleSlope: 1,
    RescaleIntercept: 0,
    PixelData: pixels.buffer,
  };
  if (collimator) {
    dataset.CollimatorShape = "RECTANGULAR";
    dataset.CollimatorLeftVerticalEdge = black;
    dataset.CollimatorRightVerticalEdge = cols;
    dataset.CollimatorUpperHorizontalEdge = 0;
    dataset.CollimatorLowerHorizontalEdge = rows;
  }
  return Buffer.from(dcmjs.data.datasetToBuffer(dataset));
}

test("a rectangular collimator keeps the exposed field and drops the black detector", () => {
  const field = exposedField({
    CollimatorShape: "RECTANGULAR",
    CollimatorLeftVerticalEdge: 616,
    CollimatorRightVerticalEdge: 3056,
    CollimatorUpperHorizontalEdge: 0,
    CollimatorLowerHorizontalEdge: 2540,
  }, 2544, 3056);
  assert.deepEqual(field, { left: 616, top: 0, right: 3056, bottom: 2540, width: 2440, height: 2540 });
  assert.equal(exposedField({ CollimatorLeftVerticalEdge: -1, CollimatorRightVerticalEdge: 10, CollimatorUpperHorizontalEdge: 0, CollimatorLowerHorizontalEdge: 10 }, 10, 10), null);
  const image = PNG.sync.read(dicomToPng(filmWithBlackSide({ collimator: true })));
  assert.equal(image.width, 28);
  assert.equal(image.height, 20);
  assert.ok(image.data[0] > 100, "the stored film must start at the chest, not the black detector");
});

test("a thick black side bar is left out even when the collimator tag is missing", () => {
  const image = PNG.sync.read(dicomToPng(filmWithBlackSide({ collimator: false })));
  assert.equal(image.width, 28);
  assert.ok(image.data[0] > 100);
  const cols = 20;
  const rows = 4;
  const values = new Float32Array(rows * cols);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 4; x < cols; x += 1) values[y * cols + x] = 100;
  }
  const kept = dropEdgeBlankColumns(values, rows, cols);
  assert.equal(kept.cols, cols, "a thin dark edge stays");
});

test("interior full-width zero rows are left out, edge collimation stays", () => {
  const cols = 4;
  const rows = 12;
  const values = new Float32Array(rows * cols);
  for (let x = 0; x < cols; x += 1) values[1 * cols + x] = 10 + x;
  for (let y = 2; y <= 9; y += 1) values.fill(0, y * cols, (y + 1) * cols);
  for (let x = 0; x < cols; x += 1) values[10 * cols + x] = 50 + x;
  const dropped = dropInteriorEmptyRows(values, rows, cols);
  assert.equal(dropped.rows, 4);
  assert.deepEqual([...dropped.values.slice(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...dropped.values.slice(4, 8)], [10, 11, 12, 13]);
  assert.deepEqual([...dropped.values.slice(8, 12)], [50, 51, 52, 53]);
  assert.deepEqual([...dropped.values.slice(12, 16)], [0, 0, 0, 0]);
});

test("prepareFilm stores a png and leaves a jpeg alone", () => {
  const film = prepareFilm({
    originalname: "chest.dcm",
    mimetype: "application/dicom",
    buffer: DICOM,
    size: DICOM.length,
  });
  assert.equal(film.contentType, "image/png");
  assert.equal(film.filename, "chest.png");
  assert.equal(film.buffer.slice(0, 4).toString("hex"), "89504e47");

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const plain = prepareFilm({
    originalname: "chest.jpg",
    mimetype: "image/jpeg",
    buffer: jpeg,
    size: jpeg.length,
  });
  assert.equal(plain.buffer, jpeg);
  assert.equal(plain.filename, "chest.jpg");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
