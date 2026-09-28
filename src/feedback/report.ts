/* The wrong-verdict report: a sanitized bundle a person can paste into an issue. It carries the shape of the
   verification (statuses, evidence kinds, counts, which tier decided, how the independent run went) and nothing of the
   work: no code, no prompts, no diff, no repository name or URL, no file paths, no environment, no terminal output.
   Everything included is scanned for secrets; a hit blocks the report and names what was found. */
import os from 'node:os';
import { loadJudge } from '../judge/judge.js';
import { loadTask } from '../task/intake.js';
import { buildAssurance, statusFromJudge } from '../assurance/index.js';
import { readFeedback, type FeedbackEntry } from './store.js';
import { agentOfSession } from '../commands/verify.js';

export interface WrongVerdictReport {
  schema: 'tally.wrong-verdict.v1';
  tally_version: string;
  platform: string;
  node: string;
  agent: { product: string; model_family?: string; provider?: string };
  criterion: {
    id: string;
    /* position and count only; the criterion text is not included */
    index: number;
    of: number;
    judge_status: string;
    assurance: string;
    resolved_by: string;
    confidence?: number;
    /* kinds of evidence on the Evidence Map, with pass/fail, never their content */
    evidence: Array<{ kind: string; strength: string; ok?: boolean }>;
    disputed: boolean;
  };
  feedback: { label: string; false_verified: boolean; comment_included: boolean; comment?: string };
  receipt: {
    statuses: Record<string, number>;
    assurance: Record<string, number>;
    tiers_ran: string[];
    verdict: string;
    completion_pct: number;
    spec_capped?: boolean;
    review_capped?: boolean;
  };
  verification: {
    ran: boolean;
    passed?: boolean;
    inconclusive?: boolean;
    tests_green?: boolean;
    at_base_passed?: boolean;
    failure_attributable?: boolean;
    summary?: { passed: number | null; failed: number | null };
    preexisting_test_files: number | null;
    agent_test_files_added: number;
    agent_test_cases_added: number;
    runner: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pytest' | 'go' | 'cargo' | 'make' | 'other' | 'none';
  };
  task: { source: string; criteria: number; spec_quality?: number };
  excluded: string[];
}

const EXCLUDED = ['source code', 'prompts', 'diffs', 'repository URL or name', 'file paths', 'environment variables', 'terminal output', 'criterion text', 'evidence text'];

function runnerKind(command?: string): WrongVerdictReport['verification']['runner'] {
  if (!command) return 'none';
  const m = /^(npm|pnpm|yarn|bun)\b/.exec(command.trim());
  if (m) return m[1] as 'npm' | 'pnpm' | 'yarn' | 'bun';
  if (/pytest/.test(command)) return 'pytest';
  if (/^go test/.test(command)) return 'go';
  if (/^cargo test/.test(command)) return 'cargo';
  if (/^make/.test(command)) return 'make';
  return 'other';
}

export function buildWrongVerdictReport(session: string, criterion: string, opts: { version: string; includeComment?: boolean; cwd?: string }): WrongVerdictReport {
  const j = loadJudge(session);
  if (!j) throw new Error(`no receipt for session ${session}`);
  const idx = j.criteria.findIndex((c) => c.id === criterion);
  if (idx < 0) throw new Error(`no criterion ${criterion} on this receipt (${j.criteria.map((x) => x.id).join(', ')})`);
  const c = j.criteria[idx]!;
  const a = j.assurance ?? buildAssurance({ judge: j, task: loadTask(session), cwd: opts.cwd ?? j.cwd ?? process.cwd() });
  const ac = a.criteria.find((x) => x.id === criterion);
  const fb = readFeedback(session).filter((f) => f.criterion === criterion).sort((x, y) => y.ts.localeCompare(x.ts))[0] as FeedbackEntry | undefined;
  const statuses: Record<string, number> = {};
  for (const x of j.criteria) statuses[x.override?.status ?? x.status] = (statuses[x.override?.status ?? x.status] ?? 0) + 1;
  const assurance: Record<string, number> = {};
  for (const x of a.criteria) assurance[x.status] = (assurance[x.status] ?? 0) + 1;
  const agent = agentOfSession(session);
  const task = loadTask(session);
  return {
    schema: 'tally.wrong-verdict.v1',
    tally_version: opts.version,
    platform: `${process.platform} ${os.release()}`,
    node: process.versions.node,
    agent: { product: agent.product, model_family: a.model?.family, provider: a.model?.provider },
    criterion: {
      id: criterion,
      index: idx + 1,
      of: j.criteria.length,
      judge_status: c.override?.status ?? c.status,
      assurance: ac?.status ?? statusFromJudge(c),
      resolved_by: c.resolved_by,
      confidence: c.confidence,
      evidence: (ac?.evidence ?? []).map((e) => ({ kind: e.kind, strength: e.strength, ...(e.ok !== undefined ? { ok: e.ok } : {}) })),
      disputed: !!c.override,
    },
    feedback: { label: fb?.label ?? 'wrong', false_verified: (ac?.status ?? statusFromJudge(c)) === 'VERIFIED', comment_included: !!(opts.includeComment && fb?.comment), ...(opts.includeComment && fb?.comment ? { comment: fb.comment } : {}) },
    receipt: {
      statuses,
      assurance,
      tiers_ran: j.tiers?.ran ?? [],
      verdict: j.verdict.verdict,
      completion_pct: j.completion_pct,
      spec_capped: j.task.spec_capped,
      review_capped: j.review?.ran ? j.review.merge === 'request_changes' : undefined,
    },
    verification: {
      ran: j.verification.ran,
      passed: j.verification.passed,
      inconclusive: j.verification.inconclusive,
      tests_green: j.verification.tests_green,
      at_base_passed: j.verification.at_base?.passed,
      failure_attributable: j.verification.failure_attributable,
      summary: j.verification.summary,
      preexisting_test_files: a.verification.preexisting_files,
      agent_test_files_added: a.verification.agent_created.added_files.length,
      agent_test_cases_added: a.verification.agent_created.cases_added,
      runner: runnerKind(j.verification.command),
    },
    task: { source: j.task.task_source ?? 'unknown', criteria: j.criteria.length, spec_quality: task?.spec_quality?.score },
    excluded: EXCLUDED,
  };
}

/* secret scan over the serialized payload: anything that looks like a credential, a private key, an internal URL or an
   email address blocks the report. The comment is the only free text, so this mostly guards the comment. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['API key (sk-…)', /\bsk-[A-Za-z0-9]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Linear API key', /\blin_api_[A-Za-z0-9]{10,}/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['password or secret assignment', /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[=:]\s*["']?[^\s"'&,;]{6,}/i],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['URL', /\bhttps?:\/\/[^\s"')]+/i],
  ['internal hostname', /\b[a-z0-9-]+\.(internal|local|corp|lan|intranet)\b/i],
  ['absolute file path', /(?:^|[\s"'(])(?:[A-Za-z]:\\|\/(?:Users|home|opt|srv|var|etc)\/)[^\s"')]*/],
];

export function scanForSecrets(payload: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of SECRET_PATTERNS) if (re.test(payload)) hits.push(name);
  return hits;
}

/* the GitHub "new issue" URL with the template and a pre-filled title and body; the body is the payload as a code block */
export function issueUrl(report: WrongVerdictReport, repo = 'kru3ish/tally'): string {
  const title = `${report.feedback.false_verified ? '[false VERIFIED] ' : ''}Wrong verdict: ${report.criterion.assurance} on a criterion resolved by ${report.criterion.resolved_by}`;
  const body = ['<!-- generated by `tally feedback wrong --report`; nothing below identifies the repository, the code or the prompt -->', '', '```json', JSON.stringify(report, null, 2), '```', '', '**What was actually true** (your words):', ''].join('\n');
  const labels = report.feedback.false_verified ? 'wrong-verdict,false-verified' : 'wrong-verdict';
  return `https://github.com/${repo}/issues/new?template=wrong_verdict.md&labels=${encodeURIComponent(labels)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
