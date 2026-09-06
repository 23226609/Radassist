// models/User.js
// Mirrors the example's User schema (userId / username / password / role / etc).

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLES = ['doctor', 'nurse', 'admin'];

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true,
      match: [/^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/, 'Please provide a valid email'] },
    role: { type: String, required: true, enum: ROLES, default: 'doctor' },
    department: { type: String, default: 'Radiology', trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  return obj;
};

userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
