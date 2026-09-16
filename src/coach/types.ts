import type { Config } from '../config.js';
import type { TallyEvent } from '../store/events.js';
import type { Transcript } from '../transcript/parse.js';
import type { Task } from '../task/intake.js';

export type Severity = 'info' | 'warn' | 'critical';

export type Action =
  | { kind: 'write_md'; file: string; content: string; mode: 'append' | 'create' | 'replace'; label: string }
  | { kind: 'inject'; note: string; label: string }
  | { kind: 'snippet'; label: string; snippet: string; where: string }
  | { kind: 'settings'; label: string; file: string; patch: Record<string, unknown>; snippet: string }
  | { kind: 'consent'; label: string; command: string }
  | { kind: 'none'; label: string };

export interface Suggestion {
  rule: string;
  key: string;
  severity: Severity;
  title: string;
  message: string;
  usd_saved: number;
  action: Action;
  inject_note?: string;
  ts?: string;
}

export interface HistoryEntry {
  ts?: string;
  kind?: string;
  session?: string;
  repo?: string;
  loaded?: { mcp: string[]; skills: string[]; plugins: string[] };
  used?: { skills: string[]; mcp: string[] };
  first_turn_tokens?: number;
  cost_usd?: number;
  task_title?: string;
  verdict?: string;
  final_status?: string;
  final_verdict?: string;
  recommendations?: string[];
  completion_pct?: number;
  roi?: number | null;
  per_criterion_usd?: number | null;
  waste_usd?: number;
  skills?: string[];
  mcp?: string[];
  linked?: boolean;
  spec_quality?: number;
  prompts?: string[];
  internal?: boolean;
  tally_own_usd?: number;
  tally_share_pct?: number;
  cost_confidence?: 'full' | 'partial';
}

export interface RuleContext {
  session: string;
  cwd: string;
  now: Date;
  cfg: Config;
  events: TallyEvent[];
  transcript?: Transcript;
  task?: Task | null;
  history: HistoryEntry[];
  claudeMd?: string | null;
  avgTurnCostUsd: number;
  contextTokensNow: number;
  contextWindow: number;
  spendUsd: number;
  loaded: { mcp: string[]; skills: string[]; plugins: string[] };
}

export interface Rule {
  id: string;
  describe: string;
  evaluate(ctx: RuleContext): Suggestion[];
}
