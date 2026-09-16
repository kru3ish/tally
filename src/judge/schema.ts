import { z } from 'zod';

export const CriterionStatus = z.enum(['met', 'partial', 'unmet', 'unverifiable']);

const UsageZ = z.object({ input: z.number(), output: z.number(), cache_write: z.number(), cache_write_1h: z.number().optional(), cache_read: z.number() });
const Bucket = z.object({ usd: z.number(), messages: z.number(), tokens: z.number() });

export const JudgeSchema = z.object({
  version: z.literal(1),
  session: z.string(),
  cwd: z.string().optional(),
  judged_at: z.string(),
  reason: z.enum(['push', 'pr', 'merge', 'publish', 'session_end', 'manual']),
  task: z.object({
    title: z.string(),
    source: z.object({ kind: z.string(), url: z.string().optional(), ref: z.string() }),
    spec_quality: z.number(),
    estimate_hours: z.number(),
    budget_usd: z.number(),
    linked: z.boolean(),
  }),
  head: z.string().optional(),
  historical: z.object({ start_head: z.string().optional(), end_head: z.string().optional(), notes: z.array(z.string()) }).optional(),
  criteria: z.array(z.object({ id: z.string(), text: z.string(), status: CriterionStatus, evidence: z.string(), files: z.array(z.string()), resolved_by: z.enum(['tier0', 'tier1', 'tier2', 'rule']).default('tier2'), confidence: z.number().min(0).max(1).optional() })),
  tiers: z
    .object({
      ran: z.array(z.enum(['tier0', 'tier1', 'tier2'])),
      reason: z.string(),
      mechanical: z.number(),
      judgment: z.number(),
      calls: z.array(z.object({ tier: z.enum(['tier1', 'tier2']), model: z.string(), cost_usd: z.number(), criteria: z.array(z.string()), prompt_tokens: z.number() })),
      llm_cost_usd: z.number(),
      tier1_pack: z.object({ tokens: z.number(), truncated: z.boolean() }).optional(),
    })
    .default({ ran: ['tier2'], reason: 'legacy receipt', mechanical: 0, judgment: 0, calls: [], llm_cost_usd: 0 }),
  completion_pct: z.number().min(0).max(100),
  counts: z.object({ met: z.number(), partial: z.number(), unmet: z.number(), unverifiable: z.number() }),
  quality: z.object({ score: z.number().min(0).max(10), reason: z.string() }),
  verification: z.object({
    ran: z.boolean(),
    command: z.string().optional(),
    basis: z.string().optional(),
    passed: z.boolean().optional(),
    exit_code: z.number().nullable().optional(),
    timed_out: z.boolean().optional(),
    duration_ms: z.number().optional(),
    output_tail: z.string().optional(),
    reason: z.string().optional(),
    env_scrubbed: z.boolean().optional(),
    consent: z.boolean().optional(),
  }),
  evidence: z.object({
    files_changed: z.array(z.string()),
    edited_files: z.array(z.string()),
    diff_stat: z.string(),
    insertions: z.number(),
    deletions: z.number(),
    base_head: z.string().optional(),
    current_head: z.string().optional(),
    branch: z.string().optional(),
    git_error: z.string().optional(),
    command_runs: z.array(z.object({ command: z.string(), kind: z.enum(['test', 'lint']), passed: z.boolean(), ts: z.string() })),
    ship_events: z.array(z.object({ kind: z.string(), command: z.string(), url: z.string().optional(), ts: z.string() })),
    final_message: z.string(),
    tool_calls: z.number(),
  }),
  cost: z.object({
    label: z.literal('API-equivalent'),
    confidence: z.enum(['full', 'partial']),
    format: z.object({ version: z.string().optional(), known: z.boolean(), total_lines: z.number(), unparseable_lines: z.number(), unknown_types: z.array(z.string()) }),
    tally_share_pct: z.number(),
    otel: z.object({ available: z.boolean(), total_usd: z.number().optional(), delta_usd: z.number().optional(), note: z.string().optional() }).optional(),
    total_usd: z.number(),
    usage: UsageZ,
    by_phase: z.record(Bucket),
    by_subagent: z.record(Bucket),
    by_model: z.record(Bucket),
    per_completed_criterion_usd: z.number().nullable(),
    budget_usd: z.number(),
    budget_used_pct: z.number(),
    tally_own_usd: z.number(),
    models: z.array(z.string()),
  }),
  waste: z.object({
    total_usd: z.number(),
    failed_loops: z.array(z.object({ command: z.string(), repeats: z.number(), usd: z.number() })),
    repeated_reads: z.array(z.object({ file: z.string(), reads: z.number(), usd: z.number() })),
    dead_weight: z.object({ first_turn_tokens: z.number(), baseline_tokens: z.number(), overhead_tokens: z.number(), usd: z.number() }),
    compaction_churn: z.object({ compactions: z.number(), recache_tokens: z.number(), usd: z.number() }),
  }),
  value: z.object({
    estimate_hours: z.number(),
    hourly_rate: z.number(),
    human_value_usd: z.number(),
    credited_value_usd: z.number(),
    roi_multiple: z.number().nullable(),
  }),
  attribution: z.object({
    label: z.literal('correlational'),
    note: z.string(),
    rows: z.array(z.object({ kind: z.enum(['skill', 'mcp']), name: z.string(), invocations: z.number(), errors: z.number(), tokens: z.number(), usd: z.number(), touched_met_criteria: z.boolean().nullable() })),
  }),
  verdict: z.object({ verdict: z.enum(['worth it', 'borderline', 'not worth it']), reason: z.string() }),
  recommendations: z.array(z.string()).max(3),
  judge_model: z.string(),
  followup: z
    .object({
      checked_at: z.string(),
      final_status: z.enum(['held up', 'needed rework', 'reverted', 'unknown']),
      final_verdict: z.enum(['worth it', 'borderline', 'not worth it']),
      original_verdict: z.enum(['worth it', 'borderline', 'not worth it']),
      pr_state: z.string().optional(),
      merged: z.boolean().optional(),
      reverted: z.boolean().optional(),
      revert_commit: z.string().optional(),
      issue_reopened: z.boolean().optional(),
      review_comments: z.number().optional(),
      change_requests: z.number().optional(),
      ci_failed_after_merge: z.boolean().optional(),
      gh_skipped: z.boolean().optional(),
      notes: z.array(z.string()),
    })
    .optional(),
});

export type Judge = z.infer<typeof JudgeSchema>;
export type Verdict = Judge['verdict']['verdict'];
