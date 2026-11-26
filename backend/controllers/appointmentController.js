// A patient's own X-ray appointments: the cases that were booked into a time slot (scheduledAt) for this
// patient. Allow-list only: the date, time, view and a plain status. No case ID, reason, history, staff,
// room, report or AI output.

const Case = require('../models/Case');
const catchAsync = require('../utils/catchAsync');
const xraySlots = require('../utils/xraySlots');

const { OWNED } = Case;

// booked: the request is open. checked in: the radiographer has checked the patient in.
// completed: the film has been taken, whatever happens to the report afterwards.
function appointmentStatus(c) {
  if (c.status === 'requested') return c.arrival?.at ? 'checked in' : 'booked';
  return 'completed';
}

function toPatientAppointment(c) {
  const { day, time } = xraySlots.localParts(c.scheduledAt);
  return {
    scheduledAt: c.scheduledAt,
    date: day.replace(/-/g, '/'),
    time,
    view: c.view || '',
    status: appointmentStatus(c),
  };
}

const listMine = catchAsync(async (req, res) => {
  const patientId = String(req.user.patientId || '').trim();
  const docs = patientId
    ? await Case.find({ ...OWNED, patientId, scheduledAt: { $ne: null } }).select('scheduledAt view status arrival').lean()
    : [];
  // Cosmos DB can't be trusted to sort here, so sort in memory: newest first.
  const rows = docs
    .filter((c) => c.scheduledAt && !Number.isNaN(new Date(c.scheduledAt).getTime()))
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt))
    .map(toPatientAppointment);
  res.json({ success: true, total: rows.length, appointments: rows });
});

module.exports = { listMine, appointmentStatus, toPatientAppointment };
