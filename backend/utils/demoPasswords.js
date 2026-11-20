// utils/demoPasswords.js
// The passwords for the seeded demo accounts come from the environment
// (backend/.env), never from the source code.
//
//   SEED_ADMIN_PASSWORD   SEED_TECH_PASSWORD   SEED_PRIYA_PASSWORD
//   SEED_MARCUS_PASSWORD  SEED_DOCTOR_PASSWORD
//
// backend/.env.example lists them with a placeholder. The placeholder itself
// is refused, so a copied-but-unedited file cannot create accounts with a
// password that is published in the repository.

const PLACEHOLDER = 'CHANGE_ME';
const MIN_LENGTH = 6; // the User model's minimum

const DEMO_ACCOUNTS = [
  { username: 'admin', env: 'SEED_ADMIN_PASSWORD' },
  { username: 'tech', env: 'SEED_TECH_PASSWORD' },
  { username: 'priya', env: 'SEED_PRIYA_PASSWORD' },
  { username: 'marcus', env: 'SEED_MARCUS_PASSWORD' },
  { username: 'doctor', env: 'SEED_DOCTOR_PASSWORD' },
];

// { passwords: { admin: '...', ... }, problems: ['SEED_X_PASSWORD is not set', ...] }
function readDemoPasswords(env = process.env) {
  const passwords = {};
  const problems = [];
  for (const { username, env: name } of DEMO_ACCOUNTS) {
    const value = String(env[name] ?? '').trim();
    if (!value) problems.push(`${name} is not set`);
    else if (value === PLACEHOLDER) problems.push(`${name} is still the placeholder ${PLACEHOLDER}`);
    else if (value.length < MIN_LENGTH) problems.push(`${name} must be at least ${MIN_LENGTH} characters`);
    else passwords[username] = value;
  }
  return { passwords, problems };
}

// For the seed and reset scripts: stop before connecting to any database.
function requireDemoPasswords(env = process.env, { exit = process.exit, log = console.error } = {}) {
  const { passwords, problems } = readDemoPasswords(env);
  if (problems.length) {
    log([
      'Cannot set the demo account passwords:',
      ...problems.map((p) => `  - ${p}`),
      '',
      'Add them to backend/.env (see backend/.env.example). Nothing was changed.',
    ].join('\n'));
    exit(1);
  }
  return passwords;
}

module.exports = { DEMO_ACCOUNTS, PLACEHOLDER, MIN_LENGTH, readDemoPasswords, requireDemoPasswords };
