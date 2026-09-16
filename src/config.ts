import { z } from 'zod';
import { configFile, readJson, writeJson, repoKey } from './paths.js';

export const ConfigSchema = z.object({
  hourly_rate: z.number().positive().default(75),
  writeback: z.boolean().default(false),
  auto_apply: z.enum(['off', 'ask', 'auto']).default('ask'),
  models: z
    .object({
      judge: z.string().default('opus'),
      tier1: z.string().default('haiku'),
      tier2_escalation: z.string().default('sonnet'),
      coach: z.string().default('haiku'),
      intake: z.string().default('haiku'),
    })
    .default({}),
  context_window: z.number().int().positive().default(200000),
  baseline_context_tokens: z.number().int().nonnegative().default(15000),
  coach: z
    .object({
      min_interval_s: z.number().nonnegative().default(180),
      max_per_session: z.number().int().positive().default(8),
      llm_interval_s: z.number().nonnegative().default(90),
      llm_min_session_usd: z.number().nonnegative().default(1),
      auto_mute_after_skips: z.number().int().positive().default(3),
      context_warn_pct: z.number().default(70),
      context_critical_pct: z.number().default(85),
    })
    .default({}),
  judge: z
    .object({
      test_timeout_ms: z.number().int().positive().default(300000),
      run_tests: z.boolean().default(true),
      deepThreshold: z.number().nonnegative().default(3),
      tier1_confidence_floor: z.number().min(0).max(1).default(0.6),
      tier1_evidence_tokens: z.number().int().positive().default(6000),
      tier2_escalation_tokens: z.number().int().positive().default(3000),
      /* below this session cost an escalation re-check runs on the small model (a claude -p call has a ~5.6k-token floor,
         so a sonnet escalation alone is ~5% of a $0.50 session); from here to deepThreshold it uses models.tier2_escalation */
      escalation_model_from_usd: z.number().nonnegative().default(1),
    })
    .default({}),
  followup_days: z.number().int().positive().default(7),
  dead_weight_sessions: z.number().int().positive().default(5),
  jira: z
    .object({
      base_url: z.string().optional(),
      email: z.string().optional(),
      api_token: z.string().optional(),
    })
    .default({}),
  linear: z.object({ api_key: z.string().optional() }).default({}),
  consent: z.object({ test_rerun: z.record(z.boolean()).default({}) }).default({}),
});

export function testRerunConsent(cfg: Config, cwd: string): boolean | undefined {
  return cfg.consent.test_rerun[repoKey(cwd)];
}

export function setTestRerunConsent(cwd: string, value: boolean): Config {
  return saveConfig({ consent: { test_rerun: { [repoKey(cwd)]: value } } });
}

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = readJson<unknown>(configFile(), {});
  const parsed = ConfigSchema.safeParse(raw);
  const cfg = parsed.success ? parsed.data : ConfigSchema.parse({});
  cfg.jira.base_url ??= process.env.JIRA_BASE_URL;
  cfg.jira.email ??= process.env.JIRA_EMAIL;
  cfg.jira.api_token ??= process.env.JIRA_API_TOKEN;
  cfg.linear.api_key ??= process.env.LINEAR_API_KEY;
  return cfg;
}

export function saveConfig(patch: Record<string, unknown>): Config {
  const current = readJson<Record<string, unknown>>(configFile(), {});
  const merged = ConfigSchema.parse(deepMerge(current, patch));
  const toWrite = structuredClone(merged) as Record<string, unknown>;
  delete toWrite.jira;
  delete toWrite.linear;
  writeJson(configFile(), toWrite);
  return merged;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
