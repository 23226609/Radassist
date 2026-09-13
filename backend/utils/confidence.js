// utils/confidence.js
//
// The model is a poor judge of its own certainty — asked for a 0-1 score it
// returns 1.0 on every card. We compute the number ourselves from two
// things a clinician can check:
//
//   1. Report wording. Hedges ("possible", "cannot exclude") pull the score
//      down; definite negatives ("no evidence", "within normal limits") and
//      explicit positives ("there is a 2 cm opacity") pull it up.
//   2. Image support, when Azure actually looked at the film. We still do
//      not trust a raw 1.0 from the model: routine "normal" statements are
//      capped, and the language score keeps the final number honest.
//
// The review-page threshold slider filters on this combined value.

const HEDGES = [
  /cannot\s+be\s+excluded/,
  /cannot\s+exclude/,
  /cannot\s+rule\s+out/,
  /if\s+clinically/,
  /further\s+evaluation/,
  /suggestive\s+of/,
  /questionable/,
  /equivocal/,
  /indeterminate/,
  /suboptimal/,
  /limited\s+(study|exam|inspiration|view)/,
  /possible(?:ly)?/,
  /probable/,
  /\blikely\b/,
  /\bsubtle\b/,
  /\bfaint\b/,
  /ill-?defined/,
  /poorly\s+defined/,
  /appears?\s+to/,
  /seemingly/,
  /\bsuspect/,
  /\bmay\b/,
  /\bmight\b/,
  /\bcould\b/,
];

const CERTAIN = [
  /no evidence/,
  /no sign of/,
  /no focal/,
  /no acute/,
  /within normal limits/,
  /unremarkable/,
  /clear(?:ly)?\b/,
  /\bdemonstrat/,
  /\bdefinite/,
  /there is (?:a|an)\b/,
  /measures?\s+\d/,
  /documented/,
];

function clamp01(value, fallback = 0.6) {
  let n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) n /= 100;
  return Math.min(1, Math.max(0, n));
}

function scoreLanguage(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 0.5;
  let score = 0.62;
  let hedges = 0;
  for (const re of HEDGES) {
    if (re.test(t)) hedges += 1;
  }
  // Two hedges are enough to mark the statement as uncertain; extra hits
  // (e.g. "may" inside "maybe") should not drive the score to zero.
  score -= Math.min(hedges, 2) * 0.14;
  for (const re of CERTAIN) {
    if (re.test(t)) score += 0.08;
  }
  return Math.min(0.9, Math.max(0.28, score));
}

/**
 * @param {object} input
 * @param {string} [input.label]
 * @param {string} [input.detail]
 * @param {string} [input.severity]
 * @param {number|null} [input.imageSupport] 0-1 from Azure's look at the film
 * @param {string} [input.size]
 * @param {string} [input.location]
 */
function scoreConfidence(input = {}) {
  const label = String(input.label || '');
  const detail = String(input.detail || input.sentence || '');
  const language = scoreLanguage(`${label} ${detail}`);
  const hasImage = input.imageSupport != null && input.imageSupport !== '';
  let image = hasImage ? clamp01(input.imageSupport, 0.55) : null;

  // A "normal study" is never a 100% visual call on a 3B/mini model.
  if (image != null && input.severity === 'normal') {
    image = Math.min(image, 0.82);
  }

  let extra = 0;
  if (String(input.size || '').trim()) extra += 0.05;
  if (String(input.location || '').trim() && !/^(both|bilateral|n\/?a|)$/i.test(String(input.location).trim())) {
    extra += 0.03;
  }

  const combined = hasImage
    ? language * 0.5 + image * 0.4 + extra
    : language * 0.9 + extra;

  return {
    confidence: Number(Math.min(0.94, Math.max(0.25, combined)).toFixed(2)),
    languageScore: Number(language.toFixed(2)),
    imageSupport: image == null ? null : Number(image.toFixed(2)),
    confidenceSource: 'calibrated',
  };
}

function confidenceHint(finding) {
  const parts = [];
  if (finding?.languageScore != null) {
    parts.push(`report wording ${Math.round(finding.languageScore * 100)}%`);
  }
  if (finding?.imageSupport != null) {
    parts.push(`image ${Math.round(finding.imageSupport * 100)}%`);
  }
  if (!parts.length) return '';
  return `Confidence from ${parts.join(' + ')}`;
}

module.exports = {
  scoreLanguage,
  scoreConfidence,
  clamp01,
  confidenceHint,
};
