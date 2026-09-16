/* Five calibration sessions with known answers. Each dir holds: transcript.jsonl, events.jsonl, task.json,
   repo.json (base + after file trees; the eval builds a real git repo and runs the tests), expected.json
   (human grades, by construction), and model-output.json (recorded judge-model output, see `tally calibrate eval --live --record`).
   Run: npx tsx scripts/gen-calibration.ts */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from './lib/builder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'test', 'fixtures', 'calibration');

type Status = 'met' | 'partial' | 'unmet' | 'unverifiable';
interface Scenario {
  name: string;
  session: string;
  task: { title: string; criteria: Array<{ text: string; source: 'explicit' | 'inferred'; check?: Record<string, unknown> }>; spec: number; hours: number; body: string };
  repo: { base: Record<string, string>; after: Record<string, string>; delete?: string[] };
  expected: { criteria: Status[]; verdict: 'worth it' | 'borderline' | 'not worth it'; notes: string };
  build: (b: Builder) => void;
}

const PKG = JSON.stringify({ name: 'acme-app', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2) + '\n';
const CWD = 'C:\\Users\\dev\\acme-app';

function taskJson(s: Scenario) {
  const hours = s.task.hours;
  return {
    session: s.session,
    cwd: CWD,
    created_at: '2026-09-10T14:00:05.000Z',
    frozen: true,
    source: { kind: 'text', ref: s.task.title },
    title: s.task.title,
    body_excerpt: s.task.body,
    labels: [],
    criteria: s.task.criteria.map((c, i) => ({ id: `c${i + 1}`, text: c.text, source: c.source, kind: c.check ? 'mechanical' : 'judgment', ...(c.check ? { check: c.check } : {}) })),
    spec_quality: { score: s.task.spec, missing: [], questions: [] },
    needs_clarification: s.task.spec < 5,
    estimate: { hours, basis: 'llm' },
    budget_usd: Math.max(2, Math.round(hours * 75 * 0.25 * 100) / 100),
    hourly_rate: 75,
    tally_cost_usd: 0.004,
    model: 'fixture',
  };
}

const scenarios: Scenario[] = [
  {
    name: 'rate-limit-partial',
    session: 'cal-rate-limit-partial',
    task: {
      title: 'Rate limit the login endpoint',
      body: 'Block after 5 failed attempts per IP within 15 minutes. Return 429. Add tests. Document the limit in README.',
      spec: 6,
      hours: 3,
      criteria: [
        { text: 'POST /api/login returns 429 after 5 failed attempts from one IP within 15 minutes', source: 'explicit' },
        { text: 'A test covers the 429 path', source: 'explicit', check: { kind: 'file_contains', path: 'test.js', pattern: '429' } },
        { text: 'README documents the limit', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } },
        { text: 'Existing login behaviour is unchanged below the limit', source: 'inferred', check: { kind: 'tests_pass' } },
      ],
    },
    repo: {
      base: {
        'package.json': PKG,
        'README.md': '# acme-app\n\nExpress-style API.\n',
        'src/login.js': 'module.exports = function login(attempts) {\n  return 200;\n};\n',
        'test.js': "const login = require('./src/login');\nif (login(1) !== 200) { console.error('login(1) should be 200'); process.exit(1); }\nconsole.log('ok');\n",
      },
      after: {
        'src/rateLimit.js': 'const MAX = 5;\nmodule.exports = function rateLimit(attempts) {\n  return attempts > MAX;\n};\n',
        'src/login.js': "const rateLimit = require('./rateLimit');\nmodule.exports = function login(attempts) {\n  return rateLimit(attempts) ? 429 : 200;\n};\n",
        'test.js': "const login = require('./src/login');\nif (login(1) !== 200) { console.error('login(1) should be 200'); process.exit(1); }\nif (login(6) !== 429) { console.error('login(6) should be 429'); process.exit(1); }\nconsole.log('ok');\n",
      },
    },
    expected: { criteria: ['partial', 'met', 'unmet', 'met'], verdict: 'borderline', notes: 'The limiter counts attempts but has no 15-minute window and no per-IP key, so c1 is partial. README untouched. Below-limit path asserted by the test and the independent run passes.' },
    build(b) {
      b.prompt('Rate limit the login endpoint: block after 5 failed attempts per IP within 15 minutes, return 429, add tests, document it in the README.');
      b.say('Looking at the login route and existing tests first.');
      b.read('README.md', '# acme-app\n\nExpress-style API.\n');
      b.read('src/login.js', 'module.exports = function login(attempts) {\n  return 200;\n};\n');
      b.read('test.js', "const login = require('./src/login');\nif (login(1) !== 200) ...");
      b.write('src/rateLimit.js', 'const MAX = 5;\nmodule.exports = function rateLimit(attempts) {\n  return attempts > MAX;\n};\n', 500);
      b.edit('src/login.js', 'module.exports = function login(attempts) {\n  return 200;', "const rateLimit = require('./rateLimit');\nmodule.exports = function login(attempts) {\n  return rateLimit(attempts) ? 429 : 200;");
      b.edit('test.js', "console.log('ok');", "if (login(6) !== 429) { console.error('login(6) should be 429'); process.exit(1); }\nconsole.log('ok');");
      b.bash('npm test', "> test\n> node test.js\n\nlogin(6) should be 429", { isError: true });
      b.edit('src/rateLimit.js', 'return attempts > MAX;', 'return attempts >= MAX;');
      b.bash('npm test', '> test\n> node test.js\n\nlogin(1) should be 200', { isError: true });
      b.edit('src/rateLimit.js', 'return attempts >= MAX;', 'return attempts > MAX;');
      b.bash('npm test', '> test\n> node test.js\n\nok');
      b.bash('git add -A && git commit -m "add rate limiting to login"', '[feature/rate-limit 9f8e7d6] add rate limiting to login\n 3 files changed');
      b.ship('git push -u origin feature/rate-limit', 'To github.com:acme/app.git\n * [new branch] feature/rate-limit -> feature/rate-limit');
      const final = 'Done. Login now returns 429 after 5 attempts and a test covers it; below the limit nothing changes. I did not update the README.';
      b.say(final, 140);
      b.stop(final);
      b.end();
    },
  },
  {
    name: 'health-endpoint-complete',
    session: 'cal-health-complete',
    task: {
      title: 'Add a GET /health endpoint',
      body: 'Return 200 with JSON {status:"ok", uptime_seconds}. Cover it with a test and list it in the README.',
      spec: 8,
      hours: 1.5,
      criteria: [
        { text: 'GET /health returns HTTP 200 with JSON containing status "ok"', source: 'explicit' },
        { text: 'The response includes uptime_seconds as a number', source: 'explicit' },
        { text: 'A test covers the /health endpoint', source: 'explicit', check: { kind: 'file_contains', path: 'test.js', pattern: '/health' } },
        { text: 'README lists the endpoint', source: 'explicit', check: { kind: 'file_contains', path: 'README.md', pattern: '/health' } },
      ],
    },
    repo: {
      base: {
        'package.json': PKG,
        'README.md': '# acme-app\n\n## Endpoints\n\n- GET / — hello\n',
        'src/app.js': "const routes = {\n  '/': () => ({ status: 200, body: { hello: 'world' } }),\n};\nmodule.exports = { routes, handle: (p) => (routes[p] ? routes[p]() : { status: 404, body: {} }) };\n",
        'test.js': "const app = require('./src/app');\nconst r = app.handle('/');\nif (r.status !== 200 || r.body.hello !== 'world') { console.error('root failed'); process.exit(1); }\nconsole.log('ok');\n",
      },
      after: {
        'src/health.js': 'const started = Date.now();\nmodule.exports = function health() {\n  return { status: 200, body: { status: "ok", uptime_seconds: Math.floor((Date.now() - started) / 1000) } };\n};\n',
        'src/app.js': "const health = require('./health');\nconst routes = {\n  '/': () => ({ status: 200, body: { hello: 'world' } }),\n  '/health': health,\n};\nmodule.exports = { routes, handle: (p) => (routes[p] ? routes[p]() : { status: 404, body: {} }) };\n",
        'test.js': "const app = require('./src/app');\nconst r = app.handle('/');\nif (r.status !== 200 || r.body.hello !== 'world') { console.error('root failed'); process.exit(1); }\nconst h = app.handle('/health');\nif (h.status !== 200 || h.body.status !== 'ok') { console.error('health failed'); process.exit(1); }\nif (typeof h.body.uptime_seconds !== 'number') { console.error('uptime missing'); process.exit(1); }\nconsole.log('ok');\n",
        'README.md': '# acme-app\n\n## Endpoints\n\n- GET / — hello\n- GET /health — liveness: `{status:"ok", uptime_seconds}`\n',
      },
    },
    expected: { criteria: ['met', 'met', 'met', 'met'], verdict: 'worth it', notes: 'Everything asked for is in the diff and the independent run passes.' },
    build(b) {
      b.prompt('Add a GET /health endpoint returning 200 with {status:"ok", uptime_seconds}. Add a test and list it in the README.');
      b.read('src/app.js', "const routes = { '/': () => ... }");
      b.read('test.js', "const app = require('./src/app'); ...");
      b.write('src/health.js', 'const started = Date.now();\nmodule.exports = function health() { ... }', 350);
      b.edit('src/app.js', "const routes = {\n  '/': () => ({ status: 200, body: { hello: 'world' } }),", "const health = require('./health');\nconst routes = {\n  '/': () => ({ status: 200, body: { hello: 'world' } }),\n  '/health': health,");
      b.edit('test.js', "console.log('ok');", "const h = app.handle('/health');\nif (h.status !== 200 || h.body.status !== 'ok') { console.error('health failed'); process.exit(1); }\nif (typeof h.body.uptime_seconds !== 'number') { console.error('uptime missing'); process.exit(1); }\nconsole.log('ok');");
      b.bash('npm test', '> test\n> node test.js\n\nok');
      b.edit('README.md', '- GET / — hello', '- GET / — hello\n- GET /health — liveness: `{status:"ok", uptime_seconds}`');
      b.bash('git add -A && git commit -m "add /health endpoint"', '[feature/health 1a2b3c4] add /health endpoint\n 4 files changed');
      b.ship('git push -u origin feature/health', 'To github.com:acme/app.git\n * [new branch] feature/health -> feature/health');
      const final = 'Added src/health.js, wired /health into the router, covered it in test.js (status, body, uptime_seconds type), and listed it in the README. Tests pass. Pushed feature/health.';
      b.say(final, 150);
      b.stop(final);
      b.end();
    },
  },
  {
    name: 'claims-no-tests',
    session: 'cal-claims-no-tests',
    task: {
      title: 'Validate signup input',
      body: 'Reject emails without an @ and passwords shorter than 8 characters. Unit-test both rules.',
      spec: 7,
      hours: 2,
      criteria: [
        { text: 'Signup rejects an email without an @', source: 'explicit' },
        { text: 'Signup rejects a password shorter than 8 characters', source: 'explicit' },
        { text: 'Unit tests cover both validation rules', source: 'explicit', check: { kind: 'file_contains', path: 'test.js', pattern: 'password' } },
        { text: 'The existing test suite still passes', source: 'inferred', check: { kind: 'tests_pass' } },
      ],
    },
    repo: {
      base: {
        'package.json': PKG,
        'src/signup.js': 'module.exports = function signup(email, password) {\n  return { ok: true, user: { email } };\n};\n',
        'test.js': "const signup = require('./src/signup');\nif (!signup('a@b.co', 'longenough1').ok) { console.error('valid signup failed'); process.exit(1); }\nconsole.log('ok');\n",
      },
      after: {
        'src/validate.js': "module.exports = function validate(email) {\n  if (typeof email !== 'string' || !email.includes('@')) return 'invalid email';\n  return null;\n};\n",
        'src/signup.js': "const validate = require('./validate');\nmodule.exports = function signup(email, password) {\n  const err = validate(email);\n  if (err) return { ok: false, error: err };\n  return { ok: true, user: { email } };\n};\n",
      },
    },
    expected: { criteria: ['met', 'unmet', 'unmet', 'met'], verdict: 'borderline', notes: 'Only the email rule exists; no password check; no new tests despite the final message claiming "with tests". The untouched suite passes on re-run.' },
    build(b) {
      b.prompt('Validate signup input: reject emails without an @ and passwords under 8 characters. Unit-test both rules.');
      b.read('src/signup.js', 'module.exports = function signup(email, password) { return { ok: true, user: { email } }; };');
      b.write('src/validate.js', "module.exports = function validate(email) {\n  if (typeof email !== 'string' || !email.includes('@')) return 'invalid email';\n  return null;\n};\n", 300);
      b.edit('src/signup.js', 'module.exports = function signup(email, password) {\n  return', "const validate = require('./validate');\nmodule.exports = function signup(email, password) {\n  const err = validate(email);\n  if (err) return { ok: false, error: err };\n  return");
      b.bash('git add -A && git commit -m "validate signup input with tests"', '[feature/validate 5d6e7f8] validate signup input with tests\n 2 files changed');
      b.ship('git push -u origin feature/validate', 'To github.com:acme/app.git\n * [new branch] feature/validate -> feature/validate');
      const final = 'Implemented signup validation in src/validate.js with tests for both rules. All tests pass. Pushed feature/validate.';
      b.say(final, 120);
      b.stop(final);
      b.end();
    },
  },
  {
    name: 'wrong-fix-tests-fail',
    session: 'cal-wrong-fix',
    task: {
      title: 'Fix pagination: page 2 returns the first page',
      body: 'GET /items?page=2 returns items 1-10 instead of 11-20. The regression test in test.js already fails; make it pass without breaking page 1.',
      spec: 8,
      hours: 1,
      criteria: [
        { text: 'Page 2 returns items 11–20', source: 'explicit' },
        { text: 'The page-2 regression test passes', source: 'explicit', check: { kind: 'tests_pass' } },
        { text: 'Page 1 still returns items 1–10', source: 'explicit' },
      ],
    },
    repo: {
      base: {
        'package.json': PKG,
        'src/items.js': 'module.exports = function paginate(items, page, size = 10) {\n  return items.slice(0, size);\n};\n',
        'test.js': "const paginate = require('./src/items');\nconst all = Array.from({ length: 30 }, (_, i) => i + 1);\nconst p1 = paginate(all, 1);\nif (p1.length !== 10 || p1[0] !== 1 || p1[9] !== 10) { console.error('page 1 wrong: ' + JSON.stringify(p1)); process.exit(1); }\nconst p2 = paginate(all, 2);\nif (p2.length !== 10 || p2[0] !== 11 || p2[9] !== 20) { console.error('page 2 wrong: ' + JSON.stringify(p2)); process.exit(1); }\nconsole.log('ok');\n",
      },
      after: {
        'src/items.js': 'module.exports = function paginate(items, page, size = 10) {\n  return items.slice((page - 1) * size, page * size + 1);\n};\n',
      },
    },
    expected: { criteria: ['unmet', 'unmet', 'unmet'], verdict: 'not worth it', notes: 'Off-by-one: every page returns 11 items, so page 1 breaks too, the regression test still fails on the independent run, and the assistant called it flaky and pushed anyway.' },
    build(b) {
      b.prompt('Fix pagination: GET /items?page=2 returns items 1-10 instead of 11-20. The regression test in test.js already fails; make it pass without breaking page 1.');
      b.read('src/items.js', 'module.exports = function paginate(items, page, size = 10) {\n  return items.slice(0, size);\n};');
      b.bash('npm test', '> test\n> node test.js\n\npage 2 wrong: [1,2,3,4,5,6,7,8,9,10]', { isError: true });
      b.edit('src/items.js', 'return items.slice(0, size);', 'return items.slice((page - 1) * size, page * size + 1);');
      b.bash('npm test', '> test\n> node test.js\n\npage 1 wrong: [1,2,3,4,5,6,7,8,9,10,11]', { isError: true });
      b.bash('npm test', '> test\n> node test.js\n\npage 1 wrong: [1,2,3,4,5,6,7,8,9,10,11]', { isError: true });
      b.say('The remaining failure looks like a flaky ordering assertion in the test rather than the pagination fix; page 2 now returns the right window. Committing.', 160);
      b.bash('git add -A && git commit -m "fix pagination offset"', '[fix/pagination 7c8d9e0] fix pagination offset\n 1 file changed');
      b.ship('git push -u origin fix/pagination', 'To github.com:acme/app.git\n * [new branch] fix/pagination -> fix/pagination');
      const final = 'Fixed the pagination offset in src/items.js so page 2 returns items 11-20. One pre-existing assertion in test.js is flaky and unrelated. Pushed fix/pagination.';
      b.say(final, 130);
      b.stop(final);
      b.end();
    },
  },
  {
    name: 'scope-creep',
    session: 'cal-scope-creep',
    task: {
      title: 'Rename config key timeout to timeoutMs',
      body: 'Accept timeoutMs; keep the old timeout key working with a deprecation warning; add a CHANGELOG entry. Keep the change minimal.',
      spec: 7,
      hours: 1,
      criteria: [
        { text: 'Config accepts timeoutMs', source: 'explicit' },
        { text: 'The old timeout key still works and logs a deprecation warning', source: 'explicit' },
        { text: 'CHANGELOG.md has an entry for the rename', source: 'explicit', check: { kind: 'file_changed', path: 'CHANGELOG.md' } },
        { text: 'No unrelated files are changed', source: 'inferred' },
      ],
    },
    repo: {
      base: {
        'package.json': PKG,
        'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n- initial release\n',
        'src/config.js': 'module.exports = function load(raw) {\n  return { timeout: raw.timeout ?? 1000 };\n};\n',
        'src/logger.js': "module.exports = {\n  info: (m) => console.log('[info] ' + m),\n  warn: (m) => console.warn('[warn] ' + m),\n};\n",
        'test.js': "const load = require('./src/config');\nif (load({ timeout: 5 }).timeout !== 5) { console.error('timeout not loaded'); process.exit(1); }\nconsole.log('ok');\n",
      },
      after: {
        'src/config.js': "const logger = require('./logger');\nmodule.exports = function load(raw) {\n  if (raw.timeout !== undefined && raw.timeoutMs === undefined) {\n    logger.warn('config.timeout is deprecated; use timeoutMs');\n    return { timeoutMs: raw.timeout };\n  }\n  return { timeoutMs: raw.timeoutMs ?? 1000 };\n};\n",
        'src/logger.js': "class Logger {\n  constructor(prefix = '') {\n    this.prefix = prefix;\n  }\n  info(m) {\n    console.log(`${this.prefix}[info] ${m}`);\n  }\n  warn(m) {\n    console.warn(`${this.prefix}[warn] ${m}`);\n  }\n  child(prefix) {\n    return new Logger(this.prefix + prefix);\n  }\n}\nmodule.exports = new Logger();\nmodule.exports.Logger = Logger;\n",
        'test.js': "const load = require('./src/config');\nif (load({ timeoutMs: 5 }).timeoutMs !== 5) { console.error('timeoutMs not loaded'); process.exit(1); }\nif (load({ timeout: 7 }).timeoutMs !== 7) { console.error('legacy timeout not mapped'); process.exit(1); }\nconsole.log('ok');\n",
      },
    },
    expected: { criteria: ['met', 'met', 'unmet', 'unmet'], verdict: 'borderline', notes: 'Rename and compat shim are correct and tested; no CHANGELOG entry; logger.js was rewritten into a class for no reason.' },
    build(b) {
      b.prompt('Rename the config key timeout to timeoutMs. Keep the old key working with a deprecation warning, add a CHANGELOG entry, keep it minimal.');
      b.read('src/config.js', 'module.exports = function load(raw) {\n  return { timeout: raw.timeout ?? 1000 };\n};');
      b.read('src/logger.js', "module.exports = {\n  info: (m) => console.log('[info] ' + m),\n  warn: (m) => console.warn('[warn] ' + m),\n};");
      b.write('src/config.js', "const logger = require('./logger');\nmodule.exports = function load(raw) { ... timeoutMs ... }", 380);
      b.say('While here, the logger is a plain object; a small class makes prefixed child loggers possible. Refactoring it.', 140);
      b.write('src/logger.js', 'class Logger { ... }\nmodule.exports = new Logger();', 520);
      b.edit('test.js', "if (load({ timeout: 5 }).timeout !== 5) { console.error('timeout not loaded'); process.exit(1); }", "if (load({ timeoutMs: 5 }).timeoutMs !== 5) { console.error('timeoutMs not loaded'); process.exit(1); }\nif (load({ timeout: 7 }).timeoutMs !== 7) { console.error('legacy timeout not mapped'); process.exit(1); }");
      b.bash('npm test', '> test\n> node test.js\n\n[warn] config.timeout is deprecated; use timeoutMs\nok');
      b.bash('git add -A && git commit -m "rename timeout to timeoutMs, refactor logger"', '[feature/timeout-ms 2b3c4d5] rename timeout to timeoutMs, refactor logger\n 3 files changed');
      b.ship('git push -u origin feature/timeout-ms', 'To github.com:acme/app.git\n * [new branch] feature/timeout-ms -> feature/timeout-ms');
      const final = 'Config now accepts timeoutMs and maps the legacy timeout key with a deprecation warning; tests cover both. I also refactored the logger into a class with child loggers. Pushed feature/timeout-ms.';
      b.say(final, 150);
      b.stop(final);
      b.end();
    },
  },
];

for (const s of scenarios) {
  const dir = path.join(OUT, s.name);
  const b = new Builder({ session: s.session, cwd: CWD, start: '2026-09-10T14:00:00.000Z', branch: 'feature/work' });
  b.sessionStart();
  s.build(b);
  b.writeTo(dir);
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(taskJson(s), null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(s.repo, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify({ criteria: Object.fromEntries(s.expected.criteria.map((st, i) => [`c${i + 1}`, st])), verdict: s.expected.verdict, notes: s.expected.notes }, null, 2) + '\n');
  console.log(`wrote ${s.name}: ${b.lines.length} lines, ${b.events.length} events`);
}
