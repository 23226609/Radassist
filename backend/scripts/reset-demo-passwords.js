// Reset the seeded demo accounts' passwords to the SEED_*_PASSWORD values in
// backend/.env (see backend/.env.example). Stops, changing nothing, if one is missing.
//
//   cd backend && node scripts/reset-demo-passwords.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const connectDB = require('../config/db');
const User = require('../models/User');
const { requireDemoPasswords } = require('../utils/demoPasswords');

const seeded = requireDemoPasswords();
// A leftover "nurse" account is the technician under its old name.
const DEMO_PASSWORDS = { ...seeded, nurse: seeded.tech };

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
