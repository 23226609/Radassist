#!/usr/bin/env node
// Download one MIMIC-CXR DICOM per selected patient and store a display film
// on that case. The official report is left as it is. CURV and Azure are not
// called. Files stay under data/mimic/, which git ignores.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'mimic');
const DICOM_DIR = path.join(DATA, 'dicom');
const CXR = 'https://physionet.org/files/mimic-cxr/2.1.0/';
const COOKIE = '/tmp/pn-cookie-header';
const WORKERS = 3;

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

function isDicomFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(132);
    const n = fs.readSync(fd, buf, 0, 132, 0);
    fs.closeSync(fd);
    return n >= 132 && buf.slice(128, 132).toString('ascii') === 'DICM' && fs.statSync(file).size > 100000;
  } catch {
    return false;
  }
}

function netrcLogin() {
  const text = fs.readFileSync(path.join(os.homedir(), '.netrc'), 'utf8');
  const match = text.match(/physionet\.org[^\n]*login\s+(\S+)\s+password\s+(\S+)/);
  if (!match) throw new Error('~/.netrc has no physionet.org login');
  return { login: match[1], password: match[2] };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

let refreshing = null;
async function refreshCookie() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { login, password } = netrcLogin();
    const jar = '/tmp/pn-cj.txt';
    const htmlPath = '/tmp/pn-login.html';
    const hdr = '/tmp/pn-login-hdr.txt';
    await run('/usr/bin/curl', ['-sS', '-c', jar, '-b', jar, '-A', 'Mozilla/5.0', '-o', htmlPath, 'https://physionet.org/login/']);
    const html = fs.readFileSync(htmlPath, 'utf8');
    const csrf = (html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
    if (!csrf) throw new Error('PhysioNet login page had no token');
    const cfg = path.join(os.tmpdir(), `pn-login-${process.pid}.cfg`);
    fs.writeFileSync(cfg, [
      'silent',
      'show-error',
      `cookie = ${jar}`,
      `cookie-jar = ${jar}`,
      'user-agent = Mozilla/5.0',
      'referer = https://physionet.org/login/',
      `dump-header = ${hdr}`,
      'output = /dev/null',
      `data-urlencode = "csrfmiddlewaretoken=${csrf}"`,
      `data-urlencode = "username=${login}"`,
      `data-urlencode = "password=${password}"`,
      'data-urlencode = "next=/content/mimic-cxr/2.1.0/"',
      'data-urlencode = "remember=on"',
      'url = "https://physionet.org/login/"',
    ].join('\n'), { mode: 0o600 });
    try {
      await run('/usr/bin/curl', ['-sS', '-K', cfg]);
    } finally {
      fs.rmSync(cfg, { force: true });
    }
    const headers = fs.readFileSync(hdr, 'utf8');
    const sid = (headers.match(/sessionid=([^;\s]+)/) || [])[1];
    const token = (headers.match(/csrftoken=([^;\s]+)/) || [])[1] || '';
    if (!sid) throw new Error('PhysioNet login did not return a session');
    fs.writeFileSync(COOKIE, `sessionid=${sid}; csrftoken=${token}`);
    console.log('Signed in to PhysioNet again.');
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function cookieHeader() {
  return fs.readFileSync(COOKIE, 'utf8').replace(/\s+/g, '');
}

function curlFile(url, part) {
  return new Promise((resolve) => {
    const args = [
      '-L', '--retry', '4', '--retry-delay', '3', '-C', '-',
      '-H', `Cookie: ${cookieHeader()}`,
      '-A', 'Mozilla/5.0',
      '--output', part,
      '-w', '%{http_code}',
      url,
    ];
    const child = spawn('/usr/bin/curl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let code = '';
    child.stdout.on('data', (d) => { code += d; });
    child.on('close', (status) => resolve({ status, code: code.trim() }));
  });
}

async function downloadOne(rel) {
  fs.mkdirSync(DICOM_DIR, { recursive: true });
  const dest = path.join(DICOM_DIR, path.basename(rel));
  if (isDicomFile(dest)) return dest;
  const part = `${dest}.part`;
  if (fs.existsSync(part) && !isDicomFile(part)) {
    const head = fs.readFileSync(part).slice(0, 20).toString('utf8');
    if (head.includes('<') || /dont have access/i.test(head)) fs.rmSync(part, { force: true });
  }
  let result = await curlFile(CXR + rel, part);
  if (result.code === '403') {
    await refreshCookie();
    fs.rmSync(part, { force: true });
    result = await curlFile(CXR + rel, part);
  }
  if (!isDicomFile(part)) {
    fs.rmSync(part, { force: true });
    throw new Error(`HTTP ${result.code || result.status} for ${path.basename(rel)}`);
  }
  fs.renameSync(part, dest);
  return dest;
}

async function attach(Case, bucket, entry, file) {
  const caseId = `CASE-MIMIC-${entry.studyId}`;
  const existing = await Case.findOne({ caseId }).select('imageId patientId').lean();
  if (!existing) throw new Error(`no case ${caseId}`);
  if (existing.imageId) return 'already';
  const { prepareFilm } = require('../utils/dicom');
  const buffer = fs.readFileSync(file);
  const film = prepareFilm({
    buffer,
    originalname: path.basename(file),
    mimetype: 'application/dicom',
    size: buffer.length,
  });
  const up = bucket().openUploadStream(film.filename, {
    contentType: film.contentType,
    metadata: { patientId: existing.patientId, source: 'mimic-cxr 2.1.0' },
  });
  await new Promise((resolve, reject) => up.end(film.buffer, (err) => (err ? reject(err) : resolve())));
  await Case.updateOne({ caseId }, {
    $set: {
      imageId: up.id,
      imageFilename: film.filename,
      imageContentType: film.contentType,
      imageSize: film.size,
      ...filmFieldsOf(film),
    },
  });
  return 'attached';
}

async function main() {
  const connectDB = require('../config/db');
  const Case = require('../models/Case');
  const { bucket } = require('../controllers/_gridfs');
  await connectDB();

  const { selection } = JSON.parse(fs.readFileSync(path.join(DATA, 'plan', 'selection.json'), 'utf8'));
  const rows = selection.filter((s) => !s.spare);
  console.log(`Films to cover: ${rows.length}. ${WORKERS} downloads at a time.`);

  let cursor = 0;
  const counts = { attached: 0, already: 0, failed: 0 };
  async function worker() {
    while (cursor < rows.length) {
      const entry = rows[cursor];
      cursor += 1;
      const n = cursor;
      const ids = (entry.dicomIds && entry.dicomIds.length ? entry.dicomIds : [entry.dicomId]);
      let done = '';
      let last = '';
      for (const id of ids) {
        const rel = entry.dicom.replace(/[^/]+\.dcm$/, `${id}.dcm`);
        try {
          const file = await downloadOne(rel);
          done = await attach(Case, bucket, entry, file);
          break;
        } catch (err) {
          last = err.message;
        }
      }
      if (!done) {
        counts.failed += 1;
        console.warn(`FAIL ${n}/${rows.length} CASE-MIMIC-${entry.studyId} ${last}`);
      } else {
        counts[done] += 1;
        if (done === 'attached' || n % 25 === 0) {
          console.log(`${n}/${rows.length} attached ${counts.attached}, already ${counts.already}, failed ${counts.failed}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
  const withFilm = await Case.countDocuments({ caseId: /^CASE-MIMIC-/, imageId: { $ne: null } });
  console.log(`Finished. Cases with a film: ${withFilm}. Failed downloads: ${counts.failed}.`);
  await require('../config/db').disconnectDB();
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err.message || err); process.exit(1); },
);
