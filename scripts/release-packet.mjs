/* Release packet (dev workflow only, never shipped): drafts a launch post, a LinkedIn post, an X thread, a Reddit
   draft, a demo script, a changelog summary and the interesting evaluation failures into release/<version>/, all from
   what the repository actually says: CHANGELOG.md, eval/results/, docs/EVALUATION.md. Every number is read from the
   ledger; anything a person must decide is marked TODO. The maintainer rewrites in their own voice before posting.
     node scripts/release-packet.mjs [version]        (default: the version in package.json) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.argv[2] ?? pkg.version;
const out = path.join(root, 'release', version);
fs.mkdirSync(out, { recursive: true });

/* ---- changelog section for this version (or [Unreleased] when the version has no section yet) ---- */
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
function section(heading) {
  const re = new RegExp(`^## \\[${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\n]*\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm');
  return re.exec(changelog)?.[1]?.trim() ?? '';
}
const notes = section(version) || section('Unreleased');
const bullets = [...notes.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1].replace(/\.$/, ''));

/* ---- the ledger: per class, and the disagreements worth writing about ---- */
const resultsDir = path.join(root, 'eval', 'results');
const runs = [];
for (const cls of ['fixture', 'real', 'historical']) {
  const d = path.join(resultsDir, cls);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) runs.push({ cls, file: `${cls}/${f}`, ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) });
}
const byClass = {};
for (const r of runs) {
  const b = (byClass[r.cls] ??= { runs: 0, criteria: 0, exact: 0, false_verified: 0, false_unmet: 0, verdict_n: 0, verdict_ok: 0, cost: 0 });
  b.runs += 1;
  b.criteria += r.agreement.total;
  b.exact += r.agreement.exact;
  b.false_verified += r.agreement.false_verified;
  b.false_unmet += r.agreement.false_unmet;
  if (r.grader_verdict) {
    b.verdict_n += 1;
    if (r.grader_verdict === r.tally_summary.verdict) b.verdict_ok += 1;
  }
  b.cost += r.agent.cost_usd ?? 0;
}
const failures = [];
for (const r of runs) {
  for (const c of r.criteria) {
    if (c.agree) continue;
    failures.push({ cls: r.cls, task: r.task.id, id: c.id, text: c.text, tally: `${c.tally.status}/${c.tally.assurance}`, grader: c.grader.status, false_verified: c.false_verified, false_unmet: c.false_unmet, grader_evidence: (c.grader.evidence ?? '').slice(0, 240), file: r.file });
  }
  if (r.grader_verdict && r.grader_verdict !== r.tally_summary.verdict) failures.push({ cls: r.cls, task: r.task.id, id: 'verdict', text: `Tally ${r.tally_summary.verdict}, grader ${r.grader_verdict}`, tally: r.tally_summary.verdict, grader: r.grader_verdict, false_verified: false, false_unmet: false, grader_evidence: (r.grader?.quality_note ?? '').slice(0, 240), file: r.file });
}
const worst = [...failures.filter((f) => f.false_verified), ...failures.filter((f) => f.false_unmet), ...failures.filter((f) => !f.false_verified && !f.false_unmet)];

const table = ['| Class | Runs | Criteria | Exact | False VERIFIED | False UNMET | Verdicts | Agent $ |', '|---|---|---|---|---|---|---|---|', ...Object.entries(byClass).map(([cls, b]) => `| ${cls} | ${b.runs} | ${b.criteria} | ${b.exact}/${b.criteria} | ${b.false_verified} | ${b.false_unmet} | ${b.verdict_n ? `${b.verdict_ok}/${b.verdict_n}` : '-'} | ${b.cost.toFixed(2)} |`)].join('\n');

const write = (name, text) => fs.writeFileSync(path.join(out, name), text.trimStart() + '\n');

write(
  'changelog-summary.md',
  `# ${pkg.name} ${version}: changelog summary\n\nSource: CHANGELOG.md section for ${version}${section(version) ? '' : ' (taken from [Unreleased]; cut the section before tagging)'}.\n\n${bullets.map((b) => `- ${b}`).join('\n') || '- TODO: no bolded bullets found in the changelog section'}\n\n<details><summary>Full section</summary>\n\n${notes}\n\n</details>\n`,
);

write(
  'eval-failures.md',
  `# Interesting evaluation failures (${runs.length} runs in eval/results)\n\nEvery disagreement between Tally and the blind grader, worst first: false VERIFIED, then false UNMET, then the rest. These are the honest material for posts; do not cherry-pick the wins.\n\n${table}\n\n${worst.length ? worst.map((f) => `- **${f.task}** (${f.cls}) ${f.id}: Tally ${f.tally}, grader ${f.grader}${f.false_verified ? '  ← FALSE VERIFIED' : f.false_unmet ? '  ← false UNMET' : ''}\n  ${f.text.slice(0, 160)}\n  grader: ${f.grader_evidence || '(no note)'}\n  file: eval/results/${f.file}`).join('\n') : '- none: every criterion and verdict agreed'}\n\nWrite-ups with causes and fixes: docs/EVALUATION.md.\n`,
);

write(
  'launch-post.md',
  `# Launch post: Tally ${version}   (TODO: rewrite in your voice; ~400 words)\n\n**Coding agents say they're done. Tally asks for proof.**\n\nTODO one paragraph: the moment you stopped trusting "all tests pass".\n\nWhat shipped in ${version}:\n${bullets.map((b) => `- ${b}`).join('\n')}\n\nThe numbers, from the ledger (a model grading a model; the human-graded set is the reference):\n\n${table}\n\nThe failure to lead with (Tally was wrong, and how it was caught):\n${worst[0] ? `- ${worst[0].task} ${worst[0].id}: Tally ${worst[0].tally}, grader ${worst[0].grader}. ${worst[0].text.slice(0, 200)}` : '- TODO'}\n\nInstall: \`npm i -g @kru3ish/tally && tally install\` or \`/plugin install tally@tally\`. Try: \`tally demo\`, then \`tally onboard\`.\n\nTODO closing: what you want from readers (install, run one real task, tell me when it catches something).\n`,
);

write(
  'linkedin.md',
  `# LinkedIn   (TODO: rewrite; 150-250 words, no hashtags wall)\n\nCoding agents say they're done. Tally asks for proof.\n\nTally ${version} ships ${bullets.length} changes. The one I'd point at: ${bullets[0] ?? 'TODO'}.\n\nIt also ships its own mistakes. ${worst[0] ? `In the ${worst[0].cls} evaluation, Tally said ${worst[0].tally} on a criterion the blind grader called ${worst[0].grader}; the write-up and the fix are in the repo.` : 'TODO'}\n\nInstall: npm i -g @kru3ish/tally. Try tally demo, then tally onboard on the history you already have.\n\nTODO: one line on what you're looking for (people running agents on a team).\n`,
);

write(
  'x-thread.md',
  `# X thread   (TODO: rewrite; each tweet ≤ 280 chars)\n\n1/ Coding agents say they're done. Tally asks for proof. ${version} is out.\n\n2/ What it does: freezes the acceptance criteria before the work, re-runs the tests itself, hands you VERIFIED / SUPPORTED / UNVERIFIED / UNMET per criterion with the evidence.\n\n3/ New in ${version}: ${bullets.slice(0, 3).join('; ') || 'TODO'}.\n\n4/ It publishes its own wrong verdicts. ${worst[0] ? `${worst[0].task}: Tally ${worst[0].tally}, grader ${worst[0].grader}.` : 'TODO'} Cause and fix in docs/EVALUATION.md.\n\n5/ The numbers, by class, never one headline: ${Object.entries(byClass).map(([c, b]) => `${c} ${b.exact}/${b.criteria}, false VERIFIED ${b.false_verified}`).join('; ')}.\n\n6/ npm i -g @kru3ish/tally → tally demo → tally onboard. Local; opt-in metrics off by default. github.com/kru3ish/tally\n`,
);

write(
  'reddit.md',
  `# Reddit draft   (TODO: pick the subreddit; lead with the failure case, not the pitch)\n\nTitle: I built a tool that checks whether my coding agent actually did the task. It was wrong ${byClass.fixture?.false_verified + byClass.real?.false_verified + byClass.historical?.false_verified || 0} time(s) in its own evaluation; here is how it caught itself.\n\nBody:\n\nTODO: the story of one real failure from eval-failures.md, told plainly: what the agent claimed, what the test suite said, what Tally said, what the blind grader said, what changed.\n\nWhat Tally is: ${bullets.length ? 'a local CLI/plugin that freezes the criteria, re-runs the tests, and produces a per-criterion receipt' : 'TODO'}.\n\nWhat it is not: a benchmark. The numbers in the README are small and labelled.\n\nRepo: github.com/kru3ish/tally. Happy to be told where it is wrong; \`tally feedback wrong <c#> --report\` builds a sanitized report.\n`,
);

write(
  'demo-script.md',
  `# Demo recording script (30-45 s)\n\nTerminal at 80 columns, dark background, font 16px. Record with vhs or asciinema; \`tally demo --fast\` is too fast for a recording, use \`tally demo --width 80\`.\n\n1. \`tally demo --width 80\` (0:00). Let it scroll; the intake and the Coach fly by.\n2. Pause on step [4] \`tally verify\` (0:15): point at VERIFIED / UNMET / UNVERIFIED and the evidence lines.\n3. Pause on step [7] "A test that agrees with its own mistake" (0:30): the criterion is not VERIFIED even though the suite is green.\n4. End on "Temp files removed." (0:45).\n\nThen: \`node scripts/render-demo.mjs <captured output>\` refreshes docs/demo.svg and docs/demo.cast for the README.\n`,
);

console.log(`release packet for ${version} → ${path.relative(root, out)}/ (${fs.readdirSync(out).length} files; git-ignored). Rewrite before posting.`);
