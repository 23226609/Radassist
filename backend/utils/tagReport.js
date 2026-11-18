// utils/tagReport.js
// The sentence-tag rules live in shared/ as ES modules, so the browser and
// this API read a report the same way. This file loads them from CommonJS.

let loaded = null;

function modules() {
  if (!loaded) {
    loaded = Promise.all([
      import('../../shared/reportTags.js'),
      import('../../shared/reportText.js'),
    ]).then(([tags, text]) => ({ tags, text }));
  }
  return loaded;
}

const clean = (rows) => (Array.isArray(rows) ? rows : []).map((row) => (row && typeof row.toObject === 'function' ? row.toObject() : { ...row }));

// FINDINGS sentences, the COMMENT line and the hidden Thinking block of a CURV reply.
async function derive(reportText) {
  const { tags } = await modules();
  return tags.deriveFromReport(reportText);
}

// The stored report text for these tags: title, FINDINGS, COMMENT, thanks,
// then the hidden Thinking block and the radiologist's remarks.
async function assemble({ view = '', tags = [], comment = '', previousReportText = '', remarks = '' }) {
  const { tags: t, text } = await modules();
  const thinking = text.thinkingBlockOf(text.splitReportAndRemarks(previousReportText).body);
  const body = t.assembleReport({ view, tags: clean(tags), comment, thinking });
  return text.applyRemarksToReport(body, remarks).reportText;
}

async function isNormalSentence(sentence) {
  const { tags } = await modules();
  return tags.isNormalSentence(sentence);
}

module.exports = { derive, assemble, isNormalSentence };
