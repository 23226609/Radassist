#!/usr/bin/env node
// Fill the ward chart for the MIMIC patients who have a film.
// Vitals, medicines and labs follow the same demonstration charts as the
// other patients. Findings are sentences from that patient's own report.
// CURV and Azure are not called.

const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { reportSections } = require('../utils/mimic');
const { buildChart } = require('./demoCharts');

const URGENT = /\b(intubat|respiratory failure|tension pneumo|large pleural effusion|pulmonary edema|pulmonary oedema|hypoxi[ac]|sepsis)\b/i;

function hash(text) {
  return crypto.createHash('sha1').update(String(text)).digest()[0];
}

function demographics(text, patientId) {
  let sex = '';
  if (/___\s*F\b|\bfemale\b|\bwoman\b|\bgirl\b/i.test(text)) sex = 'Female';
  else if (/___\s*M\b|\bmale\b|\bman\b|\bboy\b/i.test(text)) sex = 'Male';
  else sex = hash(`${patientId}:sex`) % 2 ? 'Female' : 'Male';
  const ageMatch = String(text).match(/\b(\d{1,3})\s*-?\s*years?\s*-?\s*old\b/i)
    || String(text).match(/\b(\d{1,3})\s*(?:yo|y\/o)\b/i);
  const stated = ageMatch ? Number(ageMatch[1]) : 0;
  const age = stated >= 1 && stated <= 110 ? String(stated) : String(22 + (hash(`${patientId}:age`) % 68));
  return { age, sex };
}

function kindOf(text, sentences, isNormal) {
  if (URGENT.test(text)) return 'urgent';
  if (sentences.some((sentence) => !isNormal(sentence))) return 'abnormal';
  return 'none';
}

function findingRows(text, sentencesOf, isNormal) {
  const sections = reportSections(text);
  let source = sections.FINDINGS || sections.IMPRESSION || sections.CONCLUSION || '';
  if (!String(source).trim()) {
    source = String(text).replace(/^[\s\S]*?(?:INDICATION|CLINICAL HISTORY|HISTORY)\s*:[^\n]*\n?/i, '');
  }
  let sentences = sentencesOf(source).slice(0, 6);
  if (!sentences.length) sentences = sentencesOf(text).slice(0, 4);
  return sentences.map((sentence) => {
    const significant = /\b(severe|large|marked|extensive|tension|intubat|respiratory failure|edema|oedema|pneumothorax|consolidation|effusion)\b/i.test(sentence);
    let severity = 'normal';
    if (!isNormal(sentence)) severity = significant ? 'significant' : 'minor';
    return {
      label: sentence.slice(0, 80),
      detail: sentence,
      location: '',
      severity,
    };
  });
}

function chartSpec(patientId, kind, history) {
  const n = hash(patientId);
  const wing = kind === 'none' ? '4A' : '4B';
  const bed = `${wing}-${String((n % 20) + 1).padStart(2, '0')}`;
  const end = new Date(Date.UTC(2026, 10, 12, 2 + (n % 6), n % 50)).toISOString();
  const base = kind === 'urgent'
    ? { hr: 112, rr: 24, sbp: 108, spo2: 91, temp: 38.0, wbc: 14.2, lactate: 2.4, crp: 48 }
    : kind === 'abnormal'
      ? { hr: 94, rr: 18, sbp: 122, spo2: 96, temp: 37.6, wbc: 11.8, lactate: 1.5, crp: 24 }
      : { hr: 74, rr: 16, sbp: 120, spo2: 98, temp: 36.6, wbc: 7.4, lactate: 0.9, crp: 4 };
  const vitals = {
    hr: base.hr + (n % 7) - 3,
    rr: base.rr + (n % 3) - 1,
    sbp: base.sbp + (n % 11) - 5,
    spo2: Math.min(100, base.spo2 + (n % 3) - 1),
    temp: Math.round((base.temp + ((n % 5) - 2) * 0.1) * 10) / 10,
    wbc: Math.round((base.wbc + ((n % 5) - 2) * 0.3) * 10) / 10,
    lactate: Math.round((base.lactate + ((n % 5) - 2) * 0.1) * 10) / 10,
    crp: Math.max(1, base.crp + (n % 7) - 3),
  };
  return { patientId, kind, bed, admissionStatus: 'admitted', end, history, vitals };
}

async function main() {
  const { sentencesOf, isNormalSentence } = await import('../../shared/reportTags.js');
  const connectDB = require('../config/db');
  const Case = require('../models/Case');
  const Patient = require('../models/Patient');
  await connectDB();

  const rows = await Case.find({ caseId: /^CASE-MIMIC-/, imageId: { $ne: null } })
    .select('caseId patientId reportText history')
    .lean();
  let patients = 0;
  let findings = 0;
  const chunk = 20;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const patientOps = [];
    const caseOps = [];
    for (const row of slice) {
      const text = String(row.reportText || '');
      const sections = reportSections(text);
      const source = sections.FINDINGS || sections.IMPRESSION || sections.CONCLUSION || text;
      const sentences = sentencesOf(source);
      const kind = kindOf(text, sentences, isNormalSentence);
      const demo = demographics(text, row.patientId);
      const spec = chartSpec(row.patientId, kind, row.history || '');
      const built = buildChart(spec);
      const ward = spec.bed.startsWith('4B') ? '4B' : '4A';
      const chart = findingRows(text, sentencesOf, isNormalSentence);
      patientOps.push({
        updateOne: {
          filter: { patientId: row.patientId },
          update: {
            $set: {
              age: demo.age,
              sex: demo.sex,
              ward,
              bed: spec.bed,
              admissionStatus: 'admitted',
              heartRate: built.heartRate,
              labResults: built.labResults,
              medicines: built.medicines,
              remarks: built.remarks,
              observations: built.observations,
              labOrders: built.labOrders,
              medOrders: built.medOrders,
              careNotes: built.careNotes,
            },
          },
        },
      });
      caseOps.push({
        updateOne: {
          filter: { caseId: row.caseId },
          update: {
            $set: {
              age: demo.age,
              sex: demo.sex,
              chartFindings: chart,
              chartFindingsState: 'done',
              chartFindingsAt: new Date(),
              chartFindingsError: '',
            },
          },
        },
      });
      if (chart.length) findings += 1;
    }
    await Patient.bulkWrite(patientOps, { ordered: true });
    await Case.bulkWrite(caseOps, { ordered: true });
    patients += slice.length;
    console.log(`${patients}/${rows.length}`);
  }

  const sample = await Patient.findOne({ patientId: 'PT-MIMIC-10052277' })
    .select('name age sex heartRate medicines labResults bed observations')
    .lean();
  const sampleCase = sample
    ? await Case.findOne({ patientId: 'PT-MIMIC-10052277' }).select('chartFindings').lean()
    : null;
  console.log(JSON.stringify({
    patients,
    withFindings: findings,
    sample: sample && {
      name: sample.name,
      age: sample.age,
      sex: sample.sex,
      bed: sample.bed,
      heartRate: sample.heartRate,
      medicines: String(sample.medicines).slice(0, 80),
      labs: String(sample.labResults).slice(0, 80),
      vitals: sample.observations && sample.observations[sample.observations.length - 1],
      findings: (sampleCase?.chartFindings || []).length,
    },
  }, null, 2));
  await require('../config/db').disconnectDB();
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
