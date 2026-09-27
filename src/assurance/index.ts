/* The Assurance Engine: what can Tally prove about this task?

   For every criterion of the Task Contract it builds an Evidence Map: traceable items (a changed file, a diff hunk, a
   test the agent added, an independent run, a command result, a git ref, a model's judgment) and the status they
   support. Deterministic evidence comes first and is never overwritten by a model; a model's judgment is one item in the
   map, labelled `interpreted`, and on its own it can lift a criterion no higher than SUPPORTED.

     VERIFIED    deterministic evidence directly demonstrates the criterion
     SUPPORTED   evidence supports it but needs interpretation or is incomplete
     UNVERIFIED  not enough evidence to say
     UNMET       evidence shows it was not done

   The engine reads the receipt (judge.json), the Task Contract and git; it never branches on which agent did the work. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Judge } from '../judge/schema.js';
import type { Task } from '../task/intake.js';

/* a dispute override wins over the judge's call (same rule as the Judge; duplicated to keep this module free of judge.ts) */
function effectiveStatus(c: { status: 'met' | 'partial' | 'unmet' | 'unverifiable'; override?: { status: 'met' | 'partial' | 'unmet' | 'unverifiable' } }): 'met' | 'partial' | 'unmet' | 'unverifiable' {
  return c.override?.status ?? c.status;
}
import type { AgentIdentity, ModelIdentity } from '../core/events.js';
import { modelIdentity } from '../core/events.js';

export type AssuranceStatus = 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED' | 'UNMET';

export type EvidenceKind = 'file_check' | 'file_changed' | 'diff_hunk' | 'test_added' | 'test_modified' | 'test_names_it' | 'independent_run' | 'agent_test_run' | 'command' | 'model_judgment' | 'dispute';

export interface EvidenceItem {
  kind: EvidenceKind;
  /* deterministic: a fact Tally observed or produced; interpreted: a model's reading of the evidence */
  strength: 'deterministic' | 'interpreted';
  summary: string;
  /* what to open: a file path, a hunk header, a command, a test file */
  ref?: string;
  /* for runs and checks: did it pass */
  ok?: boolean;
  confidence?: number;
}

export interface CriterionAssurance {
  id: string;
  text: string;
  status: AssuranceStatus;
  /* what decided the status */
  basis: 'deterministic' | 'deterministic+model' | 'model' | 'none';
  evidence: EvidenceItem[];
  /* the receipt's own status, kept so the mapping is auditable */
  judge_status: 'met' | 'partial' | 'unmet' | 'unverifiable';
  resolved_by: 'tier0' | 'tier1' | 'tier2' | 'rule';
  disputed?: boolean;
}

export interface TestProvenance {
  /* test files present at the session's base commit (git ls-tree), or null when there is no tree */
  preexisting_files: number | null;
  /* test files the agent added or modified (git diff base..HEAD), and test cases it added (added `it(`/`test(`/`def test_` lines) */
  agent_created: { added_files: string[]; modified_files: string[]; cases_added: number };
  /* the run Tally made itself */
  independent: { ran: boolean; command?: string; passed?: boolean; total_passed: number | null; reason?: string };
  /* test commands the agent ran during the session, from the event stream */
  agent_runs: Array<{ command: string; passed: boolean }>;
  note: string;
}

export interface Assurance {
  schema: 'tally.verify.v1';
  session: string;
  generated_at: string;
  task: { goal: string; source: string; url?: string; status: 'needs_confirmation' | 'confirmed' | 'none' };
  agent: AgentIdentity;
  model?: ModelIdentity;
  criteria: CriterionAssurance[];
  verification: TestProvenance;
  scope: { named_in_contract: string[]; touched_areas: string[]; unnamed_areas: string[]; note: string };
  summary: { verified: number; supported: number; unverified: number; unmet: number; total: number; sufficient: number };
  /* the receipt's model-assisted figures, kept available but labelled */
  experimental: { verdict: string; completion_pct: number; quality: number; roi: number | null; note: string };
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)tests?\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Test\.(java|kt|cs)$/i;
const TEST_CASE_RE = /^\+\s*(it|test|describe\.each|test\.each)\s*\(|^\+\s*def test_|^\+\s*func Test|^\+\s*#\[test\]|^\+\s*@Test\b/m;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/* Words a criterion is about: identifiers, numbers, paths, quoted strings; used to find the diff hunks that touch them. */
export function criterionKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)) out.add((m[1] ?? m[2] ?? m[3] ?? '').trim());
  for (const m of text.matchAll(/\b[\w./-]+\.[a-z]{1,5}\b/gi)) out.add(m[0]);
  for (const m of text.matchAll(/\b\d{2,}\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]+\b|\b[A-Z][A-Z_]{2,}\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/--?[a-z][\w-]+/g)) out.add(m[0]);
  return [...out].filter((k) => k.length >= 3).slice(0, 12);
}

export function isTestCriterionText(text: string): boolean {
  return /\b(test|tests|tested|spec|coverage|regression test|assert)/i.test(text);
}

/* Hunks whose header or added lines mention one of the keywords: `file@@header` refs. */
function matchingHunks(diff: string, keywords: string[]): Array<{ file: string; header: string; keyword: string }> {
  const hits: Array<{ file: string; header: string; keyword: string }> = [];
  if (!diff || !keywords.length) return hits;
  let file = '';
  let header = '';
  let body: string[] = [];
  const flush = (): void => {
    if (!header) return;
    const added = body.filter((l) => l.startsWith('+')).join('\n');
    for (const k of keywords) {
      if (added.includes(k) || header.includes(k)) {
        hits.push({ file, header, keyword: k });
        break;
      }
    }
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush();
      const m = / b\/(.+)$/.exec(line);
      file = m?.[1] ?? '';
      header = '';
      body = [];
    } else if (line.startsWith('@@')) {
      flush();
      header = line.slice(0, 80);
      body = [];
    } else if (header) body.push(line);
  }
  flush();
  return hits.slice(0, 6);
}

export function testProvenance(opts: { cwd: string; baseHead?: string; judge: Judge; diff?: string }): TestProvenance {
  const { cwd, baseHead, judge } = opts;
  let preexisting: number | null = null;
  const added: string[] = [];
  const modified: string[] = [];
  let casesAdded = 0;
  if (baseHead) {
    const tree = git(cwd, ['ls-tree', '-r', '--name-only', baseHead]);
    if (tree !== null) preexisting = tree.split('\n').filter((f) => f && TEST_PATH_RE.test(f)).length;
    /* base → working tree, so uncommitted work counts; untracked new test files too */
    const status = git(cwd, ['diff', '--name-status', baseHead, '--']);
    if (status !== null) {
      for (const line of status.split('\n')) {
        const [st, ...rest] = line.split('\t');
        const f = rest[rest.length - 1] ?? '';
        if (!f || !TEST_PATH_RE.test(f)) continue;
        if (st?.startsWith('A')) added.push(f);
        else if (st?.startsWith('M') || st?.startsWith('R')) modified.push(f);
      }
    }
    const untrackedList = (git(cwd, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
    for (const f of untrackedList) if (TEST_PATH_RE.test(f) && !added.includes(f)) added.push(f);
    const diff = opts.diff ?? git(cwd, ['diff', baseHead, '--']) ?? '';
    /* count added test cases only inside test files */
    let inTestFile = false;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git')) inTestFile = TEST_PATH_RE.test(line);
      else if (inTestFile && TEST_CASE_RE.test(line)) casesAdded += 1;
    }
    for (const f of added) {
      if (!untrackedList.includes(f)) continue;
      try {
        casesAdded += (fs.readFileSync(path.join(cwd, f), 'utf8').match(/^\s*(it|test)\s*\(|^\s*def test_|^\s*func Test/gm) ?? []).length;
      } catch {
        /* unreadable */
      }
    }
  }
  const v = judge.verification;
  const totalPassed = v.ran ? parsePassedCount(v.output_tail ?? '') : null;
  const agentRuns = judge.evidence.command_runs.filter((c) => c.kind === 'test').map((c) => ({ command: c.command, passed: c.passed }));
  const notes: string[] = [];
  if (preexisting === null) notes.push('no git tree for the session base, so pre-existing tests could not be counted');
  if (v.ran && totalPassed === null) notes.push('the runner output did not state a passed count');
  if (!v.ran) notes.push(`independent run not made: ${v.reason ?? 'unknown'}`);
  if (added.length || modified.length) notes.push('a green test written by the same agent that wrote the code is weaker evidence than a pre-existing one');
  return { preexisting_files: preexisting, agent_created: { added_files: added, modified_files: modified, cases_added: casesAdded }, independent: { ran: v.ran, command: v.command, passed: v.passed, total_passed: totalPassed, reason: v.reason }, agent_runs: agentRuns, note: notes.join('; ') };
}

export function parsePassedCount(output: string): number | null {
  const pats = [/(\d+)\s+passing/, /ℹ pass\s+(\d+)/, /#\s*pass\s+(\d+)/, /Tests:\s+(\d+) passed/, /(\d+) passed/, /ok\s+\d+\s+\S+\s+[\d.]+s/];
  for (const p of pats) {
    const m = p.exec(output);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

function area(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/');
  if (parts.length === 1) return '(root)';
  return parts.length > 2 && /^(src|lib|app|packages|pkg|internal|cmd)$/.test(parts[0]!) ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/* Test files in the working tree that mention a keyword: a pre-existing test that names the behaviour is evidence too,
   as long as the suite actually ran. Bounded so a large repo cannot stall a receipt. */
function testFilesNaming(cwd: string, keywords: string[], cache: Map<string, string>): Array<{ file: string; keyword: string }> {
  if (!keywords.length) return [];
  if (!cache.size) {
    const files = (git(cwd, ['ls-files']) ?? '').split('\n').filter((f) => f && TEST_PATH_RE.test(f)).slice(0, 200);
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(cwd, f));
        if (st.size <= 200 * 1024) cache.set(f, fs.readFileSync(path.join(cwd, f), 'utf8'));
      } catch {
        /* skip */
      }
    }
    if (!cache.size) cache.set('', '');
  }
  const hits: Array<{ file: string; keyword: string }> = [];
  for (const [f, body] of cache) {
    if (!f) continue;
    const k = keywords.find((kw) => body.includes(kw));
    if (k) hits.push({ file: f, keyword: k });
  }
  return hits.slice(0, 4);
}

export function buildAssurance(opts: { judge: Judge; task: Task | null; cwd: string; agent?: AgentIdentity; diff?: string }): Assurance {
  const { judge: j, task, cwd } = opts;
  const testCache = new Map<string, string>();
  const baseHead = j.evidence.base_head;
  const diff = opts.diff ?? (baseHead ? git(cwd, ['diff', baseHead, '--']) ?? '' : '');
  const provenance = testProvenance({ cwd, baseHead, judge: j, diff });
  const changed = new Set(j.evidence.files_changed.map((f) => f.replace(/\\/g, '/')));
  const testFilesTouched = [...provenance.agent_created.added_files, ...provenance.agent_created.modified_files];

  const criteria: CriterionAssurance[] = j.criteria.map((c) => {
    const eff = effectiveStatus(c);
    const items: EvidenceItem[] = [];
    const keywords = criterionKeywords(c.text);
    const aboutTests = isTestCriterionText(c.text);

    /* deterministic: the check that resolved it at tier 0 */
    if (c.resolved_by === 'tier0') items.push({ kind: 'file_check', strength: 'deterministic', summary: c.evidence, ok: c.status === 'met' });
    /* deterministic: files the receipt cites that really are in the diff, and files the criterion names */
    const cited = new Set([...c.files, ...keywords.filter((k) => /\.[a-z]{1,5}$/i.test(k))].map((f) => f.replace(/\\/g, '/')));
    for (const f of cited) {
      const hit = [...changed].find((x) => x === f || x.endsWith('/' + f) || f.endsWith('/' + x));
      if (hit) items.push({ kind: 'file_changed', strength: 'deterministic', summary: `${hit} changed`, ref: hit, ok: true });
    }
    /* deterministic: diff hunks that mention what the criterion is about; a hunk inside a test file is a test that names
       the behaviour, which together with a green independent run is the strongest evidence short of running it ourselves */
    const hunks = matchingHunks(diff, keywords);
    for (const h of hunks) items.push({ kind: 'diff_hunk', strength: 'deterministic', summary: `${h.file} ${h.header.split('@@')[1]?.trim() ?? ''} mentions ${h.keyword}`, ref: `${h.file}${h.header}`, ok: true });
    let testHunkNamesIt = hunks.some((h) => TEST_PATH_RE.test(h.file));
    /* deterministic: a test in the tree names what the criterion is about (only for criteria with something to name) */
    if (!testHunkNamesIt && keywords.some((k) => /\d{2,}|[A-Z_]{3,}|[a-z]+[A-Z]|_/.test(k))) {
      for (const hit of testFilesNaming(cwd, keywords.filter((k) => /\d{2,}|[A-Z_]{3,}|[a-z]+[A-Z]|_/.test(k)), testCache)) {
        items.push({ kind: 'test_names_it', strength: 'deterministic', summary: `${hit.file} mentions ${hit.keyword}`, ref: hit.file, ok: true });
        testHunkNamesIt = true;
      }
    }
    /* deterministic: tests the agent added or changed, when the criterion is about tests or names a tested thing */
    if (aboutTests || keywords.length) {
      for (const f of testFilesTouched) {
        const relevant = aboutTests || keywords.some((k) => f.includes(k.replace(/\.[a-z]+$/i, ''))) || hunks.some((h) => h.file === f);
        if (relevant) items.push({ kind: provenance.agent_created.added_files.includes(f) ? 'test_added' : 'test_modified', strength: 'deterministic', summary: `${f} ${provenance.agent_created.added_files.includes(f) ? 'added' : 'modified'} by the agent`, ref: f, ok: true });
      }
    }
    /* deterministic: the independent run, for anything about tests, regressions or the suite, and for behaviour a test hunk names */
    const alreadyHasRun = items.some((i) => i.kind === 'file_check' && /independent run/.test(i.summary));
    if (!alreadyHasRun && provenance.independent.ran && (aboutTests || testHunkNamesIt || /\b(unchanged|regression|still|existing|passes|suite)\b/i.test(c.text))) items.push({ kind: 'independent_run', strength: 'deterministic', summary: `independent run of \`${provenance.independent.command}\` ${provenance.independent.passed ? 'passed' : 'FAILED'}${provenance.independent.total_passed !== null ? ` (${provenance.independent.total_passed} passed)` : ''}`, ref: provenance.independent.command, ok: provenance.independent.passed });
    /* interpreted: the model's reading */
    if (c.resolved_by === 'tier1' || c.resolved_by === 'tier2') items.push({ kind: 'model_judgment', strength: 'interpreted', summary: c.evidence, confidence: c.confidence });
    if (c.override) items.push({ kind: 'dispute', strength: 'interpreted', summary: `${c.override.by}: ${c.override.status} (was ${c.override.original}): ${c.override.reason}` });

    const det = items.filter((i) => i.strength === 'deterministic');
    const detPositive = det.filter((i) => i.ok !== false && i.kind !== 'file_check');
    /* a test the agent touched, or a test hunk that names the behaviour, plus a green independent run: proof the test ran */
    const anchoredByTest = (det.some((i) => i.kind === 'test_added' || i.kind === 'test_modified') || testHunkNamesIt) && det.some((i) => (i.kind === 'independent_run' || (i.kind === 'file_check' && /independent run/.test(i.summary))) && i.ok);
    let status: AssuranceStatus;
    let basis: CriterionAssurance['basis'];
    if (eff === 'met') {
      if (c.resolved_by === 'tier0') {
        status = 'VERIFIED';
        basis = 'deterministic';
      } else if (anchoredByTest) {
        status = 'VERIFIED';
        basis = 'deterministic+model';
      } else {
        status = 'SUPPORTED';
        basis = detPositive.length ? 'deterministic+model' : 'model';
      }
    } else if (eff === 'partial') {
      status = 'SUPPORTED';
      basis = detPositive.length ? 'deterministic+model' : 'model';
    } else if (eff === 'unmet') {
      status = 'UNMET';
      basis = c.resolved_by === 'tier0' ? 'deterministic' : detPositive.length ? 'deterministic+model' : 'model';
    } else {
      status = 'UNVERIFIED';
      basis = items.length ? (det.length ? 'deterministic+model' : 'model') : 'none';
    }
    if (c.override) basis = 'model';
    return { id: c.id, text: c.text, status, basis, evidence: items, judge_status: eff, resolved_by: c.resolved_by, disputed: !!c.override };
  });

  const named = new Set<string>();
  for (const c of j.criteria) for (const k of criterionKeywords(c.text)) if (/[\\/]|\.[a-z]{1,5}$/i.test(k)) named.add(area(k));
  const touched = [...new Set([...changed].map(area))].sort();
  /* scope can only be compared when the contract names something; a contract with no paths gives nothing to flag against */
  const unnamed = named.size ? touched.filter((a) => a !== '(root)' && !named.has(a) && ![...named].some((n) => a.startsWith(n) || n.startsWith(a)) && !/^(tests?|__tests__|spec|docs?)$/.test(a)) : [];

  const summary = { verified: 0, supported: 0, unverified: 0, unmet: 0, total: criteria.length, sufficient: 0 };
  for (const c of criteria) {
    if (c.status === 'VERIFIED') summary.verified += 1;
    else if (c.status === 'SUPPORTED') summary.supported += 1;
    else if (c.status === 'UNVERIFIED') summary.unverified += 1;
    else summary.unmet += 1;
  }
  summary.sufficient = summary.verified + summary.supported;

  const agent: AgentIdentity = opts.agent ?? { product: 'claude-code' };
  return {
    schema: 'tally.verify.v1',
    session: j.session,
    generated_at: new Date().toISOString(),
    task: { goal: j.task.title, source: j.task.source.kind, url: j.task.source.url, status: task ? (task.inferred ? (task.confirmed ? 'confirmed' : 'needs_confirmation') : task.needs_clarification && !task.confirmed ? 'needs_confirmation' : 'confirmed') : 'none' },
    agent,
    model: modelIdentity(j.cost.models[0] ?? j.judge_model),
    criteria,
    verification: provenance,
    scope: { named_in_contract: [...named].sort(), touched_areas: touched, unnamed_areas: unnamed, note: !named.size ? 'the contract names no files or areas, so changed areas cannot be compared against it' : unnamed.length ? 'areas changed that no criterion names; flagged for explanation, not judged wrong' : 'every changed area is named by a criterion, or is tests or docs' },
    summary,
    experimental: { verdict: j.verdict.verdict, completion_pct: j.completion_pct, quality: j.quality.score, roi: j.value.roi_multiple, note: 'model-assisted figures: verdict, quality and ROI rest on an estimated human value and a model quality score; read the evidence first' },
  };
}

/* The same mapping from a stored receipt alone (no git), for old receipts and quick rendering. */
export function statusFromJudge(c: Judge['criteria'][number]): AssuranceStatus {
  const eff = effectiveStatus(c);
  if (eff === 'met') return c.resolved_by === 'tier0' ? 'VERIFIED' : 'SUPPORTED';
  if (eff === 'partial') return 'SUPPORTED';
  if (eff === 'unmet') return 'UNMET';
  return 'UNVERIFIED';
}

const MARK: Record<AssuranceStatus, string> = { VERIFIED: '✓', SUPPORTED: '△', UNVERIFIED: '?', UNMET: '✗' };
const COLOR: Record<AssuranceStatus, string> = { VERIFIED: '32', SUPPORTED: '33', UNVERIFIED: '90', UNMET: '31' };

export function renderVerify(a: Assurance, opts: { color?: boolean; evidence?: boolean } = {}): string {
  const color = opts.color !== false;
  const c = (code: string, s: string) => (color ? `[${code}m${s}[0m` : s);
  const L: string[] = [];
  L.push(c('1', 'Tally Verify'));
  L.push('');
  L.push(`Task: ${a.task.goal}${a.task.status === 'needs_confirmation' ? c('33', '  (contract not confirmed)') : ''}`);
  L.push(`Agent: ${a.agent.product}${a.agent.version ? ' ' + a.agent.version : ''}${a.model ? `   Model: ${a.model.model} (${a.model.provider})` : ''}`);
  L.push('');
  L.push('Acceptance criteria');
  for (const cr of a.criteria) {
    L.push(`${c(COLOR[cr.status], `${MARK[cr.status]} ${cr.status.padEnd(11)}`)} ${cr.text}${cr.disputed ? c('36', '  (disputed)') : ''}`);
    if (opts.evidence !== false) {
      const items = cr.evidence;
      items.forEach((e, i) => {
        const last = i === items.length - 1;
        const tag = e.strength === 'interpreted' ? c('90', ' [model]') : '';
        const okMark = e.ok === false ? c('31', ' ✗') : '';
        L.push(c('90', `  ${last ? '└─' : '├─'} `) + `${e.summary}${e.confidence !== undefined ? c('90', ` (${e.confidence.toFixed(2)})`) : ''}${tag}${okMark}`);
      });
      if (!items.length) L.push(c('90', '  └─ no evidence found'));
    }
  }
  L.push('');
  L.push('Verification');
  const v = a.verification;
  if (v.independent.ran) L.push(`${c(v.independent.passed ? '32' : '31', v.independent.passed ? '✓' : '✗')} ${v.independent.command}  ${c('90', `independent run${v.independent.total_passed !== null ? `, ${v.independent.total_passed} passed` : ''}`)}`);
  else L.push(`${c('90', '?')} independent run not made ${c('90', `(${v.independent.reason ?? 'unknown'})`)}`);
  L.push(`  pre-existing tests: ${v.preexisting_files === null ? c('90', 'unknown (no base tree)') : `${v.preexisting_files} file(s) at session start`}`);
  L.push(`  agent-created tests: ${v.agent_created.added_files.length} file(s) added, ${v.agent_created.modified_files.length} modified, ${v.agent_created.cases_added} case(s) added`);
  if (v.agent_runs.length) L.push(`  agent's own runs: ${v.agent_runs.length} (${v.agent_runs.filter((r) => r.passed).length} green)  ${c('90', 'claims, not evidence')}`);
  L.push('');
  L.push('Scope');
  if (a.scope.unnamed_areas.length) L.push(`${c('33', '△')} changed areas no criterion names: ${a.scope.unnamed_areas.join(', ')}  ${c('90', '(flagged for explanation, not judged wrong)')}`);
  else if (!a.scope.named_in_contract.length) L.push(`${c('90', '?')} the contract names no files or areas; changed: ${a.scope.touched_areas.join(', ') || 'nothing'}  ${c('90', '(nothing to compare against)')}`);
  else L.push(`${c('32', '✓')} every changed area is named by a criterion, or is tests or docs  ${c('90', `(${a.scope.touched_areas.join(', ') || 'nothing changed'})`)}`);
  L.push('');
  L.push('Result');
  const s = a.summary;
  L.push(`${s.sufficient}/${s.total} criteria have sufficient evidence (${s.verified} verified, ${s.supported} supported).`);
  if (s.unmet) L.push(c('31', `${s.unmet} criterion${s.unmet > 1 ? 'a are' : ' is'} unmet.`));
  if (s.unverified) L.push(c('90', `${s.unverified} could not be verified from the evidence.`));
  L.push('');
  L.push(c('90', `Experimental: verdict ${a.experimental.verdict}, completion ${a.experimental.completion_pct}%, quality ${a.experimental.quality}/10, ROI ${a.experimental.roi ?? 'n/a'}. ${a.experimental.note}`));
  return L.join('\n');
}
