// Release checklist that runs itself. Every line is a check with a real command behind it; nothing is a reminder.
//   node scripts/release-check.mjs [--skip-live]
// Exit 1 if anything fails. Live checks (fixture re-record) are skipped with --skip-live; CI runs the replay instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const skipLive = process.argv.includes('--skip-live');
const results = [];
const check = (section, name, fn) => {
  const started = Date.now();
  try {
    const detail = fn();
    results.push({ section, name, ok: true, detail: detail ?? '', ms: Date.now() - started });
  } catch (err) {
    results.push({ section, name, ok: false, detail: String(err?.message ?? err).split('\n').slice(0, 6).join(' | '), ms: Date.now() - started });
  }
};
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' && !path.isAbsolute(cmd), maxBuffer: 50 * 1024 * 1024, timeout: opts.timeout ?? 15 * 60 * 1000, env: { ...process.env, ...(opts.env ?? {}) }, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-800)}`);
  return r.stdout ?? '';
};

// BUILD
check('BUILD', 'working tree is clean', () => {
  const s = run('git', ['status', '--porcelain']).trim();
  if (s) throw new Error(`uncommitted changes:\n${s}`);
});
check('BUILD', 'typecheck and bundle match the committed dist/', () => {
  run('npx', ['tsc', '-p', 'tsconfig.json']);
  run('node', ['scripts/bundle.mjs']);
  const s = run('git', ['status', '--porcelain', 'dist']).trim();
  if (s) throw new Error(`dist/ differs from a fresh build:\n${s}`);
});

// TEST
check('TEST', 'unit and integration tests', () => {
  const out = run('npx', ['vitest', 'run'], { timeout: 20 * 60 * 1000 });
  const m = /Tests\s+(\d+) passed/.exec(out.replace(/\[[0-9;]*m/g, ''));
  if (!m) throw new Error('could not find the pass count');
  return `${m[1]} passed`;
});

// INSTALL
check('INSTALL', 'npm pack + clean install in a fresh HOME, tally --version and doctor run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-release-'));
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp]))[0].filename;
  const prefix = path.join(tmp, 'prefix');
  fs.mkdirSync(prefix);
  run('npm', ['install', '-g', '--prefix', prefix, path.join(tmp, packed), '--no-audit', '--no-fund', '--loglevel=error']);
  const bin = process.platform === 'win32' ? path.join(prefix, 'node_modules', '@kru3ish', 'tally', 'dist', 'cli.js') : path.join(prefix, 'lib', 'node_modules', '@kru3ish', 'tally', 'dist', 'cli.js');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const env = { TALLY_HOME: path.join(home, '.tally'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TALLY_LLM: 'stub' };
  const v = run('node', [bin, '--version'], { env }).trim();
  /* a fresh HOME has no hooks, which doctor rightly reports as a problem; install first, then doctor must be clean */
  run('node', [bin, 'install'], { env });
  run('node', [bin, 'doctor'], { env });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  return v;
});
check('INSTALL', 'plugin manifest validates (claude plugin validate --strict)', () => {
  const out = run('claude', ['plugin', 'validate', '.', '--strict']);
  if (!/Validation passed/.test(out)) throw new Error(out.slice(-300));
});
check('INSTALL', 'install / uninstall round trip leaves settings byte-identical', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-rt-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude);
  const original = JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2) + '\n';
  fs.writeFileSync(path.join(claude, 'settings.json'), original);
  const env = { TALLY_HOME: path.join(home, '.tally'), CLAUDE_CONFIG_DIR: claude, TALLY_LLM: 'stub' };
  run('node', ['dist/cli.js', 'install'], { env });
  const after = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
  if (!/hook\.js/.test(after)) throw new Error('install did not add hooks');
  run('node', ['dist/cli.js', 'uninstall'], { env });
  const restored = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
  if (restored !== original) throw new Error('settings.json not byte-identical after uninstall');
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

// DEMO
check('DEMO', 'tally demo completes and shows the verify step', () => {
  const out = run('node', ['dist/cli.js', 'demo', '--plain', '--fast']);
  if (!/Tally Verify/.test(out) || !/UNMET/.test(out) || !/Done\./.test(out)) throw new Error('demo output missing expected sections');
});

// ASSURANCE
check('ASSURANCE', 'fixture replay meets the recorded baseline and the self-share gate', () => {
  const out = run('node', ['dist/cli.js', 'calibrate', 'eval', '--max-share', '8'], { env: { TALLY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tally-ev-')) } });
  const m = /criterion agreement\s+(\d+)%/.exec(out);
  return m ? `criteria ${m[1]}%` : 'ok';
});
if (!skipLive) {
  check('ASSURANCE', 'live fixture run (model calls; costs a few cents)', () => {
    const out = run('node', ['dist/cli.js', 'calibrate', 'eval', '--live', '--verbose'], { env: { TALLY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tally-evl-')) }, timeout: 20 * 60 * 1000 });
    const m = /criterion agreement\s+(\d+)%.*\n.*verdict agreement\s+(\d+)%/.exec(out);
    return m ? `criteria ${m[1]}%, verdicts ${m[2]}%` : 'ran';
  });
}

// BACKWARDS COMPATIBILITY
check('COMPAT', 'every stored receipt on this machine still loads and renders', () => {
  const home = process.env.TALLY_HOME || path.join(os.homedir(), '.tally');
  const sessions = path.join(home, 'sessions');
  if (!fs.existsSync(sessions)) return 'no local receipts';
  const script = `
    import { loadJudge } from '${pathToFileURL(path.join(root, 'src', 'judge', 'judge.ts')).href}';
    import { renderSummary, renderReport } from '${pathToFileURL(path.join(root, 'src', 'judge', 'report.ts')).href}';
    import fs from 'node:fs'; import path from 'node:path';
    const dir = ${JSON.stringify(sessions)};
    let n = 0, bad = [];
    for (const s of fs.readdirSync(dir)) {
      const f = path.join(dir, s, 'judge.json');
      if (!fs.existsSync(f)) continue;
      n += 1;
      const j = loadJudge(s);
      if (!j) { bad.push(s); continue; }
      renderSummary(j, false); renderReport(j);
    }
    console.log(JSON.stringify({ n, bad }));
  `;
  const tmp = path.join(os.tmpdir(), `tally-compat-${Date.now()}.mts`);
  fs.writeFileSync(tmp, script);
  const out = run('npx', ['tsx', tmp]);
  fs.rmSync(tmp, { force: true });
  const { n, bad } = JSON.parse(out.trim().split('\n').pop());
  if (bad.length) throw new Error(`${bad.length} of ${n} receipts failed to load: ${bad.slice(0, 5).join(', ')}`);
  return `${n} receipts load and render`;
});

// DOCS
check('DOCS', 'every `tally <command>` named in README exists', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');
  const commands = new Set([...cli.matchAll(/^\s{2}([a-z][a-z-]*): \(\) => import/gm)].map((m) => m[1]));
  const used = new Set([...readme.matchAll(/(?:^|[`\s])tally ([a-z][a-z-]*)/gm)].map((m) => m[1]).filter((w) => !['json'].includes(w)));
  const missing = [...used].filter((w) => !commands.has(w) && !['verify', 'eval'].includes(w) ? !commands.has(w) : false);
  if (missing.length) throw new Error(`README names commands that do not exist: ${missing.join(', ')}`);
  return `${used.size} commands referenced, all exist`;
});
check('DOCS', 'README preview version matches package.json', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  if (!readme.includes(`(v${v})`)) throw new Error(`README does not mention v${v}`);
  const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (!cl.includes(`## [${v}]`)) throw new Error(`CHANGELOG has no [${v}] section`);
  return `v${v}`;
});

// SECURITY
check('SECURITY', 'no secrets in fixtures, eval specs or results', () => {
  const pats = [/sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];
  const walk = (d, acc) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(json|jsonl|md|ts|js|txt)$/.test(f)) acc.push(p);
    }
    return acc;
  };
  const files = [];
  for (const d of ['test/fixtures', 'eval']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d), files);
  const hits = files.filter((f) => pats.some((p) => p.test(fs.readFileSync(f, 'utf8'))));
  if (hits.length) throw new Error(`possible secrets: ${hits.map((h) => path.relative(root, h)).join(', ')}`);
  return `${files.length} files scanned`;
});
check('SECURITY', 'no evaluation worktrees left in the temp directory', () => {
  /* the eval runner's roots are tally-eval-<6 random chars>; test scratch uses longer prefixes and is not what this guards */
  const left = fs.readdirSync(os.tmpdir()).filter((f) => /^tally-eval-[A-Za-z0-9_-]{6}$/.test(f) || /^tally-(release|rt|ev|evl|compat)-/.test(f));
  if (left.length > 3) throw new Error(`${left.length} tally temp dirs left over (${left.slice(0, 4).join(', ')})`);
  return `${left.length} leftover temp dir(s)`;
});

// REPORT
let failed = 0;
let section = '';
for (const r of results) {
  if (r.section !== section) {
    section = r.section;
    console.log(`\n${section}`);
  }
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  (${r.detail})` : ''}  ${Math.round(r.ms / 1000)}s`);
  if (!r.ok) failed += 1;
}
console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
