// scripts/test-xray-slots.cjs — booking slots, quotas and availability (no database).
const assert = require('node:assert');
const path = require('node:path');

process.env.BOOKING_UTC_OFFSET = '+08:00';
process.env.XRAY_SLOT_CAPACITY = '2';
process.env.XRAY_DAILY_QUOTA = '5';

const Case = require(path.join(__dirname, '../backend/models/Case'));
let rows = [];
Case.find = (query) => {
  const { $gte, $lt } = query.scheduledAt;
  const hit = rows.filter((r) => r.scheduledAt >= $gte && r.scheduledAt < $lt);
  const chain = {
    sort: () => chain,
    lean: async () => hit,
  };
  return chain;
};

const slots = require(path.join(__dirname, '../backend/utils/xraySlots'));

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

const book = (caseId, day, time, urgent = false) => rows.push({ caseId, urgent, scheduledAt: slots.slotInstant(day, time) });
// Thursday 22 Oct 2026, 11:10 in Hong Kong.
const now = new Date('2026-10-22T03:10:00Z');

(async () => {
  console.log('\n=== X-ray booking slots ===');

  await test('slots run 09:00–12:30 and 14:00–16:30 every 30 minutes', () => {
    assert.equal(slots.SLOT_TIMES[0], '09:00');
    assert.ok(slots.SLOT_TIMES.includes('12:30'));
    assert.ok(!slots.SLOT_TIMES.includes('13:00'), 'lunch hour should be closed');
    assert.equal(slots.SLOT_TIMES[slots.SLOT_TIMES.length - 1], '16:30');
    assert.equal(slots.SLOT_TIMES.length, 14);
  });

  await test('days and times are hospital local time', () => {
    assert.equal(slots.slotInstant('2026-10-23', '09:00').toISOString(), '2026-10-23T01:00:00.000Z');
    assert.deepEqual(slots.localParts(new Date('2026-10-22T16:30:00Z')), { day: '2026-10-23', time: '00:30' });
  });

  await test('Sundays are closed and past days are not bookable', async () => {
    rows = [];
    const days = await slots.availability('2026-10-21', '2026-10-25', now);
    const by = Object.fromEntries(days.map((d) => [d.day, d]));
    assert.equal(by['2026-10-21'].status, 'past');
    assert.equal(by['2026-10-25'].status, 'closed');
    assert.equal(by['2026-10-23'].status, 'open');
    assert.equal(by['2026-10-23'].left, 5, 'daily quota caps the places left');
  });

  await test('earlier times today have passed', async () => {
    rows = [];
    const [today] = await slots.availability('2026-10-22', '2026-10-22', now);
    assert.equal(today.slots.find((s) => s.time === '11:00').status, 'past');
    assert.equal(today.slots.find((s) => s.time === '11:30').status, 'open');
    assert.ok(await slots.slotProblem('2026-10-22', '10:00', now));
  });

  await test('a slot is full at its capacity and the day shows few left', async () => {
    rows = [];
    book('A', '2026-10-23', '10:00');
    book('B', '2026-10-23', '10:00');
    const [day] = await slots.availability('2026-10-23', '2026-10-23', now);
    const ten = day.slots.find((s) => s.time === '10:00');
    assert.equal(ten.status, 'full');
    assert.equal(ten.booked, 2);
    assert.equal(day.left, 3);
    assert.equal(day.status, 'few');
    assert.match(await slots.slotProblem('2026-10-23', '10:00', now), /fully booked/);
    assert.equal(await slots.slotProblem('2026-10-23', '10:30', now), '');
  });

  await test('the daily quota closes every slot', async () => {
    rows = [];
    ['09:00', '09:00', '09:30', '09:30', '10:00'].forEach((t, i) => book(`Q${i}`, '2026-10-23', t));
    const [day] = await slots.availability('2026-10-23', '2026-10-23', now);
    assert.equal(day.status, 'full');
    assert.equal(day.left, 0);
    assert.ok(day.slots.every((s) => s.status !== 'open'));
    assert.match(await slots.slotProblem('2026-10-23', '15:00', now), /daily quota/);
  });

  await test('invalid days and times are refused', async () => {
    assert.match(await slots.slotProblem('2026-13-40', '10:00', now), /day/);
    assert.match(await slots.slotProblem('2026-10-23', '10:15', now), /listed times/);
    assert.match(await slots.slotProblem('2026-10-25', '10:00', now), /closed/);
  });

  await test('an urgent patient can still be added when the day is full', async () => {
    rows = [];
    ['09:00', '09:00', '09:30', '09:30', '10:00'].forEach((t, i) => book(`Q${i}`, '2026-10-23', t));
    assert.equal(await slots.slotProblem('2026-10-23', '15:00', now, { urgent: true }), '');
    assert.match(await slots.slotProblem('2026-10-23', '15:00', now), /daily quota/);
    assert.match(await slots.slotProblem('2026-10-22', '10:00', now, { urgent: true }), /passed/);
    assert.match(await slots.slotProblem('2026-10-25', '10:00', now, { urgent: true }), /closed/);
    rows = [];
    book('A', '2026-10-23', '15:00');
    book('B', '2026-10-23', '15:00');
    book('RUSH', '2026-10-23', '15:00', true);
    book('LATE', '2026-10-23', '15:00');
    assert.equal(await slots.overbooked('RUSH', '2026-10-23', '15:00'), '');
    assert.match(await slots.overbooked('LATE', '2026-10-23', '15:00'), /just taken/);
  });

  await test('the later of two racing bookings for the last place loses', async () => {
    rows = [];
    book('FIRST', '2026-10-23', '14:00');
    book('SECOND', '2026-10-23', '14:00');
    book('THIRD', '2026-10-23', '14:00');
    assert.equal(await slots.overbooked('SECOND', '2026-10-23', '14:00'), '');
    assert.match(await slots.overbooked('THIRD', '2026-10-23', '14:00'), /just taken/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
