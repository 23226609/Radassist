// Chest X-ray booking slots and quotas. Days and times are hospital local time
// (BOOKING_UTC_OFFSET, Hong Kong by default) whatever the server's time zone.

const Case = require('../models/Case');

const { OWNED } = Case;

const UTC_OFFSET = process.env.BOOKING_UTC_OFFSET || '+08:00';
const SLOT_CAPACITY = Math.max(1, Number(process.env.XRAY_SLOT_CAPACITY) || 2);
const DAILY_QUOTA = Math.max(1, Number(process.env.XRAY_DAILY_QUOTA) || 20);
const SLOT_MINUTES = 30;
const SESSIONS = [['09:00', '13:00'], ['14:00', '17:00']];
const CLOSED_WEEKDAYS = new Set([0]);
const MAX_RANGE_DAYS = 62;
const FEW_LEFT = 4;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function timeOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const SLOT_TIMES = SESSIONS.flatMap(([start, end]) => {
  const out = [];
  for (let m = minutesOf(start); m < minutesOf(end); m += SLOT_MINUTES) out.push(timeOf(m));
  return out;
});

function offsetMs() {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(UTC_OFFSET);
  if (!m) return 8 * 3600000;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 3600000 + Number(m[3]) * 60000);
}

function slotInstant(day, time) {
  return new Date(`${day}T${time}:00${UTC_OFFSET}`);
}

// Hospital-local day and HH:MM of an instant.
function localParts(date) {
  const shifted = new Date(new Date(date).getTime() + offsetMs());
  const iso = shifted.toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(day) {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function isValidDay(day) {
  return DAY_RE.test(day || '') && !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

async function countBookings(fromDay, toDayExclusive) {
  const rows = await Case.find(
    { ...OWNED, scheduledAt: { $gte: slotInstant(fromDay, '00:00'), $lt: slotInstant(toDayExclusive, '00:00') } },
    { scheduledAt: 1 }
  ).lean();
  const byDay = new Map();
  for (const row of rows) {
    const { day, time } = localParts(row.scheduledAt);
    if (!byDay.has(day)) byDay.set(day, { total: 0, slots: new Map() });
    const entry = byDay.get(day);
    entry.total += 1;
    entry.slots.set(time, (entry.slots.get(time) || 0) + 1);
  }
  return byDay;
}

function describeDay(day, counts, now) {
  const today = localParts(now);
  const booked = counts?.total || 0;
  const closed = CLOSED_WEEKDAYS.has(weekday(day));
  const past = day < today.day;
  const quotaLeft = Math.max(0, DAILY_QUOTA - booked);
  const slots = SLOT_TIMES.map((time) => {
    const taken = counts?.slots.get(time) || 0;
    let status = 'open';
    if (closed || past || (day === today.day && time <= today.time)) status = 'past';
    else if (taken >= SLOT_CAPACITY || quotaLeft === 0) status = 'full';
    return { time, booked: taken, capacity: SLOT_CAPACITY, left: status === 'open' ? SLOT_CAPACITY - taken : 0, status };
  });
  const openSlots = slots.filter((s) => s.status === 'open');
  const left = Math.min(quotaLeft, openSlots.reduce((sum, s) => sum + s.left, 0));
  let status = 'open';
  if (closed) status = 'closed';
  else if (past || (day === today.day && slots.every((s) => s.status === 'past'))) status = 'past';
  else if (left === 0) status = 'full';
  else if (left <= FEW_LEFT) status = 'few';
  return { day, status, booked, quota: DAILY_QUOTA, left, slots };
}

async function availability(fromDay, toDay, now = new Date()) {
  if (!isValidDay(fromDay) || !isValidDay(toDay) || toDay < fromDay) {
    throw new Error('Give from and to as YYYY-MM-DD.');
  }
  const days = [];
  for (let d = fromDay; d <= toDay && days.length < MAX_RANGE_DAYS; d = addDays(d, 1)) days.push(d);
  const counts = await countBookings(days[0], addDays(days[days.length - 1], 1));
  return days.map((day) => describeDay(day, counts.get(day), now));
}

// Why this slot cannot be booked, or '' when it can.
// An urgent patient can still be added when the day or the time is full.
// A closed day or a time that has passed stays closed.
async function slotProblem(day, time, now = new Date(), { urgent = false } = {}) {
  if (!isValidDay(day)) return 'Choose a day on the calendar.';
  if (!TIME_RE.test(time || '') || !SLOT_TIMES.includes(time)) return 'Choose one of the listed times.';
  const [info] = await availability(day, day, now);
  if (info.status === 'closed') return 'The X-ray room is closed that day.';
  const slot = info.slots.find((s) => s.time === time);
  if (slot.status === 'past') return 'That time has already passed.';
  if (urgent) return '';
  if (info.booked >= DAILY_QUOTA) return `The daily quota of ${DAILY_QUOTA} X-rays is full for ${day}.`;
  if (slot.status === 'full') return `${time} on ${day} is fully booked.`;
  return '';
}

// After saving, keep only bookings that fit; a later racer for the last place
// loses. Returns a message when `caseId` did not fit.
async function overbooked(caseId, day, time) {
  const rows = await Case.find(
    { ...OWNED, scheduledAt: { $gte: slotInstant(day, '00:00'), $lt: slotInstant(addDays(day, 1), '00:00') } },
    { caseId: 1, scheduledAt: 1, urgent: 1 }
  ).sort({ _id: 1 }).lean();
  const self = rows.find((r) => r.caseId === caseId);
  if (self?.urgent) return '';
  const routine = rows.filter((r) => !r.urgent);
  const dayIndex = routine.findIndex((r) => r.caseId === caseId);
  if (dayIndex >= DAILY_QUOTA) return `The daily quota of ${DAILY_QUOTA} X-rays is full for ${day}.`;
  const sameSlot = routine.filter((r) => localParts(r.scheduledAt).time === time);
  if (sameSlot.findIndex((r) => r.caseId === caseId) >= SLOT_CAPACITY) return `${time} on ${day} was just taken. Choose another time.`;
  return '';
}

module.exports = {
  SLOT_CAPACITY,
  DAILY_QUOTA,
  SLOT_MINUTES,
  SLOT_TIMES,
  UTC_OFFSET,
  slotInstant,
  localParts,
  availability,
  slotProblem,
  overbooked,
};
