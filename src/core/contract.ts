/* The Task Contract: the frozen definition of done.

   Tally has frozen acceptance criteria at intake since 0.1 (`task.json`). This module gives that a first-class shape:
   goal, criteria, constraints, verification commands, unknowns, a status that says whether a human has confirmed it,
   and the revision history, so the definition of done cannot drift silently during a session and every later edit is
   on the record. `task.json` stays the stored form; the contract is projected from it and its revisions are kept next
   to it in `contract.json`. */
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../task/intake.js';
import type { CheckSpec } from '../judge/checks.js';
import { sessionDir, readJson, writeJson } from '../paths.js';
import { loadPolicy } from '../policy.js';
import { detectTestCommand } from '../judge/verify.js';

export type ContractStatus = 'needs_confirmation' | 'confirmed';

export interface ContractCriterion {
  id: string;
  text: string;
  /* explicit: from the ticket or the user; inferred: from prompts, branch and commits; policy: from tally.json */
  source: 'explicit' | 'inferred' | 'policy';
  /* how Tally will check it without a model, when it can */
  check?: CheckSpec;
}

export interface ContractRevision {
  ts: string;
  kind: 'created' | 'confirmed' | 'edited' | 'linked' | 'replaced';
  note?: string;
  /* the criteria texts at this revision, so a diff of the definition of done is always reconstructible */
  criteria: string[];
}

export interface TaskContract {
  session: string;
  goal: string;
  source: { kind: Task['source']['kind']; ref: string; url?: string };
  criteria: ContractCriterion[];
  constraints: string[];
  verification: string[];
  unknowns: string[];
  status: ContractStatus;
  frozen_at: string;
  spec_quality: number;
  revisions: ContractRevision[];
}

export function contractFile(session: string): string {
  return path.join(sessionDir(session), 'contract.json');
}

interface StoredContract {
  revisions: ContractRevision[];
  constraints?: string[];
}

function readStored(session: string): StoredContract {
  return readJson<StoredContract>(contractFile(session), { revisions: [] });
}

/* Verification commands: the repo policy's `test_command` first, then the detected runner, then a lint script if the
   package declares one. Only commands Tally would actually run appear here. */
export function verificationCommands(cwd: string | undefined): string[] {
  const out: string[] = [];
  if (!cwd) return out;
  const pol = loadPolicy(cwd).policy;
  if (pol.test_command) out.push(pol.test_command);
  else {
    const det = detectTestCommand(cwd);
    if (det) out.push(det.command);
  }
  try {
    const pj = path.join(cwd, 'package.json');
    if (fs.existsSync(pj)) {
      const scripts = (JSON.parse(fs.readFileSync(pj, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      if (scripts.lint) out.push('npm run lint');
      if (scripts.typecheck) out.push('npm run typecheck');
    }
  } catch {
    /* no manifest */
  }
  return out;
}

export function contractFromTask(task: Task, opts: { cwd?: string } = {}): TaskContract {
  const stored = readStored(task.session);
  const cwd = opts.cwd ?? task.cwd;
  const status: ContractStatus = task.inferred ? (task.confirmed ? 'confirmed' : 'needs_confirmation') : task.needs_clarification && !task.confirmed ? 'needs_confirmation' : 'confirmed';
  const revisions = stored.revisions.length ? stored.revisions : [{ ts: task.created_at, kind: 'created' as const, criteria: task.criteria.map((c) => c.text) }];
  return {
    session: task.session,
    goal: task.title,
    source: { kind: task.source.kind, ref: task.source.ref, url: task.source.url },
    criteria: task.criteria.map((c) => ({ id: c.id, text: c.text, source: c.source, check: c.check })),
    constraints: task.constraints ?? stored.constraints ?? [],
    verification: verificationCommands(cwd),
    unknowns: task.spec_quality.questions,
    status,
    frozen_at: task.created_at,
    spec_quality: task.spec_quality.score,
    revisions,
  };
}

/* Append a revision. Called by intake (created / replaced), confirm and edit. */
export function recordRevision(session: string, kind: ContractRevision['kind'], criteria: string[], note?: string): void {
  const stored = readStored(session);
  stored.revisions.push({ ts: new Date().toISOString(), kind, criteria, note });
  writeJson(contractFile(session), stored);
}

const STATUS_LABEL: Record<ContractStatus, string> = { needs_confirmation: 'NEEDS CONFIRMATION', confirmed: 'CONFIRMED' };

export function renderContract(c: TaskContract): string {
  const L: string[] = [];
  L.push('TASK CONTRACT');
  L.push('');
  L.push('Goal');
  L.push(c.goal);
  if (c.source.url) L.push(`(${c.source.kind}: ${c.source.url})`);
  else if (c.source.kind !== 'text') L.push(`(${c.source.kind}: ${c.source.ref})`);
  L.push('');
  L.push('Acceptance criteria');
  for (const cr of c.criteria) L.push(`[ ] ${cr.id} ${cr.text}${cr.source === 'inferred' ? '  (inferred)' : cr.source === 'policy' ? '  (repo policy)' : ''}${cr.check ? `  [check: ${cr.check.kind}]` : ''}`);
  if (c.constraints.length) {
    L.push('');
    L.push('Constraints');
    for (const x of c.constraints) L.push(`- ${x}`);
  }
  L.push('');
  L.push('Verification');
  if (c.verification.length) for (const v of c.verification) L.push(`- ${v}`);
  else L.push('- (no test command detected; set test_command in tally.json)');
  if (c.unknowns.length) {
    L.push('');
    L.push('Unknowns');
    for (const q of c.unknowns) L.push(`- ${q}`);
  }
  L.push('');
  L.push(`Status: ${STATUS_LABEL[c.status]}${c.status === 'needs_confirmation' ? '  (tally task --confirm, or --edit "<text>")' : ''}  ·  frozen ${c.frozen_at.slice(0, 16).replace('T', ' ')}  ·  spec quality ${c.spec_quality}/10`);
  if (c.revisions.length > 1) {
    L.push('');
    L.push('Revisions');
    for (const r of c.revisions) L.push(`- ${r.ts.slice(0, 16).replace('T', ' ')} ${r.kind}${r.note ? `: ${r.note}` : ''} (${r.criteria.length} criteria)`);
  }
  return L.join('\n');
}
