// Synthetic ward charts for the demo. Not real records.
// Each patient gets observations, lab orders, prescriptions, and care notes.

const { composePatientName } = require('../utils/patientName');

const DOCTOR = 'Dr. Alex Wong';

const PROFILES = {
  none: { hr: 76, rr: 16, sbp: 118, spo2: 98, temp: 36.6, wbc: 7.2, lactate: 0.9, crp: 4 },
  abnormal: { hr: 92, rr: 18, sbp: 116, spo2: 96, temp: 37.8, wbc: 12.4, lactate: 1.6, crp: 28 },
  urgent: { hr: 118, rr: 28, sbp: 108, spo2: 89, temp: 38.2, wbc: 15.2, lactate: 3.1, crp: 64 },
};

const STARTS = {
  none: PROFILES.none,
  abnormal: { hr: 78, rr: 16, sbp: 120, spo2: 98, temp: 36.8, wbc: 8.2, lactate: 1.0, crp: 6 },
  urgent: { hr: 96, rr: 20, sbp: 124, spo2: 95, temp: 37.0, wbc: 9.5, lactate: 1.4, crp: 12 },
};

// Known patients keep a stable review state. New ids are listed here too.
const CHARTS = [
  { patientId: 'PT-2026-0018', kind: 'none', bed: '4A-12', admissionStatus: 'admitted', end: '2026-09-21T02:35:53.000Z', vitals: { hr: 76, rr: 16, sbp: 122, spo2: 98, temp: 36.6, wbc: 8.1, lactate: 1.1, crp: 6 } },
  { patientId: 'PT-2026-0021', kind: 'abnormal', bed: '4B-03', admissionStatus: 'admitted', end: '2026-09-21T06:35:53.000Z', vitals: { hr: 92, rr: 18, sbp: 118, spo2: 96, temp: 37.8, wbc: 11.4, lactate: 1.4, crp: 28 } },
  { patientId: 'PT-2026-0011', kind: 'none', bed: '4A-06', admissionStatus: 'admitted', end: '2026-09-22T01:10:00.000Z', vitals: { hr: 68, rr: 14, sbp: 116, spo2: 98, temp: 36.5, wbc: 6.8, lactate: 0.8, crp: 3 } },
  { patientId: 'PT-2026-0033', kind: 'urgent', bed: '4B-01', admissionStatus: 'admitted', end: '2026-09-21T08:35:53.000Z', vitals: { hr: 112, rr: 26, sbp: 108, spo2: 90, temp: 37.6, wbc: 13.8, lactate: 2.6, crp: 42 } },
  { patientId: 'PT-2026-0044', kind: 'none', bed: '4A-18', admissionStatus: 'admitted', end: '2026-10-02T03:20:00.000Z' },
  { patientId: 'PT-2026-0050', kind: 'abnormal', bed: '4B-07', admissionStatus: 'admitted', end: '2026-09-14T04:05:00.000Z', vitals: { hr: 104, rr: 20, sbp: 128, spo2: 96, temp: 36.8, wbc: 9.1, lactate: 1.2, crp: 8 } },
  { patientId: 'PT-2026-0051', kind: 'none', bed: '4A-09', admissionStatus: 'admitted', end: '2026-09-16T02:40:00.000Z' },
  { patientId: 'PT-2025-1107', kind: 'none', bed: '4A-21', admissionStatus: 'admitted', end: '2026-10-01T07:00:00.000Z' },
  { patientId: 'PT-2026-0061', kind: 'abnormal', bed: '4B-10', admissionStatus: 'admitted', end: '2026-10-04T05:15:00.000Z', vitals: { hr: 98, rr: 20, sbp: 110, spo2: 97, temp: 37.4, wbc: 10.2, lactate: 1.3, crp: 18 } },

  { patientId: 'PT-2026-0072', firstName: 'Wai Man', lastName: 'Chan', age: '63', sex: 'Male', history: 'Fever and productive cough for four days', kind: 'abnormal', bed: '4A-03', admissionStatus: 'admitted', end: '2026-10-05T01:20:00.000Z' },
  { patientId: 'PT-2026-0073', firstName: 'Ka Yan', lastName: 'Lee', age: '29', sex: 'Female', history: 'Pre-operative chest X-ray before elective surgery', kind: 'none', bed: '4A-11', admissionStatus: 'reserved', end: '2026-10-05T06:00:00.000Z' },
  { patientId: 'PT-2026-0074', firstName: 'Ho Yin', lastName: 'Cheung', age: '81', sex: 'Male', history: 'Acute dyspnoea, suspected pneumonia', kind: 'urgent', bed: '4B-16', admissionStatus: 'admitted', end: '2026-10-06T00:45:00.000Z' },
  { patientId: 'PT-2026-0075', firstName: 'Mei Ling', lastName: 'Wong', age: '54', sex: 'Female', history: 'Follow-up after a treated chest infection', kind: 'none', bed: '4A-08', admissionStatus: 'admitted', end: '2026-10-03T02:30:00.000Z' },
  { patientId: 'PT-2026-0076', firstName: 'Anika', lastName: 'Patel', age: '41', sex: 'Female', history: 'Pleuritic pain and low-grade fever', kind: 'abnormal', bed: '4B-06', admissionStatus: 'admitted', end: '2026-10-05T08:10:00.000Z' },
  { patientId: 'PT-2026-0077', firstName: 'Luis', lastName: 'Garcia', age: '36', sex: 'Male', history: 'Cough after a viral illness', kind: 'none', bed: '4A-15', admissionStatus: 'admitted', end: '2026-10-06T01:05:00.000Z' },
  { patientId: 'PT-2026-0078', firstName: 'Siu Fong', lastName: 'Yip', age: '77', sex: 'Female', history: 'Known heart failure, increased shortness of breath', kind: 'urgent', bed: '4B-04', admissionStatus: 'admitted', end: '2026-10-04T09:20:00.000Z' },
  { patientId: 'PT-2026-0079', firstName: 'Yusuf', lastName: 'Ahmed', age: '48', sex: 'Male', history: 'Community-acquired chest infection, not yet imaged', kind: 'abnormal', bed: '4B-09', admissionStatus: 'admitted', end: '2026-10-06T03:40:00.000Z' },
  { patientId: 'PT-2026-0080', firstName: 'Tsz Hin', lastName: 'Lam', age: '22', sex: 'Male', history: 'Chest wall pain after sport', kind: 'none', bed: '4A-02', admissionStatus: 'admitted', end: '2026-10-06T04:10:00.000Z' },
  { patientId: 'PT-2026-0081', firstName: 'Rosa', lastName: 'Fernandes', age: '69', sex: 'Female', history: 'Annual review, mild osteoarthritis', kind: 'none', bed: '4B-11', admissionStatus: 'admitted', end: '2026-10-02T06:50:00.000Z' },
  { patientId: 'PT-2026-0082', firstName: 'Grace', lastName: 'Okafor', age: '33', sex: 'Female', history: 'Elective admission, awaiting a bed', kind: 'none', bed: '4A-04', admissionStatus: 'reserved', end: '2026-10-06T02:00:00.000Z' },
  { patientId: 'PT-2026-0083', firstName: 'Peter', lastName: 'Schmidt', age: '70', sex: 'Male', history: 'Hypoxia on the ward, oxygen required', kind: 'urgent', bed: '4B-14', admissionStatus: 'admitted', end: '2026-10-06T05:25:00.000Z' },
  { patientId: 'PT-2026-0084', firstName: 'Hannah', lastName: 'Brooks', age: '26', sex: 'Female', history: 'Discharged after a normal chest review', kind: 'none', bed: '4A-16', admissionStatus: 'discharged', end: '2026-09-28T08:00:00.000Z' },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function observations(spec) {
  const kind = spec.kind || 'none';
  const endV = { ...PROFILES[kind], ...(spec.vitals || {}) };
  const startV = STARTS[kind];
  const count = kind === 'none' ? 6 : 12;
  const endMs = new Date(spec.end).getTime();
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 1 : i / (count - 1);
    const point = {
      hr: Math.round(lerp(startV.hr, endV.hr, t)),
      rr: Math.round(lerp(startV.rr, endV.rr, t)),
      sbp: Math.round(lerp(startV.sbp, endV.sbp, t)),
      spo2: Math.round(lerp(startV.spo2, endV.spo2, t)),
      temp: round1(lerp(startV.temp, endV.temp, t)),
      wbc: round1(lerp(startV.wbc, endV.wbc, t)),
      lactate: round1(lerp(startV.lactate, endV.lactate, t)),
      crp: Math.round(lerp(startV.crp, endV.crp, t)),
    };
    rows.push({
      at: new Date(endMs - (count - 1 - i) * 60 * 60 * 1000).toISOString(),
      by: i % 2 ? 'RN LEE' : 'RN CHAN',
      hr: String(point.hr),
      rr: String(point.rr),
      sbp: String(point.sbp),
      spo2: String(point.spo2),
      temp: point.temp.toFixed(1),
      wbc: point.wbc.toFixed(1),
      lactate: point.lactate.toFixed(1),
      crp: String(point.crp),
    });
  }
  return rows;
}

function labOrders(spec, latest) {
  const endMs = new Date(spec.end).getTime();
  const at = (hours) => new Date(endMs - hours * 60 * 60 * 1000).toISOString();
  const renal = spec.kind === 'urgent'
    ? 'Creatinine 132 µmol/L; urea 9.8 mmol/L'
    : 'Creatinine 76 µmol/L; urea 5.0 mmol/L';
  return [
    { at: at(26), panel: 'CBC', priority: spec.kind === 'urgent' ? 'STAT' : 'Routine', notes: 'Admission bloods', status: 'resulted', result: `WBC ${latest.wbc}; Hb ${spec.kind === 'urgent' ? '11.2' : '13.4'} g/dL` },
    { at: at(26), panel: 'CRP', priority: spec.kind === 'none' ? 'Routine' : 'Urgent', notes: 'Infection screen', status: 'resulted', result: `${latest.crp} mg/L` },
    { at: at(24), panel: 'Lactate', priority: spec.kind === 'urgent' ? 'STAT' : 'Routine', notes: 'Perfusion check', status: 'resulted', result: `${latest.lactate} mmol/L` },
    { at: at(24), panel: 'Renal panel', priority: 'Routine', notes: 'Baseline renal function', status: 'resulted', result: renal },
    { at: at(2), panel: 'CBC', priority: 'Routine', notes: 'Repeat if the fever continues', status: 'ordered', result: '' },
  ];
}

function medOrders(spec) {
  const endMs = new Date(spec.end).getTime();
  const at = new Date(endMs - 20 * 60 * 60 * 1000).toISOString();
  const rows = [
    {
      at,
      drug: 'Paracetamol · 1 g tablet',
      dose: '1',
      route: 'Oral',
      frequency: spec.kind === 'none' ? 'PRN' : 'QID',
      prescribedBy: DOCTOR,
      status: 'active',
    },
  ];
  if (spec.kind === 'none') {
    rows.push({
      at,
      drug: 'Salbutamol inhaler',
      dose: '2',
      route: 'Inhaled',
      frequency: 'PRN',
      prescribedBy: DOCTOR,
      status: 'active',
    });
  } else {
    rows.push({
      at,
      drug: 'Amoxicillin · 500 mg capsule',
      dose: '1',
      route: 'Oral',
      frequency: 'TDS',
      prescribedBy: DOCTOR,
      status: 'active',
    });
    rows.push({
      at,
      drug: 'Salbutamol inhaler',
      dose: '2',
      route: 'Inhaled',
      frequency: 'QID',
      prescribedBy: DOCTOR,
      status: 'active',
    });
  }
  return rows;
}

function careNotes(spec) {
  const endMs = new Date(spec.end).getTime();
  const at = (hours) => new Date(endMs - hours * 60 * 60 * 1000).toISOString();
  const story = spec.kind === 'urgent'
    ? 'Oxygen in progress. Senior review requested. Chest film already asked for.'
    : spec.kind === 'abnormal'
      ? 'Low-grade fever. Oral fluids encouraged. Chest film requested from the ward.'
      : 'Observations stable overnight. No new chest symptoms reported.';
  return [
    { at: at(18), author: 'RN CHAN', role: 'RN (Registered Nurse)', category: 'Handover', note: story },
    { at: at(10), author: DOCTOR, role: 'Doctor', category: 'General', note: spec.history || 'Ward review. Continue current chart and await the chest X-ray report.' },
    { at: at(6), author: 'RN LEE', role: 'RN (Registered Nurse)', category: 'Pain Assessment', note: 'Pain score 2/10 at rest. Paracetamol given as charted. No new allergy stated.' },
  ];
}

function buildChart(spec) {
  const obs = observations(spec);
  const latest = obs[obs.length - 1];
  const labs = labOrders(spec, latest);
  const meds = medOrders(spec);
  const notes = careNotes(spec);
  const resulted = labs.filter((row) => row.result);
  const lastLab = resulted[resulted.length - 1];
  return {
    heartRate: `${latest.hr} bpm`,
    labResults: resulted.map((row) => `${row.panel}: ${row.result}`).join('; '),
    medicines: meds.map((row) => `${row.drug} ${row.dose} ${row.frequency}`).join('; '),
    remarks: lastLab ? `Latest chart note. ${lastLab.panel} ${lastLab.result}.` : 'Demonstration chart.',
    observations: obs,
    labOrders: labs,
    medOrders: meds,
    careNotes: notes,
  };
}

function incompleteObs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  const last = rows[rows.length - 1] || {};
  return ['hr', 'rr', 'sbp', 'spo2', 'temp', 'wbc', 'lactate', 'crp'].some((key) => last[key] == null || last[key] === '');
}

function fallbackChart(patient) {
  const id = String(patient.patientId || '');
  const n = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const kinds = ['none', 'abnormal', 'urgent'];
  const beds = ['4A-05', '4A-14', '4A-19', '4B-02', '4B-08', '4B-15'];
  return {
    patientId: id,
    kind: kinds[n % 3],
    bed: beds[n % beds.length],
    admissionStatus: 'admitted',
    end: '2026-10-05T03:30:00.000Z',
    history: patient.history || 'Admitted for a chest complaint. Demonstration chart.',
    offset: n % 5,
  };
}

function applyBuilt(patient, spec) {
  const built = buildChart(spec);
  const ward = String(spec.bed || '').startsWith('4B') ? '4B' : '4A';
  if (spec.firstName && !patient.firstName) patient.firstName = spec.firstName;
  if (spec.middleName && !patient.middleName) patient.middleName = spec.middleName;
  if (spec.lastName && !patient.lastName) patient.lastName = spec.lastName;
  if (spec.age && !patient.age) patient.age = spec.age;
  if (spec.sex && !patient.sex) patient.sex = spec.sex;
  if (spec.history && !patient.history) patient.history = spec.history;
  if (!patient.name) patient.name = composePatientName(patient);
  patient.ward = ward;
  patient.bed = spec.bed;
  patient.admissionStatus = spec.admissionStatus || 'admitted';
  if (incompleteObs(patient.observations)) {
    patient.observations = built.observations;
    patient.heartRate = built.heartRate;
  }
  if (!patient.labOrders || patient.labOrders.length === 0) {
    patient.labOrders = built.labOrders;
    patient.labResults = built.labResults;
  }
  if (!patient.medOrders || patient.medOrders.length === 0) {
    patient.medOrders = built.medOrders;
    patient.medicines = built.medicines;
  }
  if (!patient.careNotes || patient.careNotes.length === 0) {
    patient.careNotes = built.careNotes;
  }
  if (!patient.remarks) patient.remarks = built.remarks;
  if (!patient.history) patient.history = spec.history || 'Demonstration chart.';
}

module.exports = {
  CHARTS,
  buildChart,
  fallbackChart,
  applyBuilt,
  incompleteObs,
};
