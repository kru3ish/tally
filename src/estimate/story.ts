/* Recording a finished story: the cost check, one line in the repo's ledger, the story metrics to the organisation's
   OpenTelemetry collector when one is configured, and the dashboard. Called at session end and by `tally cost --record`. */
import path from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { log, packageRoot, readJson } from '../paths.js';
import { loadTask } from '../task/intake.js';
import { readUndoLog } from '../coach/undo.js';
import { computeCheck, type CostCheck } from './variance.js';
import { entryFromCheck, readLedger, recordStory, repoRoot, ledgerFile, type LedgerEntry } from './ledger.js';
import { claudeSettingsEnv, exportStory, otlpTarget, repoSetsTallyOtel } from '../telemetry/otlp.js';
import { renderDashboard } from './dashboard.js';
import { dashboardPath, writeAndOpen } from './open.js';

export function storyMeta(session: string): { key?: string; url?: string; story_points?: number } {
  const task = loadTask(session);
  if (!task) return {};
  const s = task.source;
  const key = s.key ?? (s.number ? `#${s.number}` : undefined);
  return { ...(key ? { key } : {}), ...(s.url ? { url: s.url } : {}), ...(task.estimate.story_points ? { story_points: task.estimate.story_points } : {}) };
}

export function repoName(cwd: string): string {
  return path.basename(repoRoot(cwd) ?? cwd);
}

export function openDashboard(cwd: string, opts: { current?: CostCheck; estimate?: { story: string; estimate: import('./estimate.js').CostEstimate }; open: boolean }): { file: string; opened: boolean } {
  const root = repoRoot(cwd);
  const html = renderDashboard({ repo: repoName(cwd), entries: readLedger(cwd), current: opts.current, estimate: opts.estimate, ledgerPath: root ? path.relative(root, ledgerFile(root)) : undefined });
  return writeAndOpen(html, dashboardPath(repoName(cwd)), opts.open);
}

export async function recordFinishedStory(session: string, cwd: string, opts: { cfg?: Config; agent?: string; open?: boolean; check?: CostCheck } = {}): Promise<{ check: CostCheck; entry: LedgerEntry; ledger?: string; otel?: string; dashboard?: string }> {
  const cfg = opts.cfg ?? loadConfig();
  const check = opts.check ?? computeCheck(session, { baselineTokens: cfg.baseline_context_tokens });
  const applied = [...new Set(readUndoLog().filter((u) => u.session === session && !u.undone && u.rule.startsWith('fix:')).map((u) => u.rule.slice(4)))];
  const entry = entryFromCheck(check, { agent: opts.agent, ...storyMeta(session), fixes_applied: applied });
  const out: { check: CostCheck; entry: LedgerEntry; ledger?: string; otel?: string; dashboard?: string } = { check, entry };
  if (cfg.cost.ledger && check.actual_usd > 0) out.ledger = recordStory(check.cwd ?? cwd, entry);
  const root = repoRoot(cwd) ?? cwd;
  const target = otlpTarget(process.env, cfg.cost.otel_endpoint, claudeSettingsEnv(), { repoSetsTally: repoSetsTallyOtel(root) });
  if (target) {
    const r = await exportStory(entry, { repo: repoName(cwd), version: readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? '0.0.0', target });
    out.otel = r.ok ? `sent to ${target.url}` : `failed (${r.status ?? r.error}) sending to ${target.url}`;
    log(`story metrics: ${out.otel}`);
  }
  if (opts.open !== undefined) out.dashboard = openDashboard(cwd, { current: check, open: opts.open }).file;
  return out;
}
