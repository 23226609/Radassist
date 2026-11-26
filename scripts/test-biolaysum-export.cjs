// scripts/test-biolaysum-export.cjs: EXPERIMENT ONLY. Reads (never writes) one case from the live database and
// saves its endorsed report text and its stored Azure English lay summary to /tmp/biolaysum/case.json, for
// scripts/test-biolaysum.py. Calls no model. Run from the project folder:  node scripts/test-biolaysum-export.cjs

const fs = require('fs');
const path = require('path');
const BACKEND = path.join(__dirname, '..', 'backend');
const backend = (p) => require(path.join(BACKEND, p));
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });

const CASE_ID = process.argv[2] || 'CASE-MVQGTW5U-Y7Y';
(async () => {
  await backend('config/db')();
  const c = await backend('models/Case').findOne({ caseId: CASE_ID }).select('caseId patientId status reportText laySummary').lean();
  if (!c) throw new Error(`${CASE_ID} not found`);
  const out = {
    caseId: c.caseId,
    patientId: c.patientId,
    status: c.status,
    // The same text the Azure lay summary is given: the endorsed report without thinking or remarks.
    endorsedReport: backend('utils/azureFindings').clinicalReportText(c.reportText || ''),
    azureEnglish: c.laySummary && c.laySummary.english,
  };
  fs.mkdirSync('/tmp/biolaysum', { recursive: true });
  fs.writeFileSync('/tmp/biolaysum/case.json', JSON.stringify(out, null, 2));
  console.log(`saved ${out.caseId} (${out.status}) to /tmp/biolaysum/case.json`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
