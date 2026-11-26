// models/AgentSetting.js
// Small key/value settings the agent keeps. Today there is one:
//   notifyReadyAt  when the email service was first seen ready (set at server start).
//
// notify only emails for a report endorsed on or after that moment, so turning the
// email service on never sends a catch-up email for an earlier endorsement.

const mongoose = require('mongoose');

const agentSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentSetting', agentSettingSchema);
