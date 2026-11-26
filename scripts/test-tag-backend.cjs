// scripts/test-tag-backend.cjs
//
// The API side of sentence tags: assembling the stored report, one Azure box
// per abnormal tag, merging boxes with the radiologist's work, the edit log
// and what a technician is allowed to see.
//
//   node scripts/test-tag-backend.cjs

const assert = require('assert');
const tagReport = require('../backend/utils/tagReport');
const { mergeTagBoxes } = require('../backend/utils/findingsMerge');
const { buildEditChanges } = require('../backend/utils/editDiff');
const { toPublicCase } = require('../backend/utils/caseStatus');
const azure = require('../backend/utils/azureFindings');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

const CURV = [
  'Findings:',
  'The lung volumes are low. There is bibasilar atelectasis. The heart size is normal.',
  '',
  'Thinking:',
  'Low volumes favour atelectasis.',
  '',
  'Impression:',
  'Bibasilar atelectasis.',
].join('\n');

const tag = (key, text, abnormal, extra = {}) => ({ key, text, abnormal, kind: '', ...extra });
const box = (tagKey, extra = {}) => ({ label: tagKey, bbox: [10, 10, 20, 20], tagKey, source: 'Azure', bboxSource: 'vision', status: 'pending', ...extra });

(async () => {
  console.log('\n=== the stored report ===');

  await test('a CURV draft is derived into sentence tags and a COMMENT, Thinking kept apart', async () => {
    const d = await tagReport.derive(CURV);
    assert.deepStrictEqual(d.findingTags.map((t) => t.text), [
      'The lung volumes are low.', 'There is bibasilar atelectasis.', 'The heart size is normal.',
    ]);
    assert.strictEqual(d.comment, 'Bibasilar atelectasis.');
    assert.ok(d.thinking.includes('Low volumes favour atelectasis.'));
  });

  await test('assemble writes the layout and keeps the Thinking block from the previous text', async () => {
    const d = await tagReport.derive(CURV);
    const text = await tagReport.assemble({ view: 'PA', tags: d.findingTags, comment: d.comment, previousReportText: CURV, remarks: '' });
    assert.ok(text.startsWith('XRAY CHEST (PA)\n\nFINDINGS\nThe lung volumes are low.\nThere is bibasilar atelectasis.\nThe heart size is normal.\n\nCOMMENT\n– Bibasilar atelectasis.'));
    assert.ok(text.includes('Low volumes favour atelectasis.'), 'Thinking stays stored');
  });

  await test('assemble puts the radiologist remarks after the report', async () => {
    const text = await tagReport.assemble({ view: '', tags: [tag('t1', 'Heart size is normal.', false)], comment: 'Normal.', previousReportText: '', remarks: 'Compare with old films.' });
    assert.ok(text.startsWith('XRAY CHEST\n\nFINDINGS'));
    assert.ok(/Radiologist remarks\s+Compare with old films\./.test(text));
  });

  await test('a new order of tags is the new order of lines', async () => {
    const tags = [tag('t2', 'B.', false), tag('t1', 'A.', false)];
    const text = await tagReport.assemble({ tags, comment: '', previousReportText: '' });
    assert.ok(text.includes('FINDINGS\nB.\nA.\n\nCOMMENT'));
  });

  await test('Thinking never leaks into a Thinking-aware reader of the COMMENT layout', async () => {
    const d = await tagReport.derive(CURV);
    const text = await tagReport.assemble({ view: 'PA', tags: d.findingTags, comment: d.comment, previousReportText: CURV });
    assert.ok(!azure.withoutThinking(text).includes('Low volumes favour'));
    assert.ok(azure.withoutThinking(text).includes('COMMENT'));
  });

  console.log('\n=== one Azure box per abnormal tag ===');

  const tags = [
    tag('t1', 'Small right pleural effusion.', true),
    tag('t2', 'Heart size is normal.', false),
    tag('t3', 'Left basal opacity.', true, { boxDeclined: true }),
    tag('t4', 'Cardiothoracic ratio is increased, 14.0 : 25.0.', true, { kind: 'ctr' }),
    tag('t5', 'Right apical nodule.', true),
  ];

  await test('only abnormal, undeclined, non-ratio tags are sent to Azure', () => {
    assert.deepStrictEqual(azure.tagsNeedingBoxes(tags).map((t) => t.key), ['t1', 't5']);
    assert.deepStrictEqual(azure.tagsNeedingBoxes([]), []);
  });

  await test('Azure boxes are taken for the tags asked for, once each, in the tag\'s words', () => {
    const rows = azure.parseTagBoxes({
      boxes: [
        { key: 't1', bbox: [60, 60, 20, 15] },
        { key: 't1', bbox: [1, 1, 30, 30] },
        { key: 't2', bbox: [30, 30, 20, 20] },
        { key: 't3', bbox: [10, 60, 20, 20] },
        { key: 't4', bbox: [30, 50, 40, 25] },
        { key: 'nope', bbox: [30, 30, 20, 20] },
        { key: 't5', bbox: [20, 5, 15, 15] },
      ],
    }, tags);
    assert.deepStrictEqual(rows.map((r) => r.tagKey), ['t1', 't5']);
    assert.strictEqual(rows[0].label, 'Small right pleural effusion.');
    assert.strictEqual(rows[0].sentence, 'Small right pleural effusion.');
    assert.strictEqual(rows[0].bbox.join(), '60,60,20,15');
  });

  await test('a reply without a boxes list is an error, not an empty success', () => {
    assert.throws(() => azure.parseTagBoxes({ nothing: true }, tags), /no boxes/);
  });

  await test('a key Azure skips still gets one zone box', () => {
    const rows = azure.parseTagBoxes({ boxes: [{ key: 't1', bbox: [60, 60, 20, 15] }] }, tags);
    const missed = rows.find((row) => row.tagKey === 't5');
    assert.ok(missed);
    assert.equal(missed.bboxSource, 'zone');
    assert.equal(missed.sentence, 'Right apical nodule.');
  });

  await test('no abnormal tag means no Azure call at all', async () => {
    const out = await azure.placeTagBoxes([tag('t1', 'Heart size is normal.', false)], null);
    assert.deepStrictEqual(out, { boxes: [] });
  });

  console.log('\n=== merging with the radiologist\'s work ===');

  const keys = (rows) => rows.map((r) => r.tagKey).sort();

  await test('a box the radiologist drew or moved is kept, a machine box is replaced', () => {
    const previous = [
      box('t1', { source: 'manual', bboxSource: 'manual', bbox: [1, 1, 5, 5] }),
      box('t5', { bbox: [2, 2, 2, 2] }),
    ];
    const out = mergeTagBoxes(previous, tags, [box('t1', { bbox: [50, 50, 10, 10] }), box('t5', { bbox: [70, 70, 10, 10] })]);
    assert.deepStrictEqual(out.find((f) => f.tagKey === 't1').bbox, [1, 1, 5, 5]);
    assert.deepStrictEqual(out.find((f) => f.tagKey === 't5').bbox, [70, 70, 10, 10]);
    assert.strictEqual(out.filter((f) => f.tagKey === 't1').length, 1, 'one box per tag');
  });

  await test('a deleted box stays deleted and a declined tag gets none', () => {
    const previous = [box('t1', { status: 'rejected' })];
    const out = mergeTagBoxes(previous, tags, [box('t1'), box('t3'), box('t5')]);
    assert.strictEqual(out.filter((f) => f.tagKey === 't1' && f.status !== 'rejected').length, 0);
    assert.strictEqual(out.some((f) => f.tagKey === 't3'), false);
    assert.strictEqual(out.some((f) => f.tagKey === 't5'), true);
  });

  await test('a normal tag never gains a box, even if Azure returns one', () => {
    const out = mergeTagBoxes([], tags, [box('t2'), box('t1')]);
    assert.deepStrictEqual(keys(out), ['t1']);
  });

  await test('a normal tag loses a machine box it had, but a ratio box is never replaced by Azure', () => {
    const out = mergeTagBoxes([box('t2')], tags, []);
    assert.strictEqual(out.some((f) => f.tagKey === 't2'), false);
    const ctr = mergeTagBoxes([box('t4', { source: 'manual', bboxSource: 'manual' })], tags, [box('t4', { bbox: [90, 90, 5, 5] })]);
    assert.strictEqual(ctr.filter((f) => f.tagKey === 't4').length, 1);
    assert.deepStrictEqual(ctr[0].bbox, [10, 10, 20, 20]);
  });

  await test('the box of a deleted tag is dropped, and boxes with no tag are kept', () => {
    const out = mergeTagBoxes([box('t9'), { label: 'Old card', bbox: [1, 1, 9, 9], status: 'pending' }], tags, []);
    assert.strictEqual(out.some((f) => f.tagKey === 't9'), false);
    assert.strictEqual(out.some((f) => f.label === 'Old card'), true);
  });

  console.log('\n=== the edit log ===');

  await test('switching normal/abnormal and reordering are logged', () => {
    const before = [tag('t1', 'A.', true), tag('t2', 'B.', false), tag('t3', 'C.', false)];
    const after = [tag('t3', 'C.', false), tag('t1', 'A.', false), tag('t2', 'B.', false)];
    const { changes } = buildEditChanges({ findingTags: before }, { findingTags: after });
    assert.ok(changes.some((c) => c.field === 'tag' && c.before === 'abnormal' && c.after === 'normal'));
    assert.ok(changes.some((c) => c.field === 'order'));
  });

  await test('an unchanged tag list logs nothing', () => {
    const list = [tag('t1', 'A.', true), tag('t2', 'B.', false)];
    assert.strictEqual(buildEditChanges({ findingTags: list }, { findingTags: list }).changes.length, 0);
  });

  console.log('\n=== who sees what ===');

  const stored = {
    caseId: 'CASE-1',
    status: 'pending_approve',
    reportText: 'XRAY CHEST (PA)\n\nFINDINGS\nA.',
    findingTags: [tag('t1', 'A.', true)],
    comment: 'A.',
    findings: [box('t1')],
    measurements: [{ tagKey: 't1' }],
    imageId: 'img',
    sourceReport: { label: 'MIMIC report', text: 'INDICATION: cough' },
  };

  await test('a technician gets no draft, tags, comment, boxes or MIMIC report', () => {
    const pub = toPublicCase(stored, { hideFilm: true });
    assert.strictEqual(pub.reportText, '');
    assert.deepStrictEqual(pub.findingTags, []);
    assert.strictEqual(pub.comment, '');
    assert.deepStrictEqual(pub.findings, []);
    assert.strictEqual(pub.sourceReport, undefined);
  });

  await test('a radiologist gets everything, and public provenance is stripped from shared cases', () => {
    const pub = toPublicCase(stored, {});
    assert.strictEqual(pub.findingTags.length, 1);
    assert.strictEqual(pub.sourceReport.label, 'MIMIC report');
    const shared = toPublicCase(stored, { stripProvenance: true });
    assert.strictEqual(shared.sourceReport, undefined);
    assert.ok(shared.findings.every((f) => f.source === undefined));
    assert.strictEqual(shared.findingTags.length, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
