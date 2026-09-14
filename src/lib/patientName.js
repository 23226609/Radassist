// Split / join a patient name: first + optional middle + last.

export function parseFullName(full) {
  const bits = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!bits.length) return { firstName: "", middleName: "", lastName: "" };
  if (bits.length === 1) return { firstName: bits[0], middleName: "", lastName: "" };
  if (bits.length === 2) return { firstName: bits[0], middleName: "", lastName: bits[1] };
  return {
    firstName: bits[0],
    middleName: bits.slice(1, -1).join(" "),
    lastName: bits[bits.length - 1],
  };
}

export function composePatientName(p = {}) {
  const firstName = String(p.firstName || "").trim();
  const middleName = String(p.middleName || "").trim();
  const lastName = String(p.lastName || "").trim();
  return [firstName, middleName, lastName].filter(Boolean).join(" ")
    || String(p.patientName || p.name || "").trim();
}

export function nameFieldsFrom(input = {}) {
  let firstName = String(input.firstName || "").trim();
  let middleName = String(input.middleName || "").trim();
  let lastName = String(input.lastName || "").trim();
  if (!firstName && !lastName) {
    const parsed = parseFullName(input.name || input.patientName);
    firstName = parsed.firstName;
    middleName = parsed.middleName;
    lastName = parsed.lastName;
  }
  const name = composePatientName({
    firstName,
    middleName,
    lastName,
    name: input.name,
    patientName: input.patientName,
  });
  return { firstName, middleName, lastName, name };
}

export function tidyNamePart(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

