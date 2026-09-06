// backend/scripts/fix-data-issues.js
//
// One-shot script: fixes two pre-existing data issues found by the e2e
// test that aren't caused by code bugs but would leave the review page
// showing broken images or "no findings":
//
//   1. Cases with `findings` field missing or null/undefined — set it to
//      `[]` so the Mongoose schema default doesn't kick in later and the
//      `Array.isArray()` check on the frontend stays satisfied.
//   2. Cases with `imageId` pointing at a GridFS file that no longer
//      exists (orphan references) — clear `imageId` so the review page
//      falls back to the "No image" placeholder instead of returning
//      a 404 every time the browser tries to render the X-ray.
//
// Dry-run by default.  Apply with --apply.
//
// Usage (from backend/):
//   node scripts/fix-data-issues.js          # dry-run
//   node scripts/fix-data-issues.js --apply  # actually write

const fs = require("fs");
const path = require("path");

// Load backend/.env manually.
try {
  const envText = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    let val = raw;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
} catch (err) {
  console.error("Could not load backend/.env:", err.message);
  process.exit(1);
}

const mongoose = require("mongoose");
const Case = require(path.join(__dirname, "..", "models", "Case"));

const APPLY = process.argv.includes("--apply");

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "images" });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || "radassist",
  });
  console.log(`Connected. db=${process.env.MONGODB_DB || "radassist"} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // ------------------ 1. findings field missing / null ------------------
  // Mongoose schema has `default: []`, but raw inserts (e.g. legacy dev
  // scripts) can leave the field undefined.  Normalize to [].
  const noFindings = await mongoose.connection.db
    .collection("cases")
    .find({ $or: [{ findings: { $exists: false } }, { findings: null }] })
    .toArray();

  console.log(`\nCases with missing/null findings: ${noFindings.length}`);
  for (const c of noFindings.slice(0, 10)) {
    console.log(`  · ${c.caseId || c._id} (${c.patientId})`);
  }

  // ------------------ 2. orphan imageId references ----------------------
  // A case has imageId but the GridFS bucket doesn't have that file.
  // We probe by querying the GridFS `files` collection directly — that's
  // a cheap metadata-only check (no stream open, no download).
  // We do NOT use openDownloadStream() here: closing a download cursor
  // before it has a chance to emit 'file' / 'error' looks identical to
  // "missing" and gives false positives for every case.
  const casesWithImage = await Case.find({ imageId: { $ne: null } }).lean();
  console.log(`\nProbing ${casesWithImage.length} cases with imageId for GridFS presence...`);

  const orphanIds = [];
  for (const c of casesWithImage) {
    if (!c.imageId) continue;
    try {
      const file = await mongoose.connection.db
        .collection("images.files")
        .findOne({ _id: c.imageId });
      if (!file) {
        orphanIds.push({ _id: c._id, caseId: c.caseId, imageId: String(c.imageId), reason: "GridFS file not found" });
      }
    } catch (err) {
      orphanIds.push({ _id: c._id, caseId: c.caseId, imageId: String(c.imageId), reason: err.message });
    }
  }

  console.log(`Cases with orphan imageId (GridFS file missing): ${orphanIds.length}`);
  for (const o of orphanIds.slice(0, 10)) {
    console.log(`  · ${o.caseId || o._id} (imageId=${o.imageId}) reason=${o.reason}`);
  }

  // ------------------ Dry-run vs apply ---------------------------------
  const total = noFindings.length + orphanIds.length;
  if (total === 0) {
    console.log("\nNothing to fix. Exiting.");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN: would fix ${noFindings.length} findings + ${orphanIds.length} orphan imageId.`);
    console.log("Re-run with --apply to actually write.");
    await mongoose.disconnect();
    return;
  }

  let okF = 0, failF = 0;
  for (const c of noFindings) {
    try {
      const res = await mongoose.connection.db
        .collection("cases")
        .updateOne({ _id: c._id }, { $set: { findings: [] } });
      if (res.modifiedCount === 1) okF++;
      else failF++;
    } catch (err) {
      console.error(`  ! findings fix on ${c.caseId || c._id}: ${err.message}`);
      failF++;
    }
  }
  console.log(`\nNormalized findings: ${okF} ok, ${failF} failed`);

  let okI = 0, failI = 0;
  for (const o of orphanIds) {
    try {
      const res = await mongoose.connection.db
        .collection("cases")
        .updateOne({ _id: o._id }, { $set: { imageId: null, imageFilename: "" } });
      if (res.modifiedCount === 1) okI++;
      else failI++;
    } catch (err) {
      console.error(`  ! imageId fix on ${o.caseId || o._id}: ${err.message}`);
      failI++;
    }
  }
  console.log(`Cleared orphan imageIds: ${okI} ok, ${failI} failed`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
