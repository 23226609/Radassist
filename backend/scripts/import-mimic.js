#!/usr/bin/env node
// scripts/import-mimic.js
//
// Load about 2,000 MIMIC-CXR-JPG histories as cases that are waiting for AI.
//
//   1. Download the metadata file with wget or aria2 (see mimic-download.sh).
//   2. node backend/scripts/import-mimic.js plan --metadata <metadata.csv.gz>
//        picks the subjects and writes the URL lists for wget/aria2. No images
//        are downloaded here and no database is opened.
//   3. backend/scripts/mimic-download.sh jpg|reports   (uses ~/.netrc)
//   4. node backend/scripts/import-mimic.js import
//        DRY RUN: reads the downloaded files and says what it would load.
//      node backend/scripts/import-mimic.js import --apply
//        writes the cases. It never calls CURV or Azure and never endorses.
//
// Everything downloaded stays under data/mimic/, which git ignores. Do not
// commit MIMIC files, PhysioNet credentials or .env.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const mimic = require('../utils/mimic');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// The data directory must be one git ignores, so a stray `git add .` cannot
// pick up images, reports or a credential.
function assertIgnored(dir) {
  const rel = path.relative(ROOT, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside this repository
  const probe = path.join(dir, '.probe');
  const res = spawnSync('git', ['check-ignore', '-q', probe], { cwd: ROOT });
  if (res.status === 1) {
    throw new Error(`${rel} is not ignored by git. Add it to .gitignore before downloading MIMIC files into it.`);
  }
}

function layout(dataDir) {
  return {
    metadataDir: path.join(dataDir, 'metadata'),
    planDir: path.join(dataDir, 'plan'),
    jpgDir: path.join(dataDir, 'jpg'),
    reportDir: path.join(dataDir, 'reports'),
    dicomDir: path.join(dataDir, 'dicom'),
  };
}

async function plan(args, dirs) {
  const metadata = args.metadata && args.metadata !== true
    ? path.resolve(args.metadata)
    : path.join(dirs.metadataDir, mimic.METADATA_NAME);
  if (!fs.existsSync(metadata)) {
    throw new Error(`Metadata file not found: ${metadata}\nDownload it first: backend/scripts/mimic-download.sh metadata`);
  }
  const count = number(args.count, 2000);
  const spare = number(args.spare, Math.ceil(count * 0.15));
  const dicom = number(args.dicom, 0);
  const seed = args.seed && args.seed !== true ? String(args.seed) : 'radassist';

  const rows = await mimic.readFrontalMetadata(metadata);
  const selection = mimic.selectCohort(rows, { count, spare, seed });
  const lists = mimic.urlLists(selection, { dicom });

  fs.mkdirSync(dirs.planDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.planDir, 'selection.json'), `${JSON.stringify({ count, spare, seed, selection }, null, 1)}\n`);
  fs.writeFileSync(path.join(dirs.planDir, 'urls-jpg.txt'), `${lists.jpg.join('\n')}\n`);
  fs.writeFileSync(path.join(dirs.planDir, 'urls-reports.txt'), `${lists.reports.join('\n')}\n`);
  if (dicom) fs.writeFileSync(path.join(dirs.planDir, 'urls-dicom.txt'), `${lists.dicom.join('\n')}\n`);

  const pa = selection.filter((s) => s.view === 'PA').length;
  console.log(`Frontal PA/AP films in the metadata: ${rows.length}`);
  console.log(`Selected ${selection.length} subjects (${count} wanted + ${selection.length - Math.min(count, selection.length)} spare): ${pa} PA, ${selection.length - pa} AP.`);
  console.log(`Wrote ${path.relative(ROOT, dirs.planDir)}/selection.json and the URL lists.`);
  if (dicom) console.log(`DICOM list: ${lists.dicom.length} PA films for the measurement demo.`);
  console.log('Next: backend/scripts/mimic-download.sh jpg && backend/scripts/mimic-download.sh reports');
}

// Studies whose official report is already on disk and has an indication.
// One study per subject. No JPEG list is written. A short DICOM list is.
async function planReports(args, dirs) {
  const recordFile = args.records && args.records !== true
    ? path.resolve(args.records)
    : path.join(dirs.metadataDir, 'cxr-record-list.csv.gz');
  if (!fs.existsSync(recordFile)) {
    throw new Error(`Record list not found: ${recordFile}\nDownload cxr-record-list.csv.gz into the metadata folder first.`);
  }
  if (!fs.existsSync(dirs.reportDir)) throw new Error(`Reports not found: ${dirs.reportDir}`);

  const count = number(args.count, 2000);
  const spare = number(args.spare, Math.ceil(count * 0.15));
  const dicom = number(args.dicom, 12);
  const wanted = count + spare;

  const raw = fs.createReadStream(recordFile);
  const input = /\.gz$/i.test(recordFile) ? raw.pipe(zlib.createGunzip()) : raw;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  const selection = [];
  let subject = '';
  let picked = false;
  let studyId = '';
  let dicoms = [];

  const takeStudy = () => {
    if (!studyId || picked || !dicoms.length) return false;
    const rel = mimic.reportPath(subject, studyId);
    let text = null;
    try { text = fs.readFileSync(path.join(dirs.reportDir, rel), 'utf8'); } catch { /* not on disk */ }
    studyId = '';
    const ids = dicoms;
    dicoms = [];
    if (!text || !mimic.indicationOf(text)) return false;
    const dicomId = ids[0];
    selection.push({
      subjectId: subject,
      studyId: String(rel.match(/s(\d+)\.txt$/)[1]),
      dicomId,
      dicomIds: ids,
      view: '',
      studyDate: '',
      studyTime: '',
      rows: 0,
      columns: 0,
      jpg: mimic.jpgPath(subject, rel.match(/s(\d+)\.txt$/)[1], dicomId),
      report: rel,
      dicom: mimic.dicomPath(subject, rel.match(/s(\d+)\.txt$/)[1], dicomId),
      spare: selection.length >= count,
    });
    picked = true;
    return true;
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    const cells = mimic.parseCsvLine(line);
    if (!header) { header = cells; continue; }
    const row = {};
    header.forEach((name, i) => { row[name] = cells[i] ?? ''; });
    const sid = String(row.subject_id || '');
    const st = String(row.study_id || '');
    const did = String(row.dicom_id || '');
    if (!sid || !st || !did) continue;
    if (sid !== subject) {
      takeStudy();
      if (selection.length >= wanted) break;
      subject = sid;
      picked = false;
      studyId = '';
      dicoms = [];
    }
    if (picked) continue;
    if (st !== studyId) {
      takeStudy();
      if (selection.length >= wanted) break;
      studyId = st;
      dicoms = [];
    }
    dicoms.push(did);
  }
  if (selection.length < wanted) takeStudy();

  if (!header || !header.includes('dicom_id') || !header.includes('subject_id') || !header.includes('study_id')) {
    throw new Error('That does not look like cxr-record-list.csv(.gz).');
  }

  const urls = selection.filter((s) => !s.spare).slice(0, dicom).map((s) => `${mimic.CXR_BASE}${s.dicom}`);
  fs.mkdirSync(dirs.planDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.planDir, 'selection.json'), `${JSON.stringify({ count, spare, source: 'local-reports', selection }, null, 1)}\n`);
  fs.writeFileSync(path.join(dirs.planDir, 'urls-dicom.txt'), urls.length ? `${urls.join('\n')}\n` : '');

  const ready = selection.filter((s) => !s.spare).length;
  console.log(`Selected ${ready} studies with an indication (${selection.length - ready} spare).`);
  console.log('No JPEG list was written.');
  console.log(`DICOM list: ${urls.length} files for the measurement demo.`);
  console.log(`Wrote ${path.relative(ROOT, dirs.planDir)}/selection.json`);
}

function dicomOnDisk(dicomDir, entry) {
  if (!entry || !entry.dicom) return null;
  for (const file of [path.join(dicomDir, entry.dicom), path.join(dicomDir, path.basename(entry.dicom))]) {
    try {
      if (fs.statSync(file).size > 128) return file;
    } catch { /* not downloaded */ }
  }
  return null;
}

function filmFieldsOf(film) {
  if (!film) return {};
  const fields = {};
  for (const key of ['pixelSpacingMm', 'imagerPixelSpacingMm', 'dicomPixelSpacingMm']) {
    if (Array.isArray(film[key]) && film[key].length === 2) fields[key] = film[key];
  }
  if (film.pixelSpacingSource) fields.pixelSpacingSource = film.pixelSpacingSource;
  for (const key of ['estimatedMagnification', 'distanceSourceToDetectorMm', 'distanceSourceToPatientMm', 'bodyPartThicknessMm']) {
    const n = Number(film[key]);
    if (n > 0) fields[key] = n;
  }
  if (['PA', 'AP', 'AP supine', 'Lateral'].includes(film.view)) fields.view = film.view;
  if (film.dicomViewPosition) fields.dicomViewPosition = String(film.dicomViewPosition).slice(0, 16);
  if (film.patientPosition) fields.patientPosition = String(film.patientPosition).slice(0, 16);
  if (film.projectionCues) fields.projectionCues = String(film.projectionCues).slice(0, 400);
  if (film.examinedAt) fields.examinedAt = film.examinedAt;
  return fields;
}

async function importCases(args, dirs) {
  const file = path.join(dirs.planDir, 'selection.json');
  if (!fs.existsSync(file)) throw new Error(`No plan found at ${file}. Run the plan step first.`);
  const { selection } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const limit = number(args.limit, 2000);
  const apply = args.apply === true;

  const reportsOnly = args['reports-only'] === true;
  const { usable, skipped } = mimic.gatherLocal(selection, {
    jpgDir: dirs.jpgDir,
    reportDir: dirs.reportDir,
    limit,
    requireImage: !reportsOnly,
  });
  const pa = usable.filter((u) => u.entry.view === 'PA').length;
  const ap = usable.filter((u) => u.entry.view === 'AP').length;
  const withJpeg = usable.filter((u) => u.image).length;
  const withDicom = usable.filter((u) => dicomOnDisk(dirs.dicomDir, u.entry)).length;
  console.log(`${apply ? 'IMPORT' : 'DRY RUN'}: ${usable.length} cases ready (${pa} PA, ${ap} AP, ${withJpeg} with a JPEG, ${usable.length - withJpeg} history only), limit ${limit}.`);
  if (withDicom) console.log(`${withDicom} DICOM files are on disk.`);
  console.log(`Skipped: ${skipped.noImage} without a downloaded JPEG, ${skipped.notJpeg} not JPEG, ${skipped.noReport} without a report file, ${skipped.noIndication} without an indication section, ${skipped.beyondLimit} beyond the limit.`);
  for (const u of usable.slice(0, 3)) {
    const f = mimic.buildCaseFields(u.entry, { reportText: u.reportText, indication: u.indication, imageId: u.image ? 'preview' : null, imageSize: u.image ? u.image.length : 0 });
    console.log(`  ${f.patientId}  ${f.caseId}  ${f.view}  history: ${JSON.stringify(f.history.slice(0, 80))}`);
  }
  if (!apply) {
    console.log('Nothing was written. Add --apply to load these cases. CURV and Azure are never called.');
    return;
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const connectDB = require('../config/db');
  const Case = require('../models/Case');
  const Patient = require('../models/Patient');
  const { bucket } = require('../controllers/_gridfs');
  const { nameFieldsFrom } = require('../utils/patientName');
  await connectDB();

  const wantedIds = usable.map((u) => mimic.caseIdOf(u.entry.studyId));
  const already = new Set(
    (await Case.find({ caseId: { $in: wantedIds } }).select('caseId').lean()).map((doc) => doc.caseId),
  );
  const existing = already.size;

  const pending = [];
  let failed = 0;
  for (const u of usable) {
    const caseId = mimic.caseIdOf(u.entry.studyId);
    if (already.has(caseId)) continue;
    let imageId = null;
    try {
      let film = null;
      const dcm = dicomOnDisk(dirs.dicomDir, u.entry);
      if (dcm) {
        try {
          const { prepareFilm } = require('../utils/dicom');
          film = prepareFilm({
            buffer: fs.readFileSync(dcm),
            originalname: path.basename(dcm),
            mimetype: 'application/dicom',
            size: fs.statSync(dcm).size,
          });
        } catch (err) {
          console.warn(`  ${caseId} DICOM kept on disk, not shown in the viewer: ${err.message}`);
        }
      }
      const image = film ? film.buffer : u.image;
      if (image) {
        const up = bucket().openUploadStream(film ? film.filename : `${u.entry.dicomId}.jpg`, {
          contentType: film ? film.contentType : 'image/jpeg',
          metadata: { patientId: mimic.patientIdOf(u.entry.subjectId), source: film ? 'mimic-cxr 2.1.0' : 'mimic-cxr-jpg 2.1.0' },
        });
        await new Promise((resolve, reject) => up.end(image, (err) => (err ? reject(err) : resolve())));
        imageId = up.id;
      }
      pending.push({
        ...mimic.buildCaseFields(u.entry, {
          reportText: u.reportText,
          indication: u.indication,
          imageId,
          imageSize: image ? image.length : 0,
          imageFilename: film ? film.filename : undefined,
          imageContentType: film ? film.contentType : undefined,
        }),
        ...filmFieldsOf(film),
        registeredAt: new Date(),
      });
    } catch (err) {
      failed += 1;
      console.warn(`  could not prepare ${caseId}: ${err.message}`);
      if (imageId) await bucket().delete(imageId).catch(() => {});
    }
  }

  const chunk = 40;
  let created = 0;
  for (let i = 0; i < pending.length; i += chunk) {
    const slice = pending.slice(i, i + chunk);
    const patients = slice.map((fields) => {
      const names = nameFieldsFrom(fields);
      return {
        patientId: fields.patientId,
        firstName: names.firstName,
        middleName: names.middleName,
        lastName: names.lastName,
        name: names.name,
        age: '',
        sex: '',
        history: fields.history,
        remarks: '',
      };
    });
    const patientResult = await Patient.insertMany(patients, { ordered: false }).catch((err) => err);
    const patientErrors = patientResult?.writeErrors || patientResult?.result?.result?.writeErrors || [];
    for (const err of patientErrors) {
      if (err.code !== 11000) console.warn(`  patient: ${err.errmsg || err.message}`);
    }
    if (patientResult instanceof Error && patientResult.code !== 11000 && !patientErrors.length) {
      throw patientResult;
    }
    try {
      const docs = await Case.insertMany(slice, { ordered: true });
      created += docs.length;
    } catch (err) {
      failed += slice.length;
      console.warn(`  could not load a batch at ${i}: ${err.message}`);
    }
    console.log(`  ${Math.min(i + chunk, pending.length)}/${pending.length}`);
  }
  console.log(`Loaded ${created} cases. ${existing} were already there. ${failed} failed.`);
  await require('../config/db').disconnectDB();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const dataDir = path.resolve(args.data && args.data !== true ? args.data : path.join(ROOT, 'data', 'mimic'));
  const dirs = layout(dataDir);
  if (command !== 'plan' && command !== 'plan-reports' && command !== 'import') {
    console.log('usage: import-mimic.js plan [--metadata FILE] [--count 2000] [--spare N] [--dicom N] [--seed S] [--data DIR]');
    console.log('       import-mimic.js plan-reports [--count 2000] [--spare N] [--dicom N] [--data DIR]');
    console.log('       import-mimic.js import [--limit 2000] [--reports-only] [--apply] [--data DIR]');
    process.exit(command ? 1 : 0);
  }
  assertIgnored(dataDir);
  if (command === 'plan') await plan(args, dirs);
  else if (command === 'plan-reports') await planReports(args, dirs);
  else await importCases(args, dirs);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => { console.error(err.message || err); process.exit(1); },
  );
}

module.exports = { parseArgs, layout, assertIgnored };
