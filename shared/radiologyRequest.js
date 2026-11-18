// A chest X-ray request, the room the booking assigns, and the arrival check.
// No DOM. The booking page and the API use the same words.

export const EXAMINATION = "Chest X-ray";
export const BODY_PART = "Chest";

// The demonstration department has one radiographer on duty and two chest rooms.
export const RADIOGRAPHER = "Jamie Lee";

export const ROOMS = [
  { room: "XR-1", equipment: "Digital radiography unit A" },
  { room: "XR-2", equipment: "Digital radiography unit B" },
];

export function preparationFor(urgent) {
  if (urgent) {
    return "Urgent. Keep oxygen and lines in place. Use an AP film if the patient cannot stand.";
  }
  return "Remove metal from the chest. PA film if the patient can stand.";
}

// index is how many open bookings already share this time. They alternate rooms.
export function arrangementFor(index, urgent) {
  const spot = ROOMS[Math.abs(Number(index) || 0) % ROOMS.length];
  return {
    examination: EXAMINATION,
    bodyPart: BODY_PART,
    equipment: spot.equipment,
    examRoom: spot.room,
    assignedStaff: RADIOGRAPHER,
    preparation: preparationFor(urgent),
  };
}

export const ARRIVAL_CHECKS = [
  { key: "identity", label: "Patient identity" },
  { key: "patientNumber", label: "Patient number" },
  { key: "request", label: "Examination request" },
  { key: "bodyPart", label: "Body part" },
  { key: "appointment", label: "Appointment" },
];

// A demonstration identity document number. The same patient always gets the
// same number. It is not a real identity document.
export function identityNumberFor(patientId) {
  const text = String(patientId || "demo");
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619) >>> 0;
  const letter = "ABCDEFGHJKLMNPQRSTUVWXYZ"[n % 24];
  const digits = String(n % 1000000).padStart(6, "0");
  const check = "0123456789A"[n % 11];
  return `${letter}${digits}(${check})`;
}

export function arrivalComplete(arrival) {
  return ARRIVAL_CHECKS.every((item) => arrival?.[item.key] === true);
}
