/* The blind evaluator: a separate model process with fresh context that grades the finished repository against the
   Task Contract and never sees Tally's statuses, verdict, quality score or recommendations. It gets the task text, the
   criteria, the repository path, the base commit and the test command, and may read files and run git and the tests.
   Its answer is compared with Tally's afterwards; disagreements are the evaluation's product. */
import { spawnSync } from 'node:child_process';
import type { GradeStatus } from './ledger.js';

export interface GraderInput {
  taskText: string;
  criteria: Array<{ id: string; text: string }>;
  repoPath: string;
  base: string;
  testCommand: string;
  /* spend and turns the agent used, for the worth-it judgment only */
  agentCost?: number | null;
  agentTurns?: number | null;
}

export interface GraderOutput {
  criteria: Array<{ id: string; status: GradeStatus; evidence: string }>;
  verdict: 'worth it' | 'borderline' | 'not worth it';
  quality_note: string;
  model?: string;
  cost_usd?: number | null;
  duration_s: number;
  raw_error?: string;
}

export const GRADER_SCHEMA = {
  type: 'object',
  properties: {
    criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['met', 'partial', 'unmet', 'unverifiable'] }, evidence: { type: 'string' } }, required: ['id', 'status', 'evidence'] } },
    verdict: { type: 'string', enum: ['worth it', 'borderline', 'not worth it'] },
    quality_note: { type: 'string' },
  },
  required: ['criteria', 'verdict', 'quality_note'],
} as const;

export function graderPrompt(input: GraderInput): string {
  return [
    'You are an independent senior reviewer grading whether a coding agent completed a task. Form your own judgment from the repository only: read the diff since the base commit, read the changed files and tests, run the test command, and probe behaviour with small scripts in the OS temp directory when that is cheap. Do not modify tracked files and do not commit.',
    '',
    `Repository: ${input.repoPath}`,
    `Base commit (the agent's work is everything after this): ${input.base}`,
    `Test command on this machine: ${input.testCommand}`,
    input.agentCost != null ? `The agent spent about $${input.agentCost.toFixed(2)} over ${input.agentTurns ?? '?'} turns.` : '',
    '',
    '# TASK AS THE AGENT RECEIVED IT',
    input.taskText.trim(),
    '',
    '# CRITERIA TO GRADE (grade every one, in order)',
    ...input.criteria.map((c) => `- ${c.id}: ${c.text}`),
    '',
    'Statuses: met (fully satisfied, with evidence you saw), partial (some but not all of it), unmet (not done or wrong), unverifiable (cannot tell from the repository). A green test suite proves only the behaviour it covers; say unverifiable rather than guessing. Verdict: worth it (a maintainer could merge with minor review), borderline (real gaps or doubts, including a fix that belongs elsewhere or changes untested behaviour), not worth it (wrong, incomplete or harmful).',
    'Return only the JSON object.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

export function parseGraderJson(text: string): Omit<GraderOutput, 'duration_s' | 'model' | 'cost_usd'> | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(text.trim()) as Record<string, unknown> | null;
  if (!obj) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) obj = tryParse(text.slice(start, end + 1)) as Record<string, unknown> | null;
  }
  if (!obj || !Array.isArray(obj.criteria)) return null;
  const ok = new Set(['met', 'partial', 'unmet', 'unverifiable']);
  return {
    criteria: (obj.criteria as Array<Record<string, unknown>>).map((c) => ({ id: String(c.id ?? ''), status: ok.has(String(c.status)) ? (String(c.status) as GradeStatus) : 'unverifiable', evidence: String(c.evidence ?? '').slice(0, 600) })),
    verdict: ['worth it', 'borderline', 'not worth it'].includes(String(obj.verdict)) ? (String(obj.verdict) as GraderOutput['verdict']) : 'borderline',
    quality_note: String(obj.quality_note ?? '').slice(0, 800),
  };
}

/* Runs `claude -p` as the grader in a fresh process. Settings sources are cleared so the user's hooks (Tally's
   included) never see the grader as a session, MCP servers are not loaded, and TALLY_INTERNAL marks it internal. */
export function runClaudeGrader(input: GraderInput, opts: { model?: string; bin?: string; timeoutMs?: number } = {}): GraderOutput {
  const started = Date.now();
  const bin = opts.bin ?? process.env.CLAUDE_BIN ?? 'claude';
  const args = ['-p', graderPrompt(input), '--output-format', 'json', '--json-schema', JSON.stringify(GRADER_SCHEMA), '--model', opts.model ?? 'opus', '--setting-sources', '', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--max-turns', '40', '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git *)', 'Bash(npm test*)', 'Bash(npm run*)', 'Bash(npx *)', 'Bash(node *)', 'Bash(ls*)', 'Bash(cat *)', 'Bash(python*)', 'Bash(pytest*)', 'Bash(go *)', 'Bash(cargo *)', '--add-dir', input.repoPath];
  const r = spawnSync(bin, args, { cwd: input.repoPath, encoding: 'utf8', env: { ...process.env, TALLY_INTERNAL: '1' }, timeout: opts.timeoutMs ?? 20 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  const duration_s = Math.round((Date.now() - started) / 1000);
  let envelope: { result?: string; structured_output?: unknown; total_cost_usd?: number; modelUsage?: Record<string, unknown>; is_error?: boolean } = {};
  try {
    envelope = JSON.parse(r.stdout || '{}');
  } catch {
    envelope = {};
  }
  const parsed = (envelope.structured_output && typeof envelope.structured_output === 'object' ? (envelope.structured_output as Record<string, unknown>) : null) ? parseGraderJson(JSON.stringify(envelope.structured_output)) : parseGraderJson(String(envelope.result ?? r.stdout ?? ''));
  /* the envelope lists every model that ran (a small model may summarise); the grader is the one that spent the most */
  const usage = envelope.modelUsage as Record<string, { costUSD?: number }> | undefined;
  const model = usage ? Object.entries(usage).sort((a, b) => (b[1]?.costUSD ?? 0) - (a[1]?.costUSD ?? 0))[0]?.[0] ?? opts.model : opts.model;
  if (!parsed) return { criteria: [], verdict: 'borderline', quality_note: '', model, cost_usd: envelope.total_cost_usd ?? null, duration_s, raw_error: `grader returned no parsable JSON (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 300)}` };
  return { ...parsed, model, cost_usd: envelope.total_cost_usd ?? null, duration_s };
}
