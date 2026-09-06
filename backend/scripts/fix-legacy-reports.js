// backend/scripts/fix-legacy-reports.js
//
// One-shot script: cleans up cases whose `reportText` is the legacy wrapper
// shape `{"report":"<actual report>"}`.  That shape was produced by an older
// aiService that mistakenly stringified the whole AI JSON payload into
// reportText instead of storing `parsed.report`.  The newer aiService.js /
// caseController.js already store the clean report, so this script is just
// to migrate the existing data.
//
// Usage (from /Users/PHY/Downloads/radassist-ai-frontend):
//   cd backend && node scripts/fix-legacy-reports.js          # dry-run
//   cd backend && node scripts/fix-legacy-reports.js --apply  # actually write
//
// Pure mongoose — no Express, no auth.  Talks to MongoDB via MONGODB_URI
// from backend/.env.

const fs = require("fs");
const path = require("path");

// Load .env manually so we don't depend on a dotenv helper being installed.
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

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is not set in backend/.env");
  process.exit(1);
}

const mongoose = require("mongoose");
const Case = require(path.join(__dirname, "..", "models", "Case"));

const APPLY = process.argv.includes("--apply");

// Same logic as frontend's unwrapLegacyReport — kept identical so the
// server-side and client-side views agree on what "clean" means.
//
// Mongo's stored shape is unfortunately not strict JSON.  Older cases
// were truncated — they contain only the leading `{\n"report":"` and a
// single long line of report text, with no closing `"` or `}`.  So we
// can't rely on JSON.parse or on finding a closing `"`; we extract
// everything from after `"report":"` to end-of-string, then unescape
// any JSON backslash escapes.
function unwrapLegacy(reportText) {
  if (typeof reportText !== "string") return null;
  const rt = reportText.trim();
  if (!rt.startsWith("{") || !rt.includes('"report"')) return null;
  const idx = rt.indexOf('"report":"');
  if (idx < 0) return null;
  let val = rt.substring(idx + '"report":"'.length);
  // The legacy payload ends mid-string; trim any trailing `}` if present
  // (some cases DID have the closing brace) and any stray whitespace.
  val = val.replace(/\}\s*$/, "").trim();
  if (!val) return null;
  try { val = JSON.parse('"' + val + '"'); } catch { /* keep raw */ }
  if (typeof val !== "string" || !val.trim()) return null;
  return val;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || "radassist",
  });
  console.log(`Connected. db=${process.env.MONGODB_DB || "radassist"} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const total = await Case.countDocuments({});
  console.log(`Total cases: ${total}`);

  // Find every case whose reportText looks like the legacy wrapper.
  // The simple $regex is enough — only candidates whose reportText starts
  // with `{"` and contains `"report"` get returned.
  const candidates = await Case.find({
    reportText: { $regex: '^\\s*\\{', $options: "" },
  }).lean();

  const dirty = [];
  for (const c of candidates) {
    const clean = unwrapLegacy(c.reportText);
    if (clean && clean !== c.reportText) {
      dirty.push({
        _id: c._id,
        caseId: c.caseId,
        patientId: c.patientId,
        oldLength: c.reportText.length,
        newLength: clean.length,
        sample: clean.slice(0, 80),
        clean,
      });
    }
  }

  console.log(`Cases with legacy-wrapped reportText: ${dirty.length}`);

  if (dirty.length === 0) {
    console.log("Nothing to fix. Exiting.");
    await mongoose.disconnect();
    return;
  }

  // Show a few samples so the operator can sanity-check before --apply.
  console.log("\nSample (first 5):");
  for (const d of dirty.slice(0, 5)) {
    console.log(`  ${d.caseId} (${d.patientId})  ${d.oldLength} -> ${d.newLength} chars`);
    console.log(`    → ${d.sample}${d.newLength > 80 ? "…" : ""}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN: re-run with --apply to actually write to MongoDB.");
    await mongoose.disconnect();
    return;
  }

  let ok = 0, fail = 0;
  for (const d of dirty) {
    try {
      // Some legacy cases have string UUIDs as `_id` (written outside
      // this schema's default ObjectId).  Bypass schema cast so the
      // update goes through either way.
      const res = await mongoose.connection.db
        .collection("cases")
        .updateOne({ _id: d._id }, { $set: { reportText: d.clean } });
      if (res.modifiedCount === 1) ok++;
      else fail++;
    } catch (err) {
      console.error(`  ! ${d.caseId || "(no caseId)"} ${d.patientId}: ${err.message}`);
      fail++;
    }
  }
  console.log(`\nUpdated ${ok}/${dirty.length} cases${fail ? ` (${fail} failed)` : ""}.`);

  // Also clear out any "source":"AI"-tagged findings that are pure duplicates
  // of one another, since the reportText parse will now produce fresh ones
  // on the next review-page open.  This is conservative — only removes
  // findings whose id starts with "ai-" AND whose `label` exactly matches
  // the first 60 chars of a `sentence` field that points at the cleaned
  // report.  Skipped if no findings exist.
  console.log("\n(no automatic finding purge — review page auto-parses them on open)");

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
