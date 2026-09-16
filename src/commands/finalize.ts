import fs from 'node:fs';
import path from 'node:path';
import { type Args, flag } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { judgeSession, loadJudge } from '../judge/judge.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import { loadTask } from '../task/intake.js';
import { readEvents } from '../store/events.js';
import { sessionCwd, transcriptPathFor } from '../session.js';
import { historyFile, appendLine, repoKey, sessionDir, log, writeJson, isInternalCwd } from '../paths.js';
import { restoreExperimentConfig, prepareNextArm } from '../experiment/experiment.js';

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

  if (!loadJudge(session) && transcriptPath && fs.existsSync(transcriptPath) && events.some((e) => e.type === 'prompt')) {
    try {
      await judgeSession({ session, cwd, transcriptPath, cfg, llm: makeLlm({ session }), reason: 'session_end' });
    } catch (err) {
      log(`finalize: judge failed: ${String(err)}`);
    }
  }
}
