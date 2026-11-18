#!/usr/bin/env node
// Label each whole sentence of a collected MIMIC report normal or abnormal.
// Azure does the labelling. The official report text is not rewritten, and
// the film is not sent through CURV. A sentence that only denies a finding
// stays normal.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { reportSections } = require('../utils/mimic');
const { isConfigured, classifySentences, applySentenceLabels } = require('../utils/azureFindings');

const SIGNIFICANT = /\b(severe|large|marked|extensive|tension|intubat|respiratory failure|edema|oedema|pneumothorax|consolidation|effusion)\b/i;

function viewFromHeader(position) {
  const v = String(position || '').trim().toUpperCase();
  if (v === 'PA') return 'PA';
  if (v === 'AP') return 'AP';
  if (v === 'LATERAL' || v === 'LAT' || v === 'LL' || v === 'RL' || /\bLATERAL\b/.test(v)) return 'Lateral';
  return '';
}

function commentOf(text) {
  const sections = reportSections(text);
  const raw = sections.IMPRESSION || sections.CONCLUSION || sections.COMMENT || '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function findingSentences(text, sentencesOf) {
  const sections = reportSections(text);
  const source = sections.FINDINGS || sections.IMPRESSION || sections.CONCLUSION || '';
  const sentences = sentencesOf(source);
  return sentences.length ? sentences : sentencesOf(text);
}

function chartRows(labeled) {
  return labeled.slice(0, 6).map((row) => {
    const significant = SIGNIFICANT.test(row.text);
    return {
      label: row.text.slice(0, 80),
      detail: row.text.slice(0, 300),
      location: '',
      severity: row.abnormal ? (significant ? 'significant' : 'minor') : 'normal',
    };
  });
}

function tagsOf(labeled) {
  return labeled.map((row, i) => ({
    key: `t${i + 1}`,
    text: row.text.slice(0, 500),
    abnormal: Boolean(row.abnormal),
    manual: false,
    kind: '',
    boxDeclined: false,
  }));
}

async function labelOne(sentences, isNormalSentence, azureOn, slow) {
  if (!azureOn) return applySentenceLabels(sentences, {}, isNormalSentence);
  let last;
  const tries = slow ? 6 : 3;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await classifySentences(sentences, isNormalSentence);
    } catch (err) {
      last = err;
      const limited = /429|503|timeout/i.test(err.message);
      if (!limited) break;
      const wait = (slow ? 8000 : 2000) * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

async function main() {
  const { sentencesOf, isNormalSentence } = await import('../../shared/reportTags.js');
  const connectDB = require('../config/db');
  const Case = require('../models/Case');
  await connectDB();

  const azureOn = isConfigured();
  const slow = process.argv.includes('--retry-agreed');
  const rows = await Case.find({ caseId: /^CASE-MIMIC-/, imageId: { $ne: null } })
    .select('caseId patientId reportText sourceReport comment view dicomViewPosition findingTags')
    .lean();
  const work = slow
    ? rows.filter((row) => (row.findingTags || []).every((tag) => Boolean(tag.abnormal) === !isNormalSentence(tag.text)))
    : rows;

  const updates = [];
  let azure = 0;
  let local = 0;
  let skipped = 0;
  let laterals = 0;
  const failures = [];

  let cursor = 0;
  async function worker() {
    while (cursor < work.length) {
      const row = work[cursor];
      cursor += 1;
      if (slow) await new Promise((resolve) => setTimeout(resolve, 2500));
      const text = String(row.sourceReport?.text || row.reportText || '');
      const sentences = findingSentences(text, sentencesOf);
      if (!sentences.length) {
        skipped += 1;
        continue;
      }
      let labeled;
      try {
        labeled = await labelOne(sentences, isNormalSentence, azureOn, slow);
        if (labeled.some((item) => item.source === 'azure' || item.source === 'azure-denial')) azure += 1;
        else local += 1;
      } catch (err) {
        labeled = applySentenceLabels(sentences, {}, isNormalSentence);
        local += 1;
        failures.push(`${row.caseId}: ${err.message}`);
      }
      const comment = commentOf(text) || String(row.comment || '').trim();
      const headerView = viewFromHeader(row.dicomViewPosition);
      const view = row.view || headerView;
      if (view === 'Lateral' && row.view !== 'Lateral') laterals += 1;
      const set = {
        findingTags: tagsOf(labeled),
        comment,
        chartFindings: chartRows(labeled),
        chartFindingsState: 'done',
        chartFindingsError: '',
      };
      if (view && view !== row.view) set.view = view;
      updates.push({
        updateOne: {
          filter: { caseId: row.caseId },
          update: { $set: set },
        },
      });
      if ((azure + local + skipped) % 20 === 0) {
        console.log(`${azure + local + skipped}/${work.length}`);
      }
    }
  }

  const workers = azureOn && !slow ? 3 : 1;
  await Promise.all(Array.from({ length: Math.min(workers, work.length || 1) }, worker));

  for (let i = 0; i < updates.length; i += 15) {
    await Case.bulkWrite(updates.slice(i, i + 15), { ordered: true });
  }

  const sample = await Case.findOne({ patientId: 'PT-MIMIC-10052277' })
    .select('caseId view dicomViewPosition comment findingTags examinedAt chartFindings')
    .lean();
  console.log(JSON.stringify({
    cases: work.length,
    azure,
    local,
    skipped,
    laterals,
    azureConfigured: azureOn,
    failures: failures.slice(0, 5),
    sample: sample && {
      caseId: sample.caseId,
      view: sample.view,
      dicomViewPosition: sample.dicomViewPosition,
      comment: sample.comment,
      examinedYear: sample.examinedAt ? new Date(sample.examinedAt).getUTCFullYear() : null,
      tags: (sample.findingTags || []).map((tag) => ({
        abnormal: tag.abnormal,
        text: tag.text,
      })),
    },
  }, null, 2));
  await connectDB.disconnectDB();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
