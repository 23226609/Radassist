// models/CaseEmbedding.js
// One embedding vector per imported (MIMIC) case, kept so search_similar_cases
// embeds each official report only once. `textHash` changes if the report text
// or the embedding model changes, and the vector is then made again.

const mongoose = require('mongoose');

const caseEmbeddingSchema = new mongoose.Schema(
  {
    caseId: { type: String, required: true, trim: true },
    model: { type: String, required: true },
    textHash: { type: String, required: true },
    vector: { type: [Number], required: true },
  },
  { timestamps: true }
);

caseEmbeddingSchema.index({ caseId: 1, model: 1 }, { unique: true });

module.exports = mongoose.model('CaseEmbedding', caseEmbeddingSchema);
