// backend/scripts/dump-cases.js
//
// Read-only diagnostic: dump every case's reportText length + first 100
// chars so we can confirm what shape the data is in right now.
//
// Usage: cd backend && node scripts/dump-cases.js

const fs = require("fs");
const path = require("path");

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

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || "radassist",
  });

  const cases = await Case.find({}).sort({ createdAt: -1 }).lean();
  console.log(`Found ${cases.length} cases\n`);
  console.log("caseId          patientId          status      findings  reportLen  first80");
  console.log("--------------- ------------------ ----------- --------- ---------- -------------------");
  for (const c of cases) {
    const rt = c.reportText || "";
    const looksLikeJson = rt.trim().startsWith("{") && rt.includes('"report"');
    const flag = looksLikeJson ? " ⚠️" : "";
    const first80 = rt.slice(0, 80).replace(/\n/g, "\\n");
    console.log(
      `${(c.caseId || "").padEnd(15)}` +
      ` ${(c.patientId || "").padEnd(18)}` +
      ` ${(c.status || "").padEnd(11)}` +
      ` ${String((c.findings || []).length).padStart(7)}   ` +
      ` ${String(rt.length).padStart(8)}  ` +
      `${first80}${flag}`
    );
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
