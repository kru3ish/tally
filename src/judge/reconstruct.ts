/* Reconstructs what a session changed from the transcript's Edit/MultiEdit/Write calls and Bash commands that write
   files, then merges with git: files git saw are `verified-against-disk`, files only the transcript saw are `reconstructed`. */
import type { Transcript } from '../transcript/parse.js';

export interface TranscriptChange {
  file: string;
  kind: 'write' | 'edit' | 'bash';
  ts: string;
  detail: string;
  verification: 'verified-against-disk' | 'reconstructed';
}

export interface Reconstruction {
  changes: TranscriptChange[];
  verified: string[];
  reconstructed: string[];
  bash_edits: Array<{ ts: string; command: string; file?: string }>;
  diff_text: string;
  source: 'git' | 'reconstructed' | 'mixed' | 'none';
}

const BASH_WRITE_RE = /\b(sed\s+-i|tee\b|>{1,2}\s*[^\s&|;]+|mv\s+|cp\s+|rm\s+(-\w+\s+)?[^\s]+|git\s+apply|patch\s+|touch\s+|printf .*>|echo .*>|cat .*>|npx?\s+prettier\s+--write|eslint\s+--fix|black\b|gofmt\s+-w|rustfmt)/;

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function rel(file: string, cwd?: string): string {
  const f = norm(file);
  if (!cwd) return f;
  const c = norm(cwd).replace(/\/+$/, '') + '/';
  return f.toLowerCase().startsWith(c.toLowerCase()) ? f.slice(c.length) : f;
}

function bashTarget(cmd: string): string | undefined {
  const m = /(?:>{1,2}|tee(?:\s+-a)?|sed\s+-i(?:\s+'[^']*'|\s+"[^"]*"|\s+\S+)?|touch|mv\s+\S+|cp\s+\S+|rm\s+(?:-\w+\s+)?)\s*([^\s&|;'"]+)/.exec(cmd);
  return m?.[1];
}

export function reconstructChanges(t: Transcript, gitFiles: string[], cwd?: string): Reconstruction {
  const changes: TranscriptChange[] = [];
  const bash_edits: Reconstruction['bash_edits'] = [];
  const gitSet = new Set(gitFiles.map((f) => norm(f).toLowerCase()));
  const verify = (file: string): TranscriptChange['verification'] => {
    const r = rel(file, cwd).toLowerCase();
    return [...gitSet].some((g) => g === r || g.endsWith('/' + r) || r.endsWith('/' + g)) ? 'verified-against-disk' : 'reconstructed';
  };
  for (const c of t.toolCalls) {
    if (c.agent !== 'main' || c.result?.isError) continue;
    const file = typeof c.input.file_path === 'string' ? c.input.file_path : undefined;
    if (c.name === 'Write' && file) {
      const content = String(c.input.content ?? '');
      const lines = content.split('\n');
      changes.push({ file: rel(file, cwd), kind: 'write', ts: c.ts, detail: `+++ ${rel(file, cwd)} (written, ${lines.length} lines)\n${lines.slice(0, 40).map((l) => '+' + l).join('\n')}${lines.length > 40 ? `\n+… ${lines.length - 40} more lines` : ''}`, verification: verify(file) });
    } else if ((c.name === 'Edit' || c.name === 'MultiEdit') && file) {
      const edits = c.name === 'MultiEdit' && Array.isArray(c.input.edits) ? (c.input.edits as Array<{ old_string?: string; new_string?: string }>) : [{ old_string: c.input.old_string, new_string: c.input.new_string } as { old_string?: string; new_string?: string }];
      for (const e of edits) {
        const oldS = String(e.old_string ?? '');
        const newS = String(e.new_string ?? '');
        changes.push({ file: rel(file, cwd), kind: 'edit', ts: c.ts, detail: `@@ ${rel(file, cwd)} @@\n${oldS.split('\n').slice(0, 20).map((l) => '-' + l).join('\n')}\n${newS.split('\n').slice(0, 20).map((l) => '+' + l).join('\n')}`, verification: verify(file) });
      }
    } else if (c.name === 'Bash') {
      const cmd = typeof c.input.command === 'string' ? c.input.command : '';
      if (cmd && BASH_WRITE_RE.test(cmd) && !/^\s*git\s+(status|diff|log|add|commit|push)/.test(cmd)) {
        const target = bashTarget(cmd);
        bash_edits.push({ ts: c.ts, command: cmd.slice(0, 200), file: target });
        if (target) changes.push({ file: rel(target, cwd), kind: 'bash', ts: c.ts, detail: `# shell-made change to ${rel(target, cwd)}: ${cmd.slice(0, 160)}`, verification: verify(target) });
      }
    }
  }
  const verified = [...new Set(changes.filter((c) => c.verification === 'verified-against-disk').map((c) => c.file))].sort();
  const reconstructed = [...new Set(changes.filter((c) => c.verification === 'reconstructed').map((c) => c.file))].sort();
  const diff_text = changes.map((c) => `${c.detail}   [${c.verification}]`).join('\n\n');
  const source: Reconstruction['source'] = gitFiles.length && reconstructed.length ? 'mixed' : gitFiles.length ? 'git' : changes.length ? 'reconstructed' : 'none';
  return { changes, verified, reconstructed, bash_edits, diff_text: diff_text.length > 60000 ? diff_text.slice(0, 60000) + '\n…[reconstruction truncated]' : diff_text, source };
}
