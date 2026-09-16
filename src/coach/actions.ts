import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { appendEvent } from '../store/events.js';
import { ensureDir, tallyHome } from '../paths.js';
import { enqueueInject } from './inject.js';
import { recordChange } from './undo.js';
import type { Suggestion } from './types.js';

export interface ApplyResult {
  ok: boolean;
  detail: string;
  file?: string;
  injected?: boolean;
}

export function isAutoApplicable(s: Suggestion): boolean {
  if (s.action.kind === 'inject') return true;
  if (s.action.kind === 'write_md') return /\.md$/i.test(s.action.file);
  return false;
}

export function applySuggestion(s: Suggestion, opts: { session: string; cwd: string; cfg: Config; mode: 'ask' | 'auto' }): ApplyResult {
  const a = s.action;
  if (opts.mode === 'auto' && !isAutoApplicable(s)) return { ok: false, detail: 'settings and MCP changes require ask mode' };
  let result: ApplyResult;
  switch (a.kind) {
    case 'write_md': {
      if (!/\.md$/i.test(a.file)) return { ok: false, detail: 'only .md files can be written by Coach' };
      const before = fs.existsSync(a.file) ? fs.readFileSync(a.file, 'utf8') : null;
      if (a.mode === 'create' && before !== null) return { ok: false, detail: `${path.basename(a.file)} already exists` };
      const after = a.mode === 'append' ? (before ?? '') + (before && !before.endsWith('\n') ? '\n' : '') + a.content : a.content;
      ensureDir(path.dirname(a.file));
      fs.writeFileSync(a.file, after);
      recordChange({ session: opts.session, rule: s.rule, label: a.label, file: a.file, before, after });
      result = { ok: true, detail: `${a.mode === 'append' ? 'appended to' : before === null ? 'created' : 'rewrote'} ${path.relative(opts.cwd, a.file) || a.file}`, file: a.file };
      break;
    }
    case 'inject': {
      enqueueInject(opts.session, a.note, s.rule, opts.cwd);
      result = { ok: true, detail: 'note queued; Claude sees it on the next turn', injected: true };
      break;
    }
    case 'snippet': {
      const dir = path.join(tallyHome(), 'snippets');
      ensureDir(dir);
      const f = path.join(dir, `${s.key.replace(/[^a-z0-9]+/gi, '-')}.txt`);
      fs.writeFileSync(f, `${a.snippet}\n# ${a.where}\n`);
      result = { ok: true, detail: `snippet saved to ${f}\n    ${a.snippet}\n    (${a.where})`, file: f };
      break;
    }
    case 'settings': {
      const before = fs.existsSync(a.file) ? fs.readFileSync(a.file, 'utf8') : null;
      let current: Record<string, unknown> = {};
      if (before) {
        try {
          current = JSON.parse(before) as Record<string, unknown>;
        } catch {
          return { ok: false, detail: `${a.file} is not valid JSON; not touching it` };
        }
      }
      const merged = mergePatch(current, a.patch);
      const after = JSON.stringify(merged, null, 2) + '\n';
      ensureDir(path.dirname(a.file));
      fs.writeFileSync(a.file, after);
      recordChange({ session: opts.session, rule: s.rule, label: a.label, file: a.file, before, after });
      result = { ok: true, detail: `updated ${path.relative(opts.cwd, a.file) || a.file} (undo with \`tally undo\`)`, file: a.file };
      break;
    }
    default:
      result = { ok: false, detail: 'nothing to apply for this suggestion' };
  }
  if (result.ok && s.inject_note && a.kind !== 'inject') {
    enqueueInject(opts.session, s.inject_note, s.rule, opts.cwd);
    result.injected = true;
  }
  appendEvent({ ts: new Date().toISOString(), type: 'apply', session: opts.session, cwd: opts.cwd, data: { rule: s.rule, key: s.key, action: a.kind, label: a.label, ok: result.ok, detail: result.detail.slice(0, 200), mode: opts.mode } });
  return result;
}

export function injectSuggestion(s: Suggestion, opts: { session: string; cwd: string }): ApplyResult {
  const note = s.action.kind === 'inject' ? s.action.note : s.inject_note ?? `${s.title}: ${s.message}`;
  enqueueInject(opts.session, note, s.rule, opts.cwd);
  return { ok: true, detail: 'note queued; Claude sees it on the next turn', injected: true };
}

export function skipSuggestion(s: Suggestion, opts: { session: string; cwd: string }): void {
  appendEvent({ ts: new Date().toISOString(), type: 'skip', session: opts.session, cwd: opts.cwd, data: { rule: s.rule, key: s.key } });
}

export function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (Array.isArray(v)) {
      const arr = Array.isArray(prev) ? [...prev] : [];
      for (const item of v) if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(item))) arr.push(item);
      out[k] = arr;
    } else if (v && typeof v === 'object') {
      out[k] = mergePatch(prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {}, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}
