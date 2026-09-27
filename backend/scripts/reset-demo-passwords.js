// Reset seeded demo passwords to the values shown on the login screen.
//
//   cd backend && node scripts/reset-demo-passwords.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const connectDB = require('../config/db');
const User = require('../models/User');

const DEMO_PASSWORDS = {
  admin: 'admin123',
  tech: 'tech123',
  nurse: 'tech123',
  priya: 'priya123',
  marcus: 'marcus123',
  doctor: 'doctor123',
};

(async () => {
  await connectDB();
  for (const [username, password] of Object.entries(DEMO_PASSWORDS)) {
    const user = await User.findOne({ username });
    if (!user) {
      console.log(`  · ${username} not found`);
      continue;
    }
    user.password = password;
    await user.save();
    const ok = await user.comparePassword(password);
    console.log(`  ${ok ? '✓' : '✗'} ${username} (${user.role})`);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
