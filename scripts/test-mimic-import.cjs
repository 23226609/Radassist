// scripts/test-mimic-import.cjs
//
// The MIMIC-CXR cohort import: cohort choice, report sections, the case it
// would write, and the dry-run default. No database, network, CURV or Azure.
//
//   node scripts/test-mimic-import.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mimic = require('../backend/utils/mimic');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

const REPORT = [
  '                                 FINAL REPORT',
  ' EXAMINATION:  CHEST (PA AND LAT)',
  ' ',
  ' INDICATION:  ___F with new onset ascites  // eval for infection',
  ' ',
  ' TECHNIQUE:  Chest PA and lateral',
  ' ',
  ' COMPARISON:  None.',
  ' ',
  ' FINDINGS: ',
  ' ',
  ' Heart size is normal. Small right pleural effusion.',
  ' ',
  ' IMPRESSION: ',
  ' ',
  ' Small right pleural effusion.',
].join('\n');

const HEADER = 'dicom_id,subject_id,study_id,PerformedProcedureStepDescription,ViewPosition,Rows,Columns,StudyDate,StudyTime,ProcedureCodeSequence_CodeMeaning,ViewCodeSequence_CodeMeaning,PatientOrientationCodeSequence_CodeMeaning';
function metaRow(dicom, subject, study, view, date = '21800506', time = '213524.015') {
  return `${dicom},${subject},${study},"CHEST (PA AND LAT)",${view},2544,3056,${date},${time},"CHEST (PA AND LAT)","postero-anterior","Erect"`;
}

const CSV = [
  HEADER,
  metaRow('d-a-lat', 10000001, 50000001, 'LATERAL'),
  metaRow('d-a-pa-late', 10000001, 50000002, 'PA', '21810101', '101010.000'),
  metaRow('d-a-pa', 10000001, 50000001, 'PA', '21800506', '213524.015'),
  metaRow('d-a-ap', 10000001, 50000003, 'AP', '21790101', '080000.000'),
  metaRow('d-b-ap', 10000002, 50000010, 'AP'),
  metaRow('d-c-pa', 10000003, 50000020, 'PA'),
  metaRow('d-d-pa', 10000004, 50000030, 'PA'),
  metaRow('d-e-ll', 10000005, 50000040, 'LL'),
  metaRow('d-f-pa', 10000006, 50000050, 'PA'),
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-test-'));
const metadataFile = path.join(tmp, 'metadata.csv.gz');
fs.writeFileSync(metadataFile, zlib.gzipSync(CSV));

console.log('\n=== metadata and cohort ===');

test('CSV cells keep quoted commas and quotes', () => {
  assert.deepStrictEqual(mimic.parseCsvLine('a,"b,c","d ""e"""'), ['a', 'b,c', 'd "e"']);
});

(async () => {
  const rows = await mimic.readFrontalMetadata(metadataFile);

  test('only frontal PA and AP rows are kept from the gzipped metadata', () => {
    assert.deepStrictEqual(rows.map((r) => r.dicom_id).sort(), ['d-a-ap', 'd-a-pa', 'd-a-pa-late', 'd-b-ap', 'd-c-pa', 'd-d-pa', 'd-f-pa']);
  });

  const picked = mimic.selectCohort(rows, { count: 10 });

  test('one frontal film per distinct subject, with PA preferred over AP', () => {
    const subjects = picked.map((p) => p.subjectId);
    assert.strictEqual(new Set(subjects).size, subjects.length);
    assert.deepStrictEqual([...subjects].sort(), ['10000001', '10000002', '10000003', '10000004', '10000006']);
    const a = picked.find((p) => p.subjectId === '10000001');
    assert.strictEqual(a.view, 'PA');
    assert.strictEqual(a.dicomId, 'd-a-pa', 'the earliest PA study is used');
  });

  test('PA subjects come before AP-only subjects', () => {
    const views = picked.map((p) => p.view);
    assert.strictEqual(views[views.length - 1], 'AP');
    assert.deepStrictEqual(views.filter((v) => v === 'AP').length, 1);
  });

  test('the same seed picks the same subjects, another seed may differ', () => {
    const again = mimic.selectCohort(rows, { count: 3, seed: 'radassist' });
    assert.deepStrictEqual(again.map((p) => p.subjectId), mimic.selectCohort(rows, { count: 3 }).map((p) => p.subjectId));
    assert.strictEqual(again.length, 3);
  });

  test('spare candidates are marked beyond the wanted count', () => {
    const list = mimic.selectCohort(rows, { count: 2, spare: 2 });
    assert.deepStrictEqual(list.map((p) => p.spare), [false, false, true, true]);
  });

  test('paths and URLs point at the file URLs on PhysioNet', () => {
    const a = picked.find((p) => p.subjectId === '10000001');
    assert.strictEqual(a.jpg, 'files/p10/p10000001/s50000001/d-a-pa.jpg');
    assert.strictEqual(a.report, 'files/p10/p10000001/s50000001.txt');
    const urls = mimic.urlLists(picked, { dicom: 2 });
    assert.ok(urls.jpg.includes('https://physionet.org/files/mimic-cxr-jpg/2.1.0/files/p10/p10000001/s50000001/d-a-pa.jpg'));
    assert.ok(urls.reports.includes('https://physionet.org/files/mimic-cxr/2.1.0/files/p10/p10000001/s50000001.txt'));
    assert.strictEqual(urls.dicom.length, 2, 'DICOM only for a small set');
    assert.ok(urls.dicom.every((u) => u.endsWith('.dcm') && u.includes('/mimic-cxr/2.1.0/')));
  });

  console.log('\n=== official report sections ===');

  test('the indication is taken verbatim and no other section is used', () => {
    const found = mimic.indicationOf(REPORT);
    assert.strictEqual(found.section, 'INDICATION');
    assert.strictEqual(found.text, '___F with new onset ascites  // eval for infection');
  });

  test('a multi-line indication is kept as written', () => {
    const text = ' INDICATION:  Cough and fever.\n   Rule out pneumonia.\n \n TECHNIQUE: PA';
    assert.strictEqual(mimic.indicationOf(text).text, 'Cough and fever.\n   Rule out pneumonia.');
  });

  test('a clinical history section is used when there is no indication', () => {
    const found = mimic.indicationOf(' CLINICAL HISTORY: Shortness of breath.\n FINDINGS: Clear.');
    assert.strictEqual(found.section, 'CLINICAL HISTORY');
    assert.strictEqual(found.text, 'Shortness of breath.');
  });

  test('a report with no indication, or only blanks, gives no history', () => {
    assert.strictEqual(mimic.indicationOf(' FINDINGS: Clear.\n IMPRESSION: None.'), null);
    assert.strictEqual(mimic.indicationOf(' INDICATION: ___\n FINDINGS: Clear.'), null);
    assert.strictEqual(mimic.indicationOf(''), null);
  });

  test('study date and time are kept as the clock reading in UTC', () => {
    assert.strictEqual(mimic.studyDateTime('21800506', '213524.015').toISOString(), '2180-05-06T21:35:24.000Z');
    assert.strictEqual(mimic.studyDateTime('21800506', '93524.5').toISOString(), '2180-05-06T09:35:24.000Z');
    assert.strictEqual(mimic.studyDateTime('', '1'), null);
  });

  console.log('\n=== the case that would be written ===');

  const entry = picked.find((p) => p.subjectId === '10000001');
  const fields = mimic.buildCaseFields(entry, {
    reportText: REPORT,
    indication: mimic.indicationOf(REPORT),
    imageId: 'img-1',
    imageSize: 1234,
  });

  test('the patient is given an ordinary name, and the same subject keeps it', () => {
    const a = mimic.personName('10000032');
    const again = mimic.personName('10000032');
    assert.strictEqual(a.name, again.name);
    assert.ok(a.firstName && a.lastName);
    assert.ok(!/MIMIC|10000032|\d/.test(a.name));
    const fields = mimic.buildCaseFields(entry, {
      reportText: REPORT,
      indication: mimic.indicationOf(REPORT),
    });
    assert.strictEqual(fields.patientName, mimic.personName(entry.subjectId).name);
    assert.ok(!fields.patientName.startsWith('MIMIC'));
    const ids = Array.from({ length: 400 }, (_, i) => String(10000000 + i));
    const assigned = mimic.assignPersonNames(ids, ['Mei Chen', 'Ka Yan Lee']);
    assert.strictEqual(assigned.size, 400);
    const seen = new Set([...assigned.values()].map((p) => p.name));
    assert.strictEqual(seen.size, 400);
    assert.ok(!seen.has('Mei Chen') && !seen.has('Ka Yan Lee'));
  });

  test('ids cannot collide with demo ids', () => {
    assert.strictEqual(fields.patientId, 'PT-MIMIC-10000001');
    assert.strictEqual(fields.caseId, 'CASE-MIMIC-50000001');
    assert.ok(!/^PT-20\d\d-/.test(fields.patientId) && !/^CASE-DEMO/.test(fields.caseId));
  });

  test('the history is the indication; nothing else about the patient is invented', () => {
    assert.strictEqual(fields.history, '___F with new onset ascites  // eval for infection');
    for (const key of ['medicines', 'heartRate', 'labResults', 'observations']) assert.ok(!(key in fields), key);
    assert.strictEqual(fields.age, '');
    assert.strictEqual(fields.sex, '');
  });

  test('the case is waiting for AI: no draft, no tags, no boxes, not endorsed', () => {
    assert.strictEqual(fields.status, 'pending');
    assert.strictEqual(fields.analysisState, 'none');
    assert.strictEqual(fields.reportText, '');
    assert.deepStrictEqual(fields.findingTags, []);
    assert.deepStrictEqual(fields.findings, []);
    assert.strictEqual(fields.comment, '');
    assert.ok(!('finalizedBy' in fields) && !('finalizedAt' in fields));
  });

  test('the official report is kept apart as labelled source text', () => {
    assert.strictEqual(fields.sourceReport.label, 'MIMIC report');
    assert.strictEqual(fields.sourceReport.text, REPORT);
    assert.strictEqual(fields.sourceReport.subjectId, '10000001');
    assert.strictEqual(fields.sourceReport.studyId, '50000001');
    assert.strictEqual(fields.sourceReport.dicomId, 'd-a-pa');
    assert.ok(!fields.reportText.includes('Small right pleural effusion'), 'the MIMIC findings are not copied into the draft');
  });

  test('view and film details come from the metadata, with no pixel spacing', () => {
    assert.strictEqual(fields.view, 'PA');
    assert.strictEqual(fields.imageContentType, 'image/jpeg');
    assert.ok(fields.examinedAt instanceof Date);
    for (const key of ['pixelSpacingMm', 'imagerPixelSpacingMm', 'dicomPixelSpacingMm']) assert.ok(!(key in fields), key);
  });

  test('the fields are a valid Case, with the source report kept in its own field', () => {
    const mongoose = require('../backend/node_modules/mongoose');
    const Case = require('../backend/models/Case');
    const doc = new Case({ ...fields, imageId: new mongoose.Types.ObjectId() });
    assert.strictEqual(doc.validateSync(), undefined);
    assert.strictEqual(doc.sourceReport.label, 'MIMIC report');
    assert.strictEqual(doc.status, 'pending');
    assert.strictEqual(doc.history, '___F with new onset ascites  // eval for infection');
    assert.strictEqual(doc.reportText, '');
  });

  console.log('\n=== downloaded files ===');

  const jpgDir = path.join(tmp, 'jpg');
  const reportDir = path.join(tmp, 'reports');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0xff, 0xd9]);
  function put(dir, rel, data) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  const subjectsBySpec = Object.fromEntries(picked.map((p) => [p.subjectId, p]));
  put(jpgDir, subjectsBySpec['10000001'].jpg, jpeg);
  put(reportDir, subjectsBySpec['10000001'].report, REPORT);
  put(jpgDir, path.basename(subjectsBySpec['10000003'].jpg), jpeg); // flat, as aria2 saves it
  put(reportDir, path.basename(subjectsBySpec['10000003'].report), REPORT);
  put(jpgDir, subjectsBySpec['10000004'].jpg, Buffer.from('not a jpeg'));
  put(reportDir, subjectsBySpec['10000004'].report, REPORT);
  put(jpgDir, subjectsBySpec['10000006'].jpg, jpeg);
  put(reportDir, subjectsBySpec['10000006'].report, ' FINDINGS: Clear.');
  // subject 10000002 has neither file

  test('usable films are gathered from wget or aria2 layouts, and skips are counted', () => {
    const { usable, skipped } = mimic.gatherLocal(picked, { jpgDir, reportDir, limit: 10 });
    assert.deepStrictEqual(usable.map((u) => u.entry.subjectId).sort(), ['10000001', '10000003']);
    assert.strictEqual(skipped.notJpeg, 1);
    assert.strictEqual(skipped.noIndication, 1);
    assert.strictEqual(skipped.noImage, 1);
  });

  test('a report is kept when no JPEG was downloaded', () => {
    const only = path.join(tmp, 'reports-only');
    const entry = { subjectId: '10000002', studyId: '50000010', dicomId: '', view: '', jpg: 'missing.jpg', report: 'note.txt' };
    put(only, 'note.txt', REPORT);
    const { usable, skipped } = mimic.gatherLocal([entry], {
      jpgDir: path.join(tmp, 'no-such-jpg'),
      reportDir: only,
      requireImage: false,
    });
    assert.strictEqual(usable.length, 1);
    assert.strictEqual(usable[0].image, null);
    assert.strictEqual(skipped.noImage, 0);
    const bare = mimic.buildCaseFields(entry, { reportText: REPORT, indication: mimic.indicationOf(REPORT) });
    assert.strictEqual(bare.imageId, null);
    assert.strictEqual(bare.imageFilename, '');
    assert.strictEqual(bare.imageSize, 0);
    assert.strictEqual(bare.history, '___F with new onset ascites  // eval for infection');
  });

  test('the limit stops the gathering', () => {
    const { usable, skipped } = mimic.gatherLocal(picked, { jpgDir, reportDir, limit: 1 });
    assert.strictEqual(usable.length, 1);
    assert.ok(skipped.beyondLimit >= 1);
  });

  console.log('\n=== the script ===');

  const script = path.join(ROOT, 'backend', 'scripts', 'import-mimic.js');
  const data = path.join(tmp, 'data');
  const run = (...args) => spawnSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MONGODB_URI: '' },
  });

  const planned = run('plan', '--metadata', metadataFile, '--data', data, '--count', '3', '--spare', '1', '--dicom', '2');

  test('plan writes the URL lists and the selection, and downloads nothing', () => {
    assert.strictEqual(planned.status, 0, planned.stderr);
    const dir = path.join(data, 'plan');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'urls-jpg.txt'), 'utf8').trim().split('\n').length, 4);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'urls-reports.txt'), 'utf8').trim().split('\n').length, 4);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'urls-dicom.txt'), 'utf8').trim().split('\n').length, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8')).selection.length, 4);
    assert.ok(!fs.existsSync(path.join(data, 'jpg')));
  });

  // Put a plan on disk that matches the fixtures above.
  const fullData = path.join(tmp, 'full');
  fs.mkdirSync(path.join(fullData, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(fullData, 'plan', 'selection.json'), JSON.stringify({ selection: picked }));
  fs.cpSync(jpgDir, path.join(fullData, 'jpg'), { recursive: true });
  fs.cpSync(reportDir, path.join(fullData, 'reports'), { recursive: true });
  const snapshot = () => fs.readdirSync(fullData, { recursive: true }).sort().join('|');
  const before = snapshot();
  const dry = run('import', '--data', fullData);

  test('import is a dry run by default: it reports, writes nothing and needs no database', () => {
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.ok(dry.stdout.includes('DRY RUN: 2 cases ready'), dry.stdout);
    assert.ok(dry.stdout.includes('PT-MIMIC-10000001'));
    assert.ok(dry.stdout.includes('Nothing was written'));
    assert.ok(!/MongoDB connected/.test(dry.stdout));
    assert.strictEqual(snapshot(), before);
  });

  test('a data folder that git does not ignore is refused', () => {
    const res = run('plan', '--metadata', metadataFile, '--data', path.join(ROOT, 'not-ignored-mimic-dir'));
    assert.notStrictEqual(res.status, 0);
    assert.ok(/not ignored by git/.test(res.stderr), res.stderr);
    assert.ok(!fs.existsSync(path.join(ROOT, 'not-ignored-mimic-dir')));
  });

  console.log('\n=== nothing sensitive is committed, nothing external is called ===');

  const ignored = (file) => spawnSync('git', ['check-ignore', '-q', file], { cwd: ROOT }).status === 0;

  test('the data directory, .env, .netrc and DICOM files are git-ignored', () => {
    for (const file of ['data/mimic/jpg/files/p10/x.jpg', 'data/mimic/reports/a.txt', 'backend/.env', '.env', '.netrc', 'x/film.dcm']) {
      assert.ok(ignored(file), `${file} is not ignored`);
    }
  });

  test('no MIMIC file, credential or .env is tracked', () => {
    const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
    const bad = tracked.filter((f) => /(^|\/)(data\/mimic|\.netrc|\.env)(\/|$)|mimic-cxr|\.dcm$/i.test(f) && !/\.example$/.test(f));
    assert.deepStrictEqual(bad, []);
  });

  test('the import never calls CURV or Azure and never endorses', () => {
    const source = ['backend/utils/mimic.js', 'backend/scripts/import-mimic.js']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .join('\n');
    const code = source.replace(/\/\/.*$/gm, '');
    assert.ok(!/aiService|azureFindings|queueAnalysis|runStoredAnalysis|analyzeCase|finalizeCase|openai|fetch\(/i.test(code));
    assert.ok(!/status:\s*'finalized'|finalizedBy/.test(code));
  });

  test('the download script reads ~/.netrc and holds no credential', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'backend', 'scripts', 'mimic-download.sh'), 'utf8');
    assert.ok(/\.netrc/.test(sh) && /wget/.test(sh) && /aria2c/.test(sh));
    assert.ok(!/--password|--ask-password|--http-password|password=\S/.test(sh.replace(/#.*$/gm, '')));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
