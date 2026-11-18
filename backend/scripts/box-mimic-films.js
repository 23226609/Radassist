#!/usr/bin/env node
// Draw one film box for each abnormal sentence on a collected MIMIC case.
// Azure looks at that case's own film. The official report is not rewritten,
// the status stays endorsed, and the film is not sent through CURV.
// A normal sentence is never sent, so it never gains a box.
//
//   node backend/scripts/box-mimic-films.js
//   node backend/scripts/box-mimic-films.js --case CASE-MIMIC-50476467

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { isConfigured, placeTagBoxes, tagsNeedingBoxes } = require('../utils/azureFindings');
const { mergeTagBoxes } = require('../utils/findingsMerge');
const { downloadImage } = require('../controllers/_gridfs');

function hasBox(finding) {
  const box = finding?.bbox;
  return Array.isArray(box) && box.length === 4 && Number(box[2]) > 0 && Number(box[3]) > 0
    && finding.status !== 'rejected';
}

function missingTags(row) {
  const tags = Array.isArray(row.findingTags) ? row.findingTags : [];
  const boxed = new Set((row.findings || []).filter(hasBox).map((f) => f.tagKey));
  return tagsNeedingBoxes(tags).filter((tag) => !boxed.has(tag.key));
}

async function placeOne(row, tries) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const image = await downloadImage(row.imageId, { persistShrink: false });
      return await placeTagBoxes(missingTags(row), image, { view: row.view });
    } catch (err) {
      last = err;
      const limited = /429|503|timeout|ECONNRESET|fetch failed/i.test(err.message || '');
      if (!limited || attempt + 1 === tries) break;
      const wait = 4000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

async function main() {
  if (!isConfigured()) {
    throw new Error('Azure OpenAI is not configured. Boxes are not invented locally.');
  }
  const only = (process.argv.find((arg, i) => process.argv[i - 1] === '--case') || '').trim();
  const connectDB = require('../config/db');
  const Case = require('../models/Case');
  await connectDB();

  const query = { caseId: only || /^CASE-MIMIC-/, imageId: { $ne: null }, status: 'finalized' };
  const rows = await Case.find(query)
    .select('caseId patientId view findingTags findings imageId')
    .lean();
  const work = rows.filter((row) => missingTags(row).length);

  let done = 0;
  let failed = 0;
  let boxes = 0;
  let vision = 0;
  let zone = 0;
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < work.length) {
      const row = work[cursor];
      cursor += 1;
      const wanted = missingTags(row).length;
      try {
        const placed = await placeOne(row, 4);
        const incoming = placed.boxes || [];
        if (!incoming.length) throw new Error('Azure returned no box');
        const doc = await Case.findOne({ caseId: row.caseId, status: 'finalized' });
        if (!doc) throw new Error('case was not endorsed when the boxes came back');
        doc.findings = mergeTagBoxes(doc.findings, doc.findingTags, incoming);
        doc.boxesState = 'done';
        await doc.save();
        done += 1;
        boxes += incoming.length;
        vision += incoming.filter((f) => f.bboxSource === 'vision').length;
        zone += incoming.filter((f) => f.bboxSource === 'zone').length;
        const short = incoming.length < wanted ? ` (${incoming.length}/${wanted})` : '';
        console.log(`${done + failed}/${work.length} ${row.caseId} ${incoming.length} box${incoming.length === 1 ? '' : 'es'}${short}`);
      } catch (err) {
        failed += 1;
        failures.push(`${row.caseId}: ${err.message}`);
        await Case.updateOne(
          { caseId: row.caseId, status: 'finalized' },
          { $set: { boxesState: 'failed' } },
        ).catch(() => {});
        console.log(`${done + failed}/${work.length} ${row.caseId} FAILED ${err.message}`);
      }
    }
  }

  const workers = Math.min(2, work.length || 1);
  await Promise.all(Array.from({ length: workers }, worker));

  const sample = await Case.findOne({ patientId: 'PT-MIMIC-10052277' })
    .select('caseId view boxesState reportText comment findingTags findings')
    .lean();
  console.log(JSON.stringify({
    queued: work.length,
    done,
    failed,
    boxes,
    vision,
    zone,
    failures: failures.slice(0, 8),
    kin: sample && {
      caseId: sample.caseId,
      view: sample.view,
      boxesState: sample.boxesState,
      comment: sample.comment,
      reportUntouched: String(sample.reportText || '').includes('No pleural effusion or pneumothorax is present'),
      tags: (sample.findingTags || []).map((tag) => ({ abnormal: tag.abnormal, text: tag.text })),
      boxes: (sample.findings || []).map((f) => ({
        tagKey: f.tagKey,
        bboxSource: f.bboxSource,
        bbox: f.bbox,
        sentence: f.sentence,
      })),
    },
  }, null, 2));
  await connectDB.disconnectDB();
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
