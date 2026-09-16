/* End-to-end replay of the fixture session with a stubbed LLM, isolated from the real ~/.claude and ~/.tally. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { StubLlm } from '../llm/client.js';
import { intake, renderTask } from '../task/intake.js';
import { readEventsFile, readEvents, type TallyEvent } from '../store/events.js';
import { buildContext } from '../coach/context.js';
import { CoachEngine, loadState, saveState } from '../coach/engine.js';
import { renderHeader, renderSuggestion, paint } from '../coach/ui.js';
import { applySuggestion, injectSuggestion } from '../coach/actions.js';
import { judgeSession, renderSummary } from '../judge/judge.js';
import { followupSession } from '../followup/followup.js';
import { sessionDir, ensureDir, historyFile, appendLine, repoKey, builtHookPath } from '../paths.js';
import type { Suggestion, HistoryEntry } from '../coach/types.js';
import type { Exec } from '../judge/evidence.js';
import { parseTranscriptFile } from '../transcript/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface DemoOptions {
  out?: (s: string) => void;
  color?: boolean;
  keep?: boolean;
  home?: string;
  fast?: boolean;
}

export interface DemoResult {
  home: string;
  repo: string;
  session: string;
  suggestionsShown: number;
  applied: string[];
  injected: string[];
  shipDetected: boolean;
  verdict: string;
  finalVerdict: string;
  reportPath: string;
}

function fixturesDir(): string {
  for (const c of [path.join(here, '..', '..', 'test', 'fixtures', 'session-basic'), path.join(here, '..', 'fixtures', 'session-basic')]) if (fs.existsSync(c)) return c;
  throw new Error('fixtures not found; run from a source checkout');
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(root: string): { cwd: string; base: string } {
  const cwd = path.join(root, 'acme-app');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'demo@tally.local');
  git(cwd, 'config', 'user.name', 'tally demo');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'acme-app', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
  fs.writeFileSync(path.join(cwd, 'test.js'), `const login = require('./src/login');\nif (login(6) !== 429) { console.error('expected 429 after 5 attempts'); process.exit(1); }\nconsole.log('ok: 429 after 5 attempts');\n`);
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), `module.exports = function login(attempts) { return 200; };\n`);
  fs.writeFileSync(path.join(cwd, 'README.md'), '# acme-app\n\nExpress API.\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  return { cwd, base };
}

function applyWork(cwd: string): void {
  fs.writeFileSync(path.join(cwd, 'src', 'rateLimit.js'), `const MAX = 5;\nmodule.exports = function rateLimit(attempts) { return attempts > MAX; };\n`);
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), `const rateLimit = require('./rateLimit');\nmodule.exports = function login(attempts) { return rateLimit(attempts) ? 429 : 200; };\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'add rate limiting to login (#57)');
}

function hookPayload(e: TallyEvent, session: string, cwd: string, transcriptPath: string): { event: string; input: Record<string, unknown> } | null {
  const base = { session_id: session, cwd, transcript_path: transcriptPath };
  switch (e.type) {
    case 'session_start':
      return { event: 'SessionStart', input: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: e.data.model } };
    case 'prompt':
      return { event: 'UserPromptSubmit', input: { ...base, hook_event_name: 'UserPromptSubmit', prompt: e.data.prompt } };
    case 'pre_tool':
      return { event: 'PreToolUse', input: { ...base, hook_event_name: 'PreToolUse', tool_name: e.data.tool_name, tool_input: e.data.tool_input, tool_use_id: e.data.tool_use_id, ...(e.data.agent ? { agent_id: e.data.agent } : {}) } };
    case 'post_tool': {
      const head = String(e.data.response_head ?? '');
      const resp = e.data.is_error && !/^Error/.test(head) ? `Error: ${head}` : head;
      return { event: e.data.is_error ? 'PostToolUseFailure' : 'PostToolUse', input: { ...base, hook_event_name: 'PostToolUse', tool_name: e.data.tool_name, tool_input: e.data.tool_input, tool_use_id: e.data.tool_use_id, tool_response: resp, ...(e.data.agent ? { agent_id: e.data.agent } : {}) } };
    }
    case 'stop':
      return { event: 'Stop', input: { ...base, hook_event_name: 'Stop', last_assistant_message: e.data.last_assistant_message } };
    case 'pre_compact':
      return { event: 'PreCompact', input: { ...base, hook_event_name: 'PreCompact', trigger: e.data.trigger } };
    case 'session_end':
      return { event: 'SessionEnd', input: { ...base, hook_event_name: 'SessionEnd', reason: e.data.reason } };
    default:
      return null;
  }
}

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const color = opts.color ?? !!process.stdout.isTTY;
  const bold = (s: string) => paint(color, '\x1b[1m', s);
  const dim = (s: string) => paint(color, '\x1b[90m', s);
  const green = (s: string) => paint(color, '\x1b[32m', s);
  const yellow = (s: string) => paint(color, '\x1b[33m', s);
  const cyan = (s: string) => paint(color, '\x1b[36m', s);
  const step = (n: number, s: string) => out(`\n${bold(cyan(`[${n}] ${s}`))}`);

  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tally-demo-'));
  const prev = { TALLY_HOME: process.env.TALLY_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TALLY_NO_SPAWN: process.env.TALLY_NO_SPAWN, TALLY_LLM: process.env.TALLY_LLM };
  process.env.TALLY_HOME = path.join(home, 'tally');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.TALLY_NO_SPAWN = '1';
  process.env.TALLY_LLM = 'stub';
  fs.mkdirSync(process.env.TALLY_HOME, { recursive: true });
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

  try {
    const fx = fixturesDir();
    const session = 'demo-' + Date.now().toString(36);
    const { cwd, base } = makeRepo(home);
    const cfg = loadConfig();
    cfg.coach.min_interval_s = 180;
    const hook = builtHookPath();
    ensureDir(sessionDir(session));
    const transcriptPath = path.join(sessionDir(session), 'transcript.jsonl');
    fs.copyFileSync(path.join(fx, 'transcript.jsonl'), transcriptPath);

    out(bold('Tally demo') + dim(`  isolated data dir: ${process.env.TALLY_HOME}`));
    out(dim(`  fake repo: ${cwd}  ·  real ~/.claude and ~/.tally are not touched  ·  LLM calls are stubbed`));

    const repo = repoKey(cwd);
    const priorHistory: HistoryEntry[] = [
      ...[1, 2, 3].map((i) => ({ ts: `2026-09-0${i}T10:00:00Z`, kind: 'session', session: `prior-${i}`, repo, loaded: { mcp: ['github', 'jira', 'postgres'], skills: ['superpowers:test-driven-development', 'deploy-checklist'], plugins: ['superpowers'] }, used: { skills: ['superpowers:test-driven-development'], mcp: ['github'] }, first_turn_tokens: 41000, cost_usd: 2.1 })),
      { ts: '2026-09-03T12:00:00Z', session: 'prior-3', repo, task_title: 'Add password reset', verdict: 'worth it', final_status: 'needed rework', final_verdict: 'borderline', completion_pct: 75, cost_usd: 3.2, waste_usd: 0.9, recommendations: ['Run the full test suite once before pushing instead of after each edit.', 'Read the ticket checklist before declaring done.'], linked: true },
    ];
    for (const h of priorHistory) appendLine(historyFile(), JSON.stringify(h));

    step(1, 'Task intake (stubbed intake model)');
    const llm = new StubLlm(
      {
        intake: () => ({
          title: 'Rate limit the login endpoint',
          criteria: [
            { text: 'POST /api/login returns 429 after 5 failed attempts from one IP within 15 minutes', source: 'explicit' },
            { text: 'A test covers the 429 path', source: 'explicit' },
            { text: 'README documents the limit', source: 'explicit' },
            { text: 'Existing login behaviour is unchanged below the limit', source: 'inferred' },
          ],
          spec_quality: { score: 4, missing: ['what counts as a failed attempt', 'whether a successful login resets the counter', 'per-IP vs per-account'], questions: ['Does a successful login reset the counter?', 'Should the limit be per IP, per account, or both?', 'Is 429 the agreed status code?'] },
          estimate_hours: 3,
          rationale: 'middleware plus test plus docs',
        }),
        judge: () => ({
          criteria: [
            { id: 'c1', status: 'met', evidence: 'src/rateLimit.js returns true above 5 attempts and src/login.js maps it to 429; independent `npm test` passed.', files: ['src/login.js', 'src/rateLimit.js'] },
            { id: 'c2', status: 'met', evidence: 'test.js asserts 429 after 6 attempts; the auditor ran it and it passed.', files: ['test.js'] },
            { id: 'c3', status: 'unmet', evidence: 'README.md is unchanged in the diff; the assistant said "I did not update the README".', files: [] },
            { id: 'c4', status: 'unverifiable', evidence: 'No test exercises attempts below the limit; nothing in the diff contradicts it.', files: [] },
          ],
          quality_score: 7,
          quality_reason: 'Small, focused change with a test. The limiter has no window expiry, so the "15 minutes" part is not enforced.',
          verdict_reason: 'Two of four criteria are met with an independent green test run, one is unmet and one unverifiable, so 50% completion. Spend is well inside the budget and the ROI is comfortably above 2×, but the README criterion was skipped and stated as skipped, and $0.60 of the $1.33 went into three identical failing test runs.',
          recommendations: ['When `npm test` fails twice with the same assertion, read the test before editing the implementation again; the third run cost $0.20 for no new information.', 'Read the ticket checklist before saying done: the README item was explicit and skipped.', 'Stop calling the Jira MCP after the first 401; three retries burned three turns.'],
        }),
        coach: () => ({ has_suggestion: true, title: 'Window expiry missing', message: 'The limiter never expires old attempts; the ticket says 15 minutes.', inject_note: 'The ticket says the 5-attempt limit applies within a 15-minute window; the current limiter never expires attempts. Add the window before finishing.', severity: 'warn', usd_saved: 3 }),
      },
      session,
    );
    const { task } = await intake({ session, cwd, ref: path.join(fx, 'task.md'), cfg, llm });
    out(renderTask(task));
    if (task.needs_clarification) out(yellow('  ⚠ Spec quality below 5: Coach will say "Clarify the ticket first" and list the questions.'));

    step(2, 'Replaying the session through the real hooks, with the Coach watching');
    out(dim('  each fixture event is fed to dist/hooks/hook.js on stdin; the Coach ticks on simulated time'));
    const events = readEventsFile(path.join(fx, 'events.jsonl')).filter((e) => e.type !== 'ship');
    const engine = new CoachEngine(loadState(session), cfg, undefined, {});
    let shown = 0;
    const applied: string[] = [];
    const injected: string[] = [];
    let shipDetected = false;
    let lastPromptDelivery = '';
    let llmCalls = 0;
    let transcriptCut = 0;
    const transcriptLines = fs.readFileSync(path.join(fx, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean);
    const permissionEvents: TallyEvent[] = [];

    const handle = (s: Suggestion, now: Date) => {
      shown += 1;
      out(renderSuggestion(s, color));
      const canApply = s.action.kind === 'write_md' || s.action.kind === 'settings';
      if (canApply && applied.length === 0) {
        const r = applySuggestion(s, { session, cwd, cfg, mode: 'ask' });
        out(green(`    → [a] applied: ${r.detail}`));
        applied.push(s.rule);
      } else if ((s.action.kind === 'inject' || s.inject_note) && injected.length === 0) {
        const r = injectSuggestion(s, { session, cwd });
        out(green(`    → [i] injected: ${r.detail}`));
        injected.push(s.rule);
      } else {
        out(dim('    → [s] skipped'));
      }
      void now;
    };

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const now = new Date(e.ts);
      const payload = hookPayload(e, session, cwd, transcriptPath);
      if (!payload) continue;
      if (e.type === 'session_start') {
        const fakeSettings = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
        fs.writeFileSync(fakeSettings, JSON.stringify({ enabledPlugins: { 'superpowers@official': true } }));
      }
      const r = spawnSync(process.execPath, [hook, payload.event], { input: JSON.stringify(payload.input), encoding: 'utf8', env: { ...process.env }, windowsHide: true });
      if (r.status !== 0) out(yellow(`  hook ${payload.event} exited ${r.status}`));
      if (e.type === 'prompt') {
        out(`  ${dim(now.toISOString().slice(11, 19))} ${bold('user>')} ${String(e.data.prompt).slice(0, 90)}`);
        if (r.stdout.includes('[Tally]')) {
          lastPromptDelivery = (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
          out(green(`  ↳ hook delivered to Claude: ${lastPromptDelivery.split('\n')[0]!.slice(0, 110)}`));
        }
      } else if (e.type === 'session_start' && r.stdout.includes('[Tally]')) {
        out(green(`  ↳ SessionStart hook injected history lessons: ${(JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext.split('\n')[1]?.slice(0, 100)}`));
      } else if (e.type === 'post_tool') {
        const inp = e.data.tool_input as Record<string, unknown>;
        const what = String(inp.command ?? inp.file_path ?? inp.pattern ?? inp.skill ?? '').replace(/\\/g, '/').slice(-60);
        out(`  ${dim(now.toISOString().slice(11, 19))} ${dim(String(e.data.tool_name))} ${dim(what)}${e.data.is_error ? yellow(' ✘') : ''}`);
        if (String(e.data.tool_name) === 'Bash' && /git push/.test(String(inp.command)) && !e.data.is_error) {
          shipDetected = readEvents(session).some((x) => x.type === 'ship');
          if (shipDetected) out(green('  ↳ ship detected (git push): judge scheduled in the background'));
        }
        if (/npm test/.test(String(inp.command)) && e.data.is_error && permissionEvents.length < 2) {
          const pe: TallyEvent = { ts: e.ts, type: 'permission', session, cwd, data: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash(npm test)' } };
          spawnSync(process.execPath, [hook, 'Notification'], { input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: pe.data.message }), encoding: 'utf8', env: { ...process.env }, windowsHide: true });
          permissionEvents.push(pe);
        }
      }
      while (transcriptCut < transcriptLines.length) {
        const ts = (JSON.parse(transcriptLines[transcriptCut]!) as { timestamp?: string }).timestamp ?? '';
        if (ts && ts > e.ts) break;
        transcriptCut += 1;
      }
      fs.writeFileSync(transcriptPath, transcriptLines.slice(0, Math.max(transcriptCut, 1)).join('\n') + '\n');

      const ctx = buildContext({ session, cwd, cfg, now, transcriptPath });
      const tick = engine.tick(ctx);
      for (const s of tick.show) handle(s, now);
      if (!tick.show.length && engine.llmAllowed(now, ctx.events.length) && ctx.events.filter((x) => x.type === 'post_tool').length > 8 && llmCalls < 1) {
        engine.markLlm(now, ctx.events.length);
        llmCalls += 1;
        const { llmCoach } = await import('../coach/llm-coach.js');
        const s = await llmCoach(ctx, llm);
        if (s) for (const x of engine.tick(ctx, [s]).show) handle(x, now);
      }
      saveState(session, engine.state);
      if (!opts.fast) await new Promise((res) => setTimeout(res, 15));
    }
    fs.copyFileSync(path.join(fx, 'transcript.jsonl'), transcriptPath);
    out(dim(`  ${shown} suggestions shown (noise limits: 1 non-critical per ${cfg.coach.min_interval_s}s, ${cfg.coach.max_per_session} per session; critical always)`));

    step(3, 'Judge (stubbed judge model, real git diff, real independent test run)');
    applyWork(cwd);
    const events2 = readEvents(session).map((e) => (e.type === 'session_start' ? { ...e, data: { ...e.data, git_head: base } } : e));
    const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason: 'push', events: events2 });
    out(renderSummary(judge, color));
    const t = parseTranscriptFile(transcriptPath);
    out(dim(`  models in session: ${t.models.join(', ')} · subagent spend: ${Object.entries(judge.cost.by_subagent).filter(([k]) => k !== 'main').map(([k, v]) => `${k} $${v.usd.toFixed(3)}`).join(', ') || 'none'}`));
    out(dim(`  full receipt: ${path.join(sessionDir(session), 'report.md')}`));

    step(4, 'Follow-up 8 days later: the PR was merged, then reverted');
    const mergeSha = git(cwd, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(cwd, 'src', 'login.js'), `module.exports = function login(attempts) { return 200; };\n`);
    fs.unlinkSync(path.join(cwd, 'src', 'rateLimit.js'));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', `Revert "add rate limiting to login (#57)"\n\nThis reverts commit ${mergeSha}. Locked out the QA team.`);
    const fakeGh: Exec = (bin, args, c) => {
      if (bin === 'git') {
        const r = spawnSync('git', args, { cwd: c, encoding: 'utf8', windowsHide: true });
        return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      if (args[0] === 'pr') return { ok: true, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-11T09:00:00Z', mergeCommit: { oid: mergeSha }, reviews: [{ state: 'APPROVED' }], comments: [{}, {}], number: 57, headRefName: 'feature/rate-limit' }), stderr: '' };
      if (args[0] === 'run') return { ok: true, stdout: JSON.stringify([{ conclusion: 'success', name: 'ci' }]), stderr: '' };
      if (args[0] === 'api') return { ok: true, stdout: '[]', stderr: '' };
      if (args[0] === 'issue') return { ok: true, stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' };
      return { ok: false, stdout: '', stderr: '' };
    };
    const after = followupSession(session, { exec: fakeGh, now: () => new Date('2026-09-18T10:00:00Z') })!;
    out(`  original verdict: ${bold(after.followup!.original_verdict)}  →  final: ${bold(after.followup!.final_verdict)}  (${after.followup!.final_status})`);
    for (const n of after.followup!.notes) out(dim(`  - ${n}`));

    out('');
    out(bold('Done.') + ` ${shown} coach suggestions, ${applied.length} applied (${applied.join(', ')}), ${injected.length} injected (${injected.join(', ')}), ship detected: ${shipDetected ? 'yes' : 'no'}, verdict ${judge.verdict.verdict} → ${after.followup!.final_verdict}.`);
    out(dim(`Demo data: ${home}${opts.keep ? ' (kept)' : ' (delete it whenever you like)'}`));

    return { home, repo: cwd, session, suggestionsShown: shown, applied, injected, shipDetected, verdict: judge.verdict.verdict, finalVerdict: after.followup!.final_verdict, reportPath: path.join(sessionDir(session), 'report.md') };
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
