// models/Patient.js
// Demographics and clinician notes for a patient. Studies still live on Case.

const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    patientId: { type: String, required: true, unique: true, trim: true, index: true },
    firstName: { type: String, default: '', trim: true },
    middleName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
    age: { type: String, default: '' },
    sex: { type: String, enum: ['Female', 'Male', 'Other', ''], default: '' },
    history: { type: String, default: '' },
    medicines: { type: String, default: '' },
    heartRate: { type: String, default: '' },
    labResults: { type: String, default: '' },
    ward: { type: String, default: '' },
    bed: { type: String, default: '' },
    admissionStatus: { type: String, enum: ['', 'reserved', 'admitted', 'discharged'], default: '' },
    observations: { type: [mongoose.Schema.Types.Mixed], default: [] },
    labOrders: { type: [mongoose.Schema.Types.Mixed], default: [] },
    medOrders: { type: [mongoose.Schema.Types.Mixed], default: [] },
    careNotes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Clinician notes about the person. Never copied into a case report.
    remarks: { type: String, default: '' },
  },
  { timestamps: true }
);

patientSchema.index({ updatedAt: 1 });

module.exports = mongoose.model('Patient', patientSchema);
