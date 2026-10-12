// A tiny uncompressed DICOM chest film becomes a PNG CURV can read.
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { PNG } = require("pngjs");
const { prepareFilm, dicomToPng } = require("./utils/dicom.js");

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
