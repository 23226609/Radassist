// utils/mimic.js
//
// Pure helpers for loading a MIMIC-CXR-JPG cohort. Nothing here touches the
// database, the network, CURV or Azure. The import script wires them up.
//
// Files come from PhysioNet (credentialed access) with wget or aria2 and a
// ~/.netrc entry. They live in a gitignored data directory and are never
// committed: not the images, not the reports, not the credential.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const JPG_BASE = 'https://physionet.org/files/mimic-cxr-jpg/2.1.0/';
const CXR_BASE = 'https://physionet.org/files/mimic-cxr/2.1.0/';
const METADATA_NAME = 'mimic-cxr-2.0.0-metadata.csv.gz';

const REPORT_LABEL = 'MIMIC report';
const REPORT_SOURCE = 'MIMIC-CXR 2.1.0';

// ---------------------------------------------------------------- CSV

function parseCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

// Frontal rows only (PA or AP) from the metadata CSV, gzipped or plain.
async function readFrontalMetadata(file) {
  const raw = fs.createReadStream(file);
  const input = /\.gz$/i.test(file) ? raw.pipe(zlib.createGunzip()) : raw;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  const rows = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells; continue; }
    const row = {};
    header.forEach((name, i) => { row[name] = cells[i] ?? ''; });
    const view = String(row.ViewPosition || '').trim().toUpperCase();
    if (view === 'PA' || view === 'AP') rows.push({ ...row, ViewPosition: view });
  }
  if (!header || !header.includes('dicom_id') || !header.includes('subject_id') || !header.includes('study_id')) {
    throw new Error('That does not look like mimic-cxr-2.0.0-metadata.csv(.gz): dicom_id, subject_id or study_id is missing.');
  }
  return rows;
}

// ---------------------------------------------------------------- paths

function studyDir(subjectId, studyId) {
  const subject = String(subjectId);
  return `files/p${subject.slice(0, 2)}/p${subject}/s${studyId}`;
}
const jpgPath = (subjectId, studyId, dicomId) => `${studyDir(subjectId, studyId)}/${dicomId}.jpg`;
const dicomPath = (subjectId, studyId, dicomId) => `${studyDir(subjectId, studyId)}/${dicomId}.dcm`;
const reportPath = (subjectId, studyId) => `files/p${String(subjectId).slice(0, 2)}/p${subjectId}/s${studyId}.txt`;

// ---------------------------------------------------------------- cohort

const byTime = (a, b) =>
  String(a.StudyDate).localeCompare(String(b.StudyDate))
  || String(a.StudyTime).localeCompare(String(b.StudyTime), undefined, { numeric: true })
  || String(a.dicom_id).localeCompare(String(b.dicom_id));

const order = (seed, subjectId) =>
  crypto.createHash('sha1').update(`${seed}:${subjectId}`).digest('hex');

// About `count` distinct subjects, one frontal film each, PA before AP. The
// choice is a seeded shuffle, so it is repeatable. `spare` extra candidates
// are kept for subjects whose report has no indication (those are skipped,
// never filled in).
function selectCohort(rows, { count = 2000, spare = 0, seed = 'radassist' } = {}) {
  const best = new Map();
  for (const row of rows) {
    const view = String(row.ViewPosition || '').toUpperCase();
    if (view !== 'PA' && view !== 'AP') continue;
    const subject = String(row.subject_id);
    const current = best.get(subject);
    const rank = view === 'PA' ? 0 : 1;
    const currentRank = current ? (current.ViewPosition === 'PA' ? 0 : 1) : 9;
    if (!current || rank < currentRank || (rank === currentRank && byTime(row, current) < 0)) {
      best.set(subject, { ...row, ViewPosition: view });
    }
  }
  const ranked = [...best.entries()].sort((a, b) => {
    const pa = a[1].ViewPosition === 'PA' ? 0 : 1;
    const pb = b[1].ViewPosition === 'PA' ? 0 : 1;
    return pa - pb || order(seed, a[0]).localeCompare(order(seed, b[0]));
  });
  return ranked.slice(0, count + spare).map(([subject, row], i) => ({
    subjectId: subject,
    studyId: String(row.study_id),
    dicomId: String(row.dicom_id),
    view: row.ViewPosition,
    studyDate: String(row.StudyDate || ''),
    studyTime: String(row.StudyTime || ''),
    rows: Number(row.Rows) || 0,
    columns: Number(row.Columns) || 0,
    jpg: jpgPath(subject, row.study_id, row.dicom_id),
    report: reportPath(subject, row.study_id),
    spare: i >= count,
  }));
}

function urlLists(selection, { dicom = 0 } = {}) {
  return {
    jpg: selection.map((s) => `${JPG_BASE}${s.jpg}`),
    reports: selection.map((s) => `${CXR_BASE}${s.report}`),
    dicom: selection
      .filter((s) => s.view === 'PA')
      .slice(0, dicom)
      .map((s) => `${CXR_BASE}${dicomPath(s.subjectId, s.studyId, s.dicomId)}`),
  };
}

// ---------------------------------------------------------------- reports

const HEADING = /^[ \t]*([A-Z][A-Z0-9 /&,()-]{1,60}?):[ \t]*(.*)$/;

// Sections of an official report: "INDICATION:", "FINDINGS:" and so on. The
// text of each section is kept as written; only the outer blank space goes.
function reportSections(text) {
  const sections = {};
  let name = '';
  let lines = [];
  const close = () => {
    if (name) {
      const body = lines.join('\n').trim();
      if (!(name in sections)) sections[name] = body;
    }
  };
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(HEADING);
    if (m) {
      close();
      name = m[1].trim();
      lines = [m[2]];
    } else if (name) {
      lines.push(line);
    }
  }
  close();
  return sections;
}

// The patient history, verbatim, from the INDICATION section or else the
// clinical-history section. No other section is used, and nothing is written
// when the report has neither (or only de-identification blanks).
function indicationOf(text) {
  const sections = reportSections(text);
  for (const name of ['INDICATION', 'CLINICAL HISTORY', 'HISTORY']) {
    const value = sections[name];
    if (value && /[A-Za-z0-9]/.test(value.replace(/_+/g, ''))) return { section: name, text: value };
  }
  return null;
}

// ---------------------------------------------------------------- cases

// MIMIC dates are shifted by the dataset and carry no zone. Like a DICOM
// header reading, the clock value is kept as UTC.
function studyDateTime(date, time) {
  const d = String(date || '').replace(/\D/g, '');
  if (d.length !== 8) return null;
  const t = String(time || '').replace(/[^0-9.]/g, '').split('.')[0].padStart(6, '0').slice(0, 6);
  const at = new Date(Date.UTC(
    Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)),
    Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6)),
  ));
  return Number.isNaN(at.getTime()) ? null : at;
}

const patientIdOf = (subjectId) => `PT-MIMIC-${subjectId}`;
const caseIdOf = (studyId) => `CASE-MIMIC-${studyId}`;

// Made-up names in the same shapes as the demo patients (Mei Chen, Ka Yan Lee,
// James Wei Tan). The dataset id is only the seed, so the same subject always
// gets the same name and the name never contains that id.
const SURNAMES = ['Chan', 'Cheung', 'Wong', 'Lee', 'Lam', 'Ng', 'Yip', 'Lim', 'Ho', 'Lau', 'Leung', 'Chow', 'Yeung', 'Tsang', 'Fung', 'Ma', 'Tam', 'Cheng', 'Au', 'Kwok', 'Poon', 'Hui', 'Mak', 'Yuen', 'Tang', 'Lo', 'Wan', 'Tse', 'Yu', 'Kwan', 'Choi', 'Lai', 'Hung', 'Chu', 'Fong', 'Sit', 'So', 'Kwong', 'Ip', 'Shum'];
const GIVEN = ['Mei', 'Siu', 'Wing', 'Hoi', 'Chun', 'Yan', 'Kit', 'Lok', 'Sum', 'Hei', 'Yee', 'Pui', 'Ching', 'On', 'Kin', 'Shing', 'Hiu', 'Tung', 'Long', 'Nga', 'Sze', 'Wai', 'Ming', 'Fong', 'Hin', 'Ling', 'Ka', 'Man', 'Chi', 'Yat', 'Chak', 'Ning', 'Yu', 'Lai', 'Chung', 'Pak', 'Ho', 'Tsz', 'Nok', 'Yin'];
const GIVEN_SECOND = ['Yan', 'Man', 'Ling', 'Fong', 'Hin', 'Yin', 'Keung', 'Wai', 'Chi', 'Kit', 'Hei', 'Tung', 'Ming', 'Sze', 'Ho', 'Ka', 'Wing', 'Sum', 'Lok', 'Ching'];
const ENGLISH = ['James', 'David', 'Robert', 'Henry', 'Alex', 'Luis', 'Daniel', 'Michael', 'Grace', 'Emily', 'Sarah', 'Anna'];

function personName(subjectId, salt = 0) {
  const n = crypto.createHash('sha1').update(`radassist-name:${subjectId}:${salt}`).digest();
  const at = (offset) => n.readUInt32BE(offset % 16);
  const surname = SURNAMES[at(0) % SURNAMES.length];
  const style = at(4) % 5;
  let firstName;
  let middleName = '';
  if (style === 0) {
    firstName = ENGLISH[at(8) % ENGLISH.length];
    middleName = GIVEN[at(12) % GIVEN.length];
  } else if (style === 1) {
    const a = GIVEN[at(8) % GIVEN.length];
    let b = GIVEN_SECOND[at(12) % GIVEN_SECOND.length];
    if (b.toLowerCase() === a.toLowerCase()) b = GIVEN_SECOND[(at(12) + 1) % GIVEN_SECOND.length];
    firstName = `${a} ${b}`;
  } else {
    firstName = GIVEN[at(8) % GIVEN.length];
  }
  const lastName = surname;
  return {
    firstName,
    middleName,
    lastName,
    name: [firstName, middleName, lastName].filter(Boolean).join(' '),
  };
}

// One distinct name per subject. A clash with another subject, or with a name
// already used in the hospital, tries the next salt.
function assignPersonNames(subjectIds, reserved = []) {
  const used = new Set(reserved);
  const out = new Map();
  for (const id of subjectIds) {
    const subject = String(id);
    let person;
    for (let salt = 0; ; salt += 1) {
      person = personName(subject, salt);
      if (!used.has(person.name)) break;
    }
    used.add(person.name);
    out.set(subject, person);
  }
  return out;
}

// One case, not yet analysed and not endorsed: no draft, no tags, no boxes, no
// medicines, heart rate or labs. The history is the report's own indication.
function buildCaseFields(entry, { reportText, indication, imageId, imageSize, imageFilename, imageContentType } = {}) {
  const hasImage = imageId != null && imageId !== '';
  const person = personName(entry.subjectId);
  return {
    caseId: caseIdOf(entry.studyId),
    patientId: patientIdOf(entry.subjectId),
    firstName: person.firstName,
    middleName: person.middleName,
    lastName: person.lastName,
    patientName: person.name,
    age: '',
    sex: '',
    history: indication.text,
    diagnosis: 'Awaiting AI',
    diagnosisSource: '',
    reportText: '',
    findings: [],
    findingTags: [],
    comment: '',
    measurements: [],
    status: 'pending',
    analysisState: 'none',
    boxesState: '',
    urgent: false,
    view: entry.view === 'PA' || entry.view === 'AP' ? entry.view : '',
    examinedAt: studyDateTime(entry.studyDate, entry.studyTime),
    sourceReport: {
      label: REPORT_LABEL,
      source: REPORT_SOURCE,
      text: reportText,
      subjectId: String(entry.subjectId),
      studyId: String(entry.studyId),
      dicomId: String(entry.dicomId),
    },
    createdByName: 'MIMIC-CXR import',
    imageId: hasImage ? imageId : null,
    imageFilename: hasImage ? (imageFilename || `${entry.dicomId}.jpg`) : '',
    imageContentType: hasImage ? (imageContentType || 'image/jpeg') : '',
    imageSize: hasImage ? (imageSize || 0) : 0,
  };
}

// ---------------------------------------------------------------- local files

function readIf(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Walk the selection against the files wget/aria2 already put on disk, and
// keep the first `limit` usable ones. Reasons for skipping are counted.
function gatherLocal(selection, { jpgDir, reportDir, limit = 2000, requireImage = true }) {
  const usable = [];
  const skipped = { noImage: 0, notJpeg: 0, noReport: 0, noIndication: 0, beyondLimit: 0 };
  for (const entry of selection) {
    if (usable.length >= limit) { skipped.beyondLimit += 1; continue; }
    // wget keeps files/pNN/pSUBJECT/...; aria2 saves flat. Either is found.
    // A history-only import (requireImage false) keeps a case with no film.
    const image = jpgDir
      ? (readIf(path.join(jpgDir, entry.jpg)) || readIf(path.join(jpgDir, path.basename(entry.jpg || ''))))
      : null;
    if (image && (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8)) { skipped.notJpeg += 1; continue; }
    if (!image && requireImage) { skipped.noImage += 1; continue; }
    const report = readIf(path.join(reportDir, entry.report)) || readIf(path.join(reportDir, path.basename(entry.report)));
    if (!report) { skipped.noReport += 1; continue; }
    const reportText = report.toString('utf8');
    const indication = indicationOf(reportText);
    if (!indication) { skipped.noIndication += 1; continue; }
    usable.push({ entry, image, reportText, indication });
  }
  return { usable, skipped };
}

module.exports = {
  JPG_BASE,
  CXR_BASE,
  METADATA_NAME,
  REPORT_LABEL,
  REPORT_SOURCE,
  parseCsvLine,
  readFrontalMetadata,
  jpgPath,
  dicomPath,
  reportPath,
  selectCohort,
  urlLists,
  reportSections,
  indicationOf,
  studyDateTime,
  patientIdOf,
  caseIdOf,
  personName,
  assignPersonNames,
  buildCaseFields,
  gatherLocal,
};
