// Writes eval/tasks/*.json specs for the local evaluation repositories built this week:
//   ~/dev/tally-eval/<task>      eight constructed tasks (class fixture)
//   ~/dev/tally-eval-gh/<task>   six public issues cloned locally (class real)
// Each spec points at the local clone and at the commit that holds task.md as the base, so `tally eval run` copies
// the repo, checks out that base and lets a fresh agent redo the work. Usage: node scripts/eval-tasks-from-local.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const home = process.env.USERPROFILE || process.env.HOME;
const out = path.join(process.cwd(), 'eval', 'tasks');
fs.mkdirSync(out, { recursive: true });

function baseOf(dir) {
  try {
    const sha = execSync('git log --format=%H --grep="eval: task" -n 1', { cwd: dir, encoding: 'utf8' }).trim();
    if (sha) return sha;
  } catch {
    /* fall through */
  }
  return execSync('git rev-list --max-parents=0 HEAD', { cwd: dir, encoding: 'utf8' }).trim().split('\n')[0];
}

const GH = {
  'express-7350': { issue: 'https://github.com/expressjs/express/issues/7350', tags: ['javascript', 'bug', 'express'] },
  'express-4557': { issue: 'https://github.com/expressjs/express/issues/4557', tags: ['javascript', 'bug', 'express', 'routing'] },
  'yargs-2423': { issue: 'https://github.com/yargs/yargs/issues/2423', tags: ['typescript', 'bug', 'cli-parser'] },
  'qs-262': { issue: 'https://github.com/ljharb/qs/issues/262', tags: ['javascript', 'bug', 'parser'], test_command: 'npx tape "test/**/*.js"' },
  'commander-2603': { issue: 'https://github.com/tj/commander.js/issues/2603', tags: ['javascript', 'bug', 'cli'] },
  'micromatch-212': { issue: 'https://github.com/micromatch/micromatch/issues/212', tags: ['javascript', 'bug', 'glob', 'dependency-root-cause'] },
};

let n = 0;
for (const [root, cls] of [
  [path.join(home, 'dev', 'tally-eval'), 'fixture'],
  [path.join(home, 'dev', 'tally-eval-gh'), 'real'],
]) {
  if (!fs.existsSync(root)) continue;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (name.startsWith('_') || !fs.existsSync(path.join(dir, 'task.md'))) continue;
    const base = baseOf(dir);
    const meta = GH[name] ?? {};
    const spec = {
      id: name,
      class: cls,
      repo: dir.replace(/\\/g, '/'),
      base,
      issue: meta.issue,
      task: path.join(dir, 'task.md').replace(/\\/g, '/'),
      test_command: meta.test_command,
      setup: [],
      tags: meta.tags ?? ['javascript', 'constructed'],
      selected_because: cls === 'fixture' ? 'constructed small task with explicit acceptance criteria; exercises the whole pipeline cheaply' : 'open public bug with a stated expectation and a runnable suite; solved locally 2026-09-26 and blind-graded 28/29',
      contamination: cls === 'fixture' ? 'unlikely' : 'possible',
      contamination_note: cls === 'fixture' ? 'written for this corpus on 2026-09-26' : 'open issue at selection time; the thread may contain hints and a fork may hold a fix',
      added: '2026-09-27',
    };
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(spec, null, 2) + '\n');
    n += 1;
  }
}
console.log(`${n} spec(s) → ${path.relative(process.cwd(), out)}`);
