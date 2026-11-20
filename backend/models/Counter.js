// models/Counter.js
// One document per named sequence, e.g. { _id: 'patient-2026', seq: 85 }.
// It is advanced with a single atomic $inc, so two requests never get the
// same number.

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Counter', counterSchema);
