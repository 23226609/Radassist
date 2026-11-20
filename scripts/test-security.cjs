// scripts/test-security.cjs
//
// Demo passwords come from the environment, not the source code:
//   - the helper that reads and checks them,
//   - the seed and reset scripts stop before touching a database without them,
//   - backend/.env.example holds placeholders only,
//   - no tracked file carries a demo password (one known exception, listed below).
//
// No database is used. The two scripts are run with every SEED_* variable
// emptied and MONGODB_URI pointed at a dead local port, so even a mistake here
// could not reach the development database.
//
//   node scripts/test-security.cjs

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const { DEMO_ACCOUNTS, PLACEHOLDER, readDemoPasswords, requireDemoPasswords } = require(path.join(BACKEND, 'utils', 'demoPasswords'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

const goodEnv = () => Object.fromEntries(DEMO_ACCOUNTS.map((a, i) => [a.env, `pw-${a.username}-${i}-x`]));

console.log('\n=== reading the demo passwords ===');

test('five demo accounts, each with its own SEED_*_PASSWORD variable', () => {
  assert.deepStrictEqual(DEMO_ACCOUNTS.map((a) => a.username), ['admin', 'tech', 'priya', 'marcus', 'doctor']);
  assert.deepStrictEqual(DEMO_ACCOUNTS.map((a) => a.env), [
    'SEED_ADMIN_PASSWORD', 'SEED_TECH_PASSWORD', 'SEED_PRIYA_PASSWORD', 'SEED_MARCUS_PASSWORD', 'SEED_DOCTOR_PASSWORD',
  ]);
});

test('with all five set, each account gets its own value and there are no problems', () => {
  const env = goodEnv();
  const { passwords, problems } = readDemoPasswords(env);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(passwords.admin, env.SEED_ADMIN_PASSWORD);
  assert.strictEqual(passwords.doctor, env.SEED_DOCTOR_PASSWORD);
  assert.strictEqual(new Set(Object.values(passwords)).size, 5);
});

test('a missing, blank, placeholder or too-short value is named in the problems', () => {
  const env = goodEnv();
  delete env.SEED_ADMIN_PASSWORD;
  env.SEED_TECH_PASSWORD = '   ';
  env.SEED_PRIYA_PASSWORD = PLACEHOLDER;
  env.SEED_MARCUS_PASSWORD = 'abc';
  const { passwords, problems } = readDemoPasswords(env);
  assert.strictEqual(problems.length, 4);
  assert.ok(problems.some((p) => p.startsWith('SEED_ADMIN_PASSWORD') && /not set/.test(p)));
  assert.ok(problems.some((p) => p.startsWith('SEED_TECH_PASSWORD') && /not set/.test(p)));
  assert.ok(problems.some((p) => p.startsWith('SEED_PRIYA_PASSWORD') && /placeholder/.test(p)));
  assert.ok(problems.some((p) => p.startsWith('SEED_MARCUS_PASSWORD') && /at least/.test(p)));
  assert.deepStrictEqual(Object.keys(passwords), ['doctor']);
});

test('requireDemoPasswords exits with 1 and a clear message when one is missing', () => {
  const env = goodEnv();
  delete env.SEED_DOCTOR_PASSWORD;
  let code = null;
  let message = '';
  requireDemoPasswords(env, { exit: (c) => { code = c; }, log: (m) => { message = m; } });
  assert.strictEqual(code, 1);
  assert.ok(message.includes('SEED_DOCTOR_PASSWORD is not set'));
  assert.ok(message.includes('backend/.env.example'));
  assert.ok(message.includes('Nothing was changed'));
});

test('requireDemoPasswords does not exit when all five are fine', () => {
  let exited = false;
  const passwords = requireDemoPasswords(goodEnv(), { exit: () => { exited = true; }, log: () => {} });
  assert.strictEqual(exited, false);
  assert.strictEqual(Object.keys(passwords).length, 5);
});

console.log('\n=== the seed and reset scripts stop before any database ===');

function runScript(file) {
  const env = { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:1/never-used', MONGODB_DB: 'never-used' };
  for (const a of DEMO_ACCOUNTS) env[a.env] = ''; // present but empty, so backend/.env cannot fill them in
  return spawnSync(process.execPath, [path.join(BACKEND, 'scripts', file)], { env, encoding: 'utf8', timeout: 20000 });
}

for (const file of ['seed.js', 'reset-demo-passwords.js']) {
  test(`${file} without the passwords exits 1, names every missing one, and never connects`, () => {
    const run = runScript(file);
    assert.strictEqual(run.status, 1, `exit ${run.status}: ${run.stdout}${run.stderr}`);
    const out = `${run.stdout}${run.stderr}`;
    for (const a of DEMO_ACCOUNTS) assert.ok(out.includes(`${a.env} is not set`), `${a.env} not named`);
    assert.ok(out.includes('Nothing was changed'));
    assert.ok(!/MongoDB connected|connection error/i.test(out), 'it must stop before connecting');
  });
}

console.log('\n=== nothing in the repository carries a demo password ===');

// Files git tracks, plus new files it would not ignore.
const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .stdout.split('\n').filter(Boolean);
const textFiles = files.filter((f) => /\.(js|cjs|mjs|json|md|sh|py|html|example|env)$/i.test(f) || path.basename(f).startsWith('.env'))
  .filter((f) => !/package-lock\.json$/.test(f) && !f.startsWith('data/') && fs.existsSync(path.join(ROOT, f)));

// Built from parts so this file does not match its own scan.
const OLD_PASSWORDS = new RegExp(`\\b(?:${['tech', 'priya', 'marcus', 'doctor', 'admin', 'nurse'].join('|')})${'1'}${'2'}${'3'}\\b`, 'i');

// KNOWN OPEN ITEM, waiting for a decision: the login page's one-click demo
// buttons send these passwords from the browser, so removing them changes how
// the demo login works. Delete this line once that is decided.
const PENDING = new Set(['src/components/login.js']);

test('no tracked file contains an old demo password, apart from the one pending decision', () => {
  const hits = textFiles.filter((f) => !PENDING.has(f) && OLD_PASSWORDS.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(hits, [], `demo passwords still in: ${hits.join(', ')}`);
});

test('the pending exception is still the only one (this fails once it is fixed, so remove it)', () => {
  const stillThere = [...PENDING].filter((f) => OLD_PASSWORDS.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(stillThere, [...PENDING]);
});

test('backend/.env.example exists, is not ignored by git, and holds placeholders only', () => {
  const file = path.join(BACKEND, '.env.example');
  assert.ok(fs.existsSync(file), 'backend/.env.example is missing');
  assert.ok(files.includes('backend/.env.example'), 'git would ignore backend/.env.example');
  const values = Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
  );
  for (const a of DEMO_ACCOUNTS) assert.strictEqual(values[a.env], PLACEHOLDER, `${a.env} must be the placeholder`);
  for (const key of ['JWT_SECRET', 'MONGODB_URI']) assert.strictEqual(values[key], PLACEHOLDER, `${key} must be the placeholder`);
  for (const key of ['AZURE_OPENAI_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT']) assert.strictEqual(values[key], '', `${key} must be empty`);
  assert.ok(!/mongodb(\+srv)?:\/\/[^\s]*@/.test(fs.readFileSync(file, 'utf8')), 'no connection string with credentials');
});

test('backend/.env itself is ignored by git, so real values are never committed', () => {
  const ignored = spawnSync('git', ['check-ignore', '-q', 'backend/.env'], { cwd: ROOT });
  assert.strictEqual(ignored.status, 0, 'backend/.env must be in .gitignore');
});

test('the seed and reset scripts read the passwords from the helper', () => {
  for (const file of ['seed.js', 'reset-demo-passwords.js']) {
    const text = fs.readFileSync(path.join(BACKEND, 'scripts', file), 'utf8');
    assert.ok(text.includes("require('../utils/demoPasswords')"), `${file} must use utils/demoPasswords`);
    assert.ok(!/password:\s*'[^']+'/.test(text), `${file} must not set a literal password`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
