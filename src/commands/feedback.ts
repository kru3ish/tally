/* `tally feedback <criterion> correct|wrong|unsure [--comment "..."] [--session id]`
     Label a criterion on the current receipt. Stored next to the receipt; nothing leaves the machine.
   `tally feedback wrong <criterion> --report [--out bug.json] [--include-comment] [--yes]`
     Also build the sanitized wrong-verdict bundle, scan it for secrets, show it, and (after a separate, default-No
     question) open a pre-filled GitHub issue. `--out` writes the bundle to a file instead of opening anything.
   `tally feedback` with no arguments lists the criteria of the current receipt with their ids. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { type Args, flag, has } from '../cli.js';
import { resolveSession } from '../session.js';
import { resolveSessionPrefix } from './dispute.js';
import { loadJudge } from '../judge/judge.js';
import { statusFromJudge } from '../assurance/index.js';
import { LABELS, recordFeedback, readFeedback, type FeedbackLabel } from '../feedback/store.js';
import { buildWrongVerdictReport, scanForSecrets, issueUrl } from '../feedback/report.js';
import { packageRoot, readJson } from '../paths.js';

function version(): string {
  return readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? '0.0.0';
}

async function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((res) => rl.question(q, res));
  } finally {
    rl.close();
  }
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

const USAGE = 'Usage: tally feedback <c2> correct|wrong|unsure [--comment "..."] [--session id]\n       tally feedback wrong <c2> --report [--out bug.json] [--include-comment] [--yes]\n       tally feedback            list the criteria of the current receipt\n';

export async function run(args: Args): Promise<number | void> {
  const cwd = process.cwd();
  const sessionArg = flag(args, 'session');
  const session = sessionArg ? resolveSessionPrefix(sessionArg) : resolveSession(undefined, cwd);
  if (!session) {
    process.stderr.write('No session found. Pass --session <id>, or run from a repository with a Tally session.\n');
    return 2;
  }
  const j = loadJudge(session);
  if (!j) {
    process.stderr.write(`No receipt for session ${session.slice(0, 8)}. Run \`tally verify\` or \`tally judge\` first.\n`);
    return 2;
  }
  /* the plugin passes one string: "<criterion> <label> <comment…>" */
  let [a0, a1, ...rest] = args._;
  const fromArgs = flag(args, 'from-args');
  if (fromArgs !== undefined) {
    const m = /^\s*(c\d+)\s+(correct|wrong|unsure)\s*(.*)$/i.exec(fromArgs);
    if (!m) {
      process.stderr.write('Usage: /tally:feedback <c2> <correct|wrong|unsure> [comment]\n');
      return 1;
    }
    a0 = m[1]!.toLowerCase();
    a1 = m[2]!.toLowerCase();
    rest = m[3] ? [m[3]] : [];
  }
  if (!a0) {
    process.stdout.write(`Receipt for ${session.slice(0, 8)}: ${j.task.title}\n`);
    const prior = readFeedback(session);
    for (const c of j.criteria) {
      const st = j.assurance?.criteria.find((x) => x.id === c.id)?.status ?? statusFromJudge(c);
      const fb = prior.filter((f) => f.criterion === c.id).pop();
      process.stdout.write(`  ${c.id.padEnd(4)} ${st.padEnd(11)} ${c.text.slice(0, 80)}${fb ? `   [you: ${fb.label}]` : ''}\n`);
    }
    process.stdout.write('\nLabel one: tally feedback <c#> correct|wrong|unsure [--comment "..."]\n');
    return;
  }
  /* accept both orders: `feedback c2 wrong` and `feedback wrong c2` */
  let criterion = a0;
  let label = a1;
  if (LABELS.includes(a0 as FeedbackLabel) && a1) {
    label = a0;
    criterion = a1;
  }
  if (!criterion || !label || !LABELS.includes(label as FeedbackLabel)) {
    process.stderr.write(USAGE);
    return 1;
  }
  const comment = flag(args, 'comment') ?? (rest.length ? rest.join(' ') : undefined);
  let entry;
  try {
    ({ entry } = recordFeedback(session, criterion.toLowerCase(), label as FeedbackLabel, comment, version()));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(`Recorded: ${entry.criterion} ${entry.assurance} (${entry.judge_status}, ${entry.resolved_by}) → ${entry.label}${entry.comment ? ` · "${entry.comment}"` : ''}. Stored locally in the session's feedback.jsonl.${entry.false_verified ? '\nA wrong VERIFIED is the bug class Tally treats as release-blocking; `tally feedback wrong ' + entry.criterion + ' --report` builds a sanitized report for an issue.' : ''}\n`);

  if (!has(args, 'report')) return;
  if (label !== 'wrong') {
    process.stderr.write('--report is for wrong verdicts.\n');
    return 1;
  }
  const report = buildWrongVerdictReport(session, entry.criterion, { version: version(), includeComment: has(args, 'include-comment'), cwd });
  const payload = JSON.stringify(report, null, 2);
  const hits = scanForSecrets(payload);
  if (hits.length) {
    process.stderr.write(`Report blocked: the payload contains something that looks like ${hits.join(', ')}. Nothing was written or opened.${report.feedback.comment_included ? ' Rerun without --include-comment, or edit the comment.' : ''}\n`);
    return 1;
  }
  const out = flag(args, 'out');
  if (out) {
    fs.writeFileSync(out, payload + '\n');
    process.stdout.write(`Wrote ${out} (${payload.length} bytes). Excluded by construction: ${report.excluded.join(', ')}.\n`);
    return;
  }
  process.stdout.write(`\nThis is the whole payload. Nothing else is sent.\n\n${payload}\n\nExcluded by construction: ${report.excluded.join(', ')}.\n`);
  if (!process.stdin.isTTY && !has(args, 'yes')) {
    process.stdout.write('Not a terminal: pass --yes to confirm, or --out bug.json to save it.\n');
    return;
  }
  const ok = has(args, 'yes') ? 'y' : await ask('Keep this report? [y/N] ');
  if (!/^y(es)?$/i.test(ok.trim())) {
    process.stdout.write('Discarded.\n');
    return;
  }
  const file = path.join(cwd, `tally-wrong-verdict-${entry.criterion}-${session.slice(0, 8)}.json`);
  fs.writeFileSync(file, payload + '\n');
  process.stdout.write(`Saved ${file}.\n`);
  if (has(args, 'yes') && !process.stdin.isTTY) return;
  const open = await ask(`Open a pre-filled GitHub issue in the browser (${report.feedback.false_verified ? 'tagged false-verified' : 'wrong-verdict'})? [y/N] `);
  if (/^y(es)?$/i.test(open.trim())) {
    const url = issueUrl(report);
    openInBrowser(url);
    process.stdout.write('Opened. Add what was actually true in your own words before submitting.\n');
  } else process.stdout.write(`Not opened. The file above is enough for an issue at https://github.com/kru3ish/tally/issues/new?template=wrong_verdict.md\n`);
}
