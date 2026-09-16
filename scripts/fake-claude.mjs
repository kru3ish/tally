#!/usr/bin/env node
/* A stand-in for the Claude Code CLI's `claude -p` used by the plugin-only CI check: it answers Tally's intake,
   judge and coach calls with canned, schema-shaped JSON so the pipeline runs end to end with no login and no spend.
   Point Tally at it with TALLY_CLAUDE_BIN=scripts/fake-claude.mjs (or put a `claude` shim that execs it on PATH). */
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('0.0.0 (fake claude for the Tally CI plugin-only check)\n');
  process.exit(0);
}
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
let prompt = get('-p') ?? '';
const system = get('--system-prompt') ?? '';
const model = get('--model') ?? 'fake';
if (/follows on stdin/.test(prompt)) prompt = fs.readFileSync(0, 'utf8');

let out;
if (/^TITLE:/m.test(prompt)) {
  const title = (/^TITLE:\s*(.+)$/m.exec(prompt)?.[1] ?? 'Task').trim().slice(0, 80);
  out = {
    title,
    criteria: [
      { text: `The requested change is made: ${title}`, source: 'explicit', check: { kind: 'none' } },
      { text: 'README.md was changed', source: 'inferred', check: { kind: 'file_changed', path: 'README.md' } },
    ],
    spec_quality: { score: 7, missing: [], questions: [] },
    estimate_hours: 0.5,
    rationale: 'fake intake: one explicit criterion from the title, one mechanical check on README.md',
  };
} else if (/auditor/i.test(system)) {
  const ids = [...new Set([...prompt.matchAll(/\b(c\d+)\b/g)].map((m) => m[1]))];
  out = {
    criteria: ids.map((id) => ({ id, status: 'met', evidence: 'fake judge: the diff contains the requested change', files: ['README.md'], confidence: 0.9 })),
    quality_score: 7,
    quality_reason: 'fake judge',
    verdict_reason: 'fake judge: every judgment criterion is met in the diff',
    recommendations: ['fake recommendation one', 'fake recommendation two', 'fake recommendation three'],
  };
} else if (/coach/i.test(system)) {
  out = { has_suggestion: false };
} else {
  out = {};
}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out, total_cost_usd: 0.001, modelUsage: { [model]: { costUSD: 0.001 } } }) + '\n');
