/* Generates realistic Claude Code transcript + Tally hook-event fixtures.
   Run: npm run fixtures. Output is committed under test/fixtures/. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const SESSION = 'fx-basic-0001-4c0d-8e1a-000000000001';
const CWD = 'C:\\Users\\dev\\acme-app';
const TRANSCRIPT_PATH = `C:\\Users\\dev\\.claude\\projects\\C--Users-dev-acme-app\\${SESSION}.jsonl`;

class Clock {
  t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  tick(s = 4): string {
    this.t += s * 1000;
    return new Date(this.t).toISOString();
  }
  now(): string {
    return new Date(this.t).toISOString();
  }
}

type Line = Record<string, unknown>;

class Builder {
  lines: Line[] = [];
  events: Line[] = [];
  clock = new Clock('2026-09-10T14:00:00.000Z');
  lastUuid: string | null = null;
  n = 0;
  msgN = 0;
  turnN = 0;
  ctx = 28000;
  cacheWriteNext = 28000;

  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }

  base(extra: Line, agent?: string): Line {
    const uuid = this.uuid();
    const l: Line = {
      parentUuid: this.lastUuid,
      isSidechain: !!agent,
      ...(agent ? { agentId: agent } : {}),
      userType: 'external',
      entrypoint: 'cli',
      cwd: CWD,
      sessionId: SESSION,
      version: '2.1.268',
      gitBranch: 'feature/rate-limit',
      uuid,
      timestamp: this.clock.now(),
      ...extra,
    };
    this.lastUuid = uuid;
    return l;
  }

  event(type: string, data: Line): void {
    this.events.push({ ts: this.clock.now(), type, session: SESSION, cwd: CWD, data });
  }

  sessionStart(): void {
    this.lines.push({ type: 'permission-mode', permissionMode: 'default', sessionId: SESSION });
    this.event('session_start', {
      source: 'startup',
      transcript_path: TRANSCRIPT_PATH,
      model: 'claude-opus-5',
      loaded: {
        mcp: ['github', 'jira', 'postgres'],
        skills: ['superpowers:test-driven-development', 'superpowers:brainstorming', 'deploy-checklist'],
        plugins: ['superpowers'],
      },
      git_head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    });
  }

  prompt(text: string): void {
    this.turnN += 1;
    this.clock.tick(20);
    this.lines.push(this.base({ type: 'user', promptId: this.uuid(), message: { role: 'user', content: text } }));
    this.event('prompt', { prompt: text, turn: this.turnN });
  }

  assistant(
    opts: { model?: string; agent?: string; output?: number; text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }>; afterCompaction?: boolean },
  ): string[] {
    this.clock.tick(3);
    this.msgN += 1;
    const id = `msg_fx${String(this.msgN).padStart(6, '0')}`;
    const model = opts.model ?? 'claude-opus-5';
    const output = opts.output ?? 300;
    const isMain = !opts.agent;
    let usage: Line;
    if (isMain) {
      const cacheWrite = opts.afterCompaction ? this.ctx : this.cacheWriteNext;
      const cacheRead = opts.afterCompaction ? 0 : this.ctx - this.cacheWriteNext;
      usage = {
        input: 3,
        output_tokens: output,
        input_tokens: 3,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: Math.max(0, cacheRead),
        cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
        service_tier: 'standard',
      };
      delete usage.input;
      this.ctx += output + 900;
      this.cacheWriteNext = output + 900;
    } else {
      usage = {
        input_tokens: 5,
        output_tokens: output,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 9000,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1200 },
        service_tier: 'standard',
      };
    }
    const ids: string[] = [];
    const blocks: Line[] = [];
    if (opts.text) blocks.push({ type: 'text', text: opts.text });
    for (const t of opts.tools ?? []) {
      const tid = `toolu_fx${String(this.n + blocks.length).padStart(6, '0')}`;
      ids.push(tid);
      blocks.push({ type: 'tool_use', id: tid, name: t.name, input: t.input });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    // Claude Code streams one jsonl line per content block, repeating message id + usage.
    for (const b of blocks) {
      this.lines.push(
        this.base(
          {
            type: 'assistant',
            requestId: `req_fx${this.msgN}`,
            message: { model, id, type: 'message', role: 'assistant', content: [b], stop_reason: ids.length ? 'tool_use' : 'end_turn', usage },
          },
          opts.agent,
        ),
      );
    }
    for (let i = 0; i < ids.length; i++) {
      const t = opts.tools![i]!;
      this.event('pre_tool', { tool_name: t.name, tool_input: t.input, tool_use_id: ids[i], agent: opts.agent ?? null });
    }
    return ids;
  }

  result(toolUseId: string, tool: { name: string; input: Record<string, unknown> }, text: string, isError = false, agent?: string): void {
    this.clock.tick(isError ? 6 : 2);
    this.lines.push(
      this.base(
        {
          type: 'user',
          message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, ...(isError ? { is_error: true } : {}) }] },
        },
        agent,
      ),
    );
    this.event('post_tool', {
      tool_name: tool.name,
      tool_input: tool.input,
      tool_use_id: toolUseId,
      is_error: isError,
      response_chars: text.length,
      response_head: text.slice(0, 300),
      agent: agent ?? null,
    });
  }

  call(tool: { name: string; input: Record<string, unknown> }, resultText: string, opts: { isError?: boolean; output?: number; text?: string; agent?: string; model?: string; afterCompaction?: boolean } = {}): void {
    const [id] = this.assistant({ tools: [tool], output: opts.output, text: opts.text, agent: opts.agent, model: opts.model, afterCompaction: opts.afterCompaction });
    this.result(id!, tool, resultText, opts.isError, opts.agent);
  }

  stop(text: string): void {
    this.clock.tick(2);
    this.event('stop', { last_assistant_message: text.slice(0, 500) });
  }

  compact(): void {
    this.clock.tick(5);
    this.event('pre_compact', { trigger: 'auto', context_tokens: this.ctx });
    this.lines.push(
      this.base({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: implementing rate limiting on /api/login...' },
      }),
    );
    this.ctx = 18000;
    this.cacheWriteNext = 18000;
  }
}

function read(file: string, body: string): [{ name: string; input: Record<string, unknown> }, string] {
  return [{ name: 'Read', input: { file_path: `${CWD}\\${file}` } }, body];
}
function bash(cmd: string, desc: string): { name: string; input: Record<string, unknown> } {
  return { name: 'Bash', input: { command: cmd, description: desc } };
}

const LOGIN_TS = `import { Router } from 'express';
import { verifyPassword } from '../auth';
export const login = Router();
login.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const ok = await verifyPassword(email, password);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ token: 'jwt-placeholder' });
});
`;

const FAIL_OUT = `> acme-app@1.0.0 test
> vitest run

 FAIL  test/login.test.ts > login > blocks after 5 attempts
AssertionError: expected 200 to be 429
 ❯ test/login.test.ts:22:31
Test Files  1 failed (1)
     Tests  1 failed | 2 passed (3)`;

const PASS_OUT = `> acme-app@1.0.0 test
> vitest run

 ✓ test/login.test.ts (4)
Test Files  1 passed (1)
     Tests  4 passed (4)`;

function build(): Builder {
  const b = new Builder();
  b.sessionStart();

  b.prompt('Implement https://github.com/acme/app/issues/42 — rate limit the login endpoint. Keep it simple.');
  b.assistant({ text: "I'll look at the login route and middleware first.", output: 120 });
  b.call(...read('README.md', '# acme-app\nExpress API. `npm test` runs vitest.\n'), { output: 90 });
  b.call(...read('src\\routes\\login.ts', LOGIN_TS), { output: 80 });
  b.call({ name: 'Grep', input: { pattern: 'rateLimit|rate-limit', path: CWD } }, 'No matches found', { output: 70 });
  b.call(...read('src\\middleware\\index.ts', "export { auth } from './auth';\n"), { output: 60 });
  b.call({ name: 'Skill', input: { skill: 'superpowers:test-driven-development' } }, 'Skill loaded: write a failing test first, then make it pass.', { output: 40 });
  b.call({ name: 'mcp__github__issue_read', input: { owner: 'acme', repo: 'app', issue_number: 42 } }, JSON.stringify({ title: 'Rate limit login', body: 'Block after 5 failed attempts per IP within 15 minutes. Return 429. Add tests. Document the limit in README.' }), { output: 60 });

  // subagent explores auth module
  const [agentId] = b.assistant({ tools: [{ name: 'Agent', input: { description: 'Find auth helpers', prompt: 'Locate password verification helpers', subagent_type: 'Explore' } }], output: 150 });
  b.call(...read('src\\auth.ts', 'export async function verifyPassword(e: string, p: string) { return p === "x"; }'), { agent: 'agent-explore-01', model: 'claude-haiku-4-5', output: 120 });
  b.call({ name: 'Grep', input: { pattern: 'verifyPassword', path: CWD } }, 'src/auth.ts:1\nsrc/routes/login.ts:6', { agent: 'agent-explore-01', model: 'claude-haiku-4-5', output: 90 });
  b.assistant({ agent: 'agent-explore-01', model: 'claude-haiku-4-5', output: 200, text: 'verifyPassword lives in src/auth.ts and is used only by the login route.' });
  b.result(agentId!, { name: 'Agent', input: { description: 'Find auth helpers' } }, 'verifyPassword lives in src/auth.ts and is used only by the login route.');

  // build
  b.call({ name: 'Write', input: { file_path: `${CWD}\\src\\middleware\\rateLimit.ts`, content: 'export function rateLimit(max = 5, windowMs = 900000) { const hits = new Map(); return (req, res, next) => { const k = req.ip; const now = Date.now(); const h = (hits.get(k) || []).filter((t) => now - t < windowMs); if (h.length >= max) return res.status(429).json({ error: "too many attempts" }); hits.set(k, [...h, now]); next(); }; }' } }, 'File created successfully', { output: 700 });
  b.call(...read('src\\routes\\login.ts', LOGIN_TS), { output: 50 });
  b.call({ name: 'Edit', input: { file_path: `${CWD}\\src\\routes\\login.ts`, old_string: "login.post('/api/login', async", new_string: "login.post('/api/login', rateLimit(), async" } }, 'The file has been updated.', { output: 200 });
  b.call({ name: 'Write', input: { file_path: `${CWD}\\test\\login.test.ts`, content: 'import { describe, it, expect } from "vitest"; describe("login", () => { it("blocks after 5 attempts", async () => { expect(429).toBe(429); }); });' } }, 'File created successfully', { output: 500 });

  // failing loop: same command fails 3 times
  const test = bash('npm test', 'Run the test suite');
  b.call(test, FAIL_OUT, { isError: true, output: 150 });
  b.call({ name: 'Edit', input: { file_path: `${CWD}\\src\\middleware\\rateLimit.ts`, old_string: 'h.length >= max', new_string: 'h.length > max' } }, 'The file has been updated.', { output: 180 });
  b.call(test, FAIL_OUT, { isError: true, output: 140 });
  b.call({ name: 'Edit', input: { file_path: `${CWD}\\src\\middleware\\rateLimit.ts`, old_string: 'h.length > max', new_string: 'h.length >= max - 1' } }, 'The file has been updated.', { output: 170 });
  b.call(test, FAIL_OUT, { isError: true, output: 160 });
  b.call(...read('src\\routes\\login.ts', LOGIN_TS.replace('async', 'rateLimit(), async')), { output: 60 });
  b.call({ name: 'Edit', input: { file_path: `${CWD}\\src\\routes\\login.ts`, old_string: 'rateLimit(), async', new_string: 'rateLimit(5, 15 * 60 * 1000), async' } }, 'The file has been updated.', { output: 220 });
  b.call(test, PASS_OUT, { output: 130 });

  // mcp errors
  const jira = { name: 'mcp__jira__get_issue', input: { key: 'APP-42' } };
  b.call(jira, 'Error: 401 Unauthorized', { isError: true, output: 60 });
  b.call(jira, 'Error: 401 Unauthorized', { isError: true, output: 55 });
  b.call(jira, 'Error: 401 Unauthorized', { isError: true, output: 50 });

  b.assistant({ text: 'Rate limiting is in place and tests pass. Ready to push when you are.', output: 90 });
  b.stop('Rate limiting is in place and tests pass. Ready to push when you are.');

  b.compact();

  b.prompt('Push it up and open a PR.');
  b.call(bash('git add -A && git commit -m "add rate limiting to login"', 'Commit changes'), '[feature/rate-limit 9f8e7d6] add rate limiting to login\n 3 files changed, 21 insertions(+)', { output: 120, afterCompaction: true });
  b.call(bash('git push -u origin feature/rate-limit', 'Push branch'), 'To github.com:acme/app.git\n * [new branch] feature/rate-limit -> feature/rate-limit', { output: 80 });
  b.events.push({ ts: b.clock.now(), type: 'ship', session: SESSION, cwd: CWD, data: { kind: 'push', command: 'git push -u origin feature/rate-limit' } });
  b.call(bash('gh pr create --title "Rate limit login" --body "Closes #42"', 'Open PR'), 'https://github.com/acme/app/pull/57', { output: 100 });
  b.events.push({ ts: b.clock.now(), type: 'ship', session: SESSION, cwd: CWD, data: { kind: 'pr', command: 'gh pr create', url: 'https://github.com/acme/app/pull/57' } });
  const final = 'Pushed feature/rate-limit and opened PR #57. Login is limited to 5 attempts per IP per 15 minutes and returns 429 after that, with a test covering it. I did not update the README.';
  b.assistant({ text: final, output: 140 });
  b.stop(final);
  b.clock.tick(10);
  b.event('session_end', { reason: 'prompt_input_exit', transcript_path: TRANSCRIPT_PATH });
  return b;
}

const b = build();
const dir = path.join(root, 'test', 'fixtures', 'session-basic');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'transcript.jsonl'), b.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'events.jsonl'), b.events.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(
  path.join(dir, 'task.md'),
  `# Rate limit the login endpoint\n\nBlock after 5 failed attempts per IP within 15 minutes. Return 429.\n\n- [ ] Add tests\n- [ ] Document the limit in README\n`,
);
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session: SESSION, cwd: CWD, transcript_path: TRANSCRIPT_PATH }, null, 2) + '\n');
console.log(`wrote ${b.lines.length} transcript lines, ${b.events.length} events to ${dir}`);
