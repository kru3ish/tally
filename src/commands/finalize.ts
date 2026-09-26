import fs from 'node:fs';
import path from 'node:path';
import { type Args, flag } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { judgeSession, loadJudge, currentHead } from '../judge/judge.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import { loadTask } from '../task/intake.js';
import { readEvents } from '../store/events.js';
import { sessionCwd, transcriptPathFor } from '../session.js';
import { historyFile, appendLine, repoKey, sessionDir, log, writeJson, isInternalCwd } from '../paths.js';
import { restoreExperimentConfig, prepareNextArm } from '../experiment/experiment.js';

/* Resolves once task.json exists or task.pending is gone, or after maxMs. Returns the time waited. */
export async function waitForIntake(session: string, maxMs: number, pollMs = 2000): Promise<number> {
  const dir = sessionDir(session);
  const started = Date.now();
  while (fs.existsSync(path.join(dir, 'task.pending')) && !fs.existsSync(path.join(dir, 'task.json')) && Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return Date.now() - started;
}

/* True when the frozen task landed after the receipt was written, so the receipt scored something else. */
export function receiptPredatesTask(session: string): boolean {
  const dir = sessionDir(session);
  const jf = path.join(dir, 'judge.json');
  const tf = path.join(dir, 'task.json');
  if (!fs.existsSync(jf) || !fs.existsSync(tf)) return false;
  try {
    const judgedAt = Date.parse((JSON.parse(fs.readFileSync(jf, 'utf8')) as { judged_at?: string }).judged_at ?? '');
    return Number.isFinite(judgedAt) && fs.statSync(tf).mtimeMs > judgedAt;
  } catch {
    return false;
  }
}

export async function run(args: Args): Promise<void> {
  const session = args._[0] ?? flag(args, 'session');
  if (!session) return;
  const cfg = loadConfig();
  const cwd = sessionCwd(session) ?? process.cwd();
  const transcriptPath = transcriptPathFor(session);
  const events = readEvents(session);
  const startEv = events.find((e) => e.type === 'session_start');
  const loaded = (startEv?.data.loaded as { mcp: string[]; skills: string[]; plugins: string[] } | undefined) ?? { mcp: [], skills: [], plugins: [] };

  let usedSkills: string[] = [];
  let usedMcp: string[] = [];
  let firstTurn = 0;
  let cost = 0;
  let costConfidence: 'full' | 'partial' = 'full';
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const t = parseTranscriptFile(transcriptPath);
    if (t.internal || isInternalCwd(cwd)) {
      log(`finalize: ${session} is an internal Tally run; not recorded`);
      return;
    }
    usedSkills = [...new Set(t.skills.map((s) => s.name))];
    usedMcp = [...new Set(t.mcpCalls.map((m) => m.server))];
    firstTurn = t.firstTurnContextTokens;
    cost = t.cost;
    costConfidence = t.cost_confidence;
  } else if (isInternalCwd(cwd)) {
    return;
  }
  const summary = { ts: new Date().toISOString(), kind: 'session', session, repo: repoKey(cwd), loaded, used: { skills: usedSkills, mcp: usedMcp }, first_turn_tokens: firstTurn, cost_usd: cost, cost_confidence: costConfidence, linked: !!loadTask(session), internal: false };
  appendLine(historyFile(), JSON.stringify(summary));
  writeJson(path.join(sessionDir(session), 'summary.json'), summary);

  try {
    restoreExperimentConfig(cwd, session);
    prepareNextArm(cwd);
  } catch (err) {
    log(`finalize: experiment restore failed: ${String(err)}`);
  }

  /* a short session can end while the intake spawned by its first prompt is still running; judging before the task is
     frozen would score the prompt instead of the criteria, so wait for it (bounded) */
  const waited = await waitForIntake(session, cfg.judge.intake_wait_ms);
  if (waited > 0) log(`finalize: ${session} waited ${Math.round(waited / 1000)}s for task intake`);

  const existing = loadJudge(session);
  const headNow = currentHead(cwd);
  const stale = !!existing && receiptPredatesTask(session);
  const alreadyJudged = !!existing && !stale && (!headNow || !existing.head || existing.head === headNow);
  if (existing && stale) log(`finalize: ${session} receipt predates the frozen task; re-judging`);
  else if (existing && !alreadyJudged) log(`finalize: ${session} HEAD moved since the last receipt (${existing.head?.slice(0, 8)} → ${headNow?.slice(0, 8)}); re-judging`);
  if (!alreadyJudged && transcriptPath && fs.existsSync(transcriptPath) && events.some((e) => e.type === 'prompt')) {
    try {
      await judgeSession({ session, cwd, transcriptPath, cfg, llm: makeLlm({ session }), reason: 'session_end' });
    } catch (err) {
      log(`finalize: judge failed: ${String(err)}`);
    }
  }
}
