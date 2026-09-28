import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root } from './helpers.js';
import { telemetryActive, enableTelemetry, disableTelemetry, record, flush, makeEvent, readTelemetry, queueFile, shouldAskConsent, ALLOWED_FIELDS, exampleEvent } from '../src/telemetry/index.js';
import { askConsent } from '../src/telemetry/consent.js';

const CLI = path.join(root, 'dist', 'cli.js');
let iso: ReturnType<typeof isolate>;
const saved: Record<string, string | undefined> = {};
const ENV = ['TALLY_TELEMETRY', 'TALLY_TELEMETRY_ENDPOINT', 'CI', 'GITHUB_ACTIONS', 'TALLY_NO_SPAWN', 'TALLY_INTERNAL', 'TALLY_LLM'];
beforeEach(() => {
  iso = isolate();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TALLY_NO_SPAWN = '1';
});
afterEach(() => {
  iso.restore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('telemetry: off by default, off under the kill switches, allowlisted fields only', () => {
  it('is off until opted in, and off again under TALLY_TELEMETRY=0, CI, or an internal run', () => {
    expect(readTelemetry().enabled).toBe(false);
    expect(telemetryActive().active).toBe(false);
    expect(telemetryActive().reason).toMatch(/not asked yet; default is off/);
    expect(record({ command: 'verify', success: true })).toBeNull();
    expect(fs.existsSync(queueFile())).toBe(false);
    enableTelemetry();
    process.env.TALLY_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/never';
    expect(telemetryActive().active).toBe(true);
    process.env.TALLY_TELEMETRY = '0';
    expect(telemetryActive()).toMatchObject({ active: false, reason: expect.stringMatching(/TALLY_TELEMETRY=0/) });
    delete process.env.TALLY_TELEMETRY;
    process.env.CI = 'true';
    expect(telemetryActive().reason).toMatch(/CI/);
    delete process.env.CI;
    process.env.TALLY_INTERNAL = '1';
    expect(telemetryActive().active).toBe(false);
    delete process.env.TALLY_INTERNAL;
    delete process.env.TALLY_TELEMETRY_ENDPOINT;
    expect(telemetryActive().reason).toMatch(/no endpoint is configured/);
  });

  it('an event carries only allowlisted fields, and the example matches the published schema', () => {
    const s = enableTelemetry();
    const ev = makeEvent({ command: 'verify', success: true, criteria: { verified: 1, supported: 0, unverified: 0, unmet: 0 }, verdict: 'worth it', ...({ prompt: 'secret text', cwd: 'C:/repo', files: ['a.ts'] } as object) }, s);
    expect(Object.keys(ev).every((k) => (ALLOWED_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(ev).not.toHaveProperty('prompt');
    expect(ev).not.toHaveProperty('cwd');
    expect(ev.installation_id).toBe(s.installation_id);
    expect(ev.installation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev.tally_version).toMatch(/^\d+\.\d+\.\d+/);
    const ex = exampleEvent(s);
    expect(ex.schema).toBe('tally.telemetry.v1');
    expect(Object.keys(ex).every((k) => (ALLOWED_FIELDS as readonly string[]).includes(k))).toBe(true);
    /* the documented list and the code agree */
    const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8');
    for (const f of ALLOWED_FIELDS) expect(privacy, `PRIVACY.md documents ${f}`).toContain('`' + f + '`');
  });

  it('queues locally and flushes to the endpoint; a failure keeps the queue; off deletes the id and the queue', async () => {
    const received: unknown[] = [];
    let status = 200;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(body) });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    process.env.TALLY_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/events`;
    try {
      enableTelemetry();
      expect(record({ command: 'doctor', success: true })).toBeTruthy();
      expect(record({ command: 'feedback', success: true, feedback_label: 'wrong', false_verified: true })).toBeTruthy();
      expect(fs.readFileSync(queueFile(), 'utf8').split('\n').filter(Boolean).length).toBe(2);
      status = 500;
      expect((await flush()).sent).toBe(0);
      expect(fs.existsSync(queueFile())).toBe(true);
      status = 200;
      const r = await flush();
      expect(r.sent).toBe(2);
      expect(fs.existsSync(queueFile())).toBe(false);
      const batch = (received[1] as { body: Array<Record<string, unknown>> }).body;
      expect(batch.length).toBe(2);
      expect(batch[1]).toMatchObject({ command: 'feedback', feedback_label: 'wrong', false_verified: true });
      for (const ev of batch) for (const k of Object.keys(ev)) expect((ALLOWED_FIELDS as readonly string[]).includes(k), k).toBe(true);
      record({ command: 'verify', success: false });
      const before = readTelemetry();
      disableTelemetry();
      const after = readTelemetry();
      expect(after.enabled).toBe(false);
      expect(after.installation_id).toBeUndefined();
      expect(fs.existsSync(queueFile())).toBe(false);
      expect(enableTelemetry().installation_id).not.toBe(before.installation_id);
    } finally {
      srv.close();
    }
  });

  it('the consent question is asked once, defaults to No, and is skipped when the environment already decided', async () => {
    expect(shouldAskConsent({ interactive: false })).toBe(false);
    expect(shouldAskConsent({ interactive: true, env: { CI: '1' } })).toBe(false);
    expect(shouldAskConsent({ interactive: true, env: { TALLY_TELEMETRY: '0' } })).toBe(false);
    expect(shouldAskConsent({ interactive: true, env: {} })).toBe(true);
    let text = '';
    expect(await askConsent({ question: async () => '', out: (s) => (text += s) })).toBe(false);
    expect(text).toMatch(/Off\. It will not ask again/);
    expect(readTelemetry()).toMatchObject({ enabled: false });
    expect(readTelemetry().asked).toBeTruthy();
    expect(shouldAskConsent({ interactive: true, env: {} })).toBe(false);
    fs.rmSync(path.join(iso.home, 'telemetry.json'));
    expect(await askConsent({ question: async () => 'y', out: (s) => (text += s) })).toBe(true);
    expect(readTelemetry().enabled).toBe(true);
    expect(readTelemetry().installation_id).toMatch(/-/);
  });

  it('the CLI reports status and prints exactly what would be sent', () => {
    const env = { ...process.env, TALLY_HOME: iso.home, CLAUDE_CONFIG_DIR: iso.claude };
    const st = spawnSync(process.execPath, [CLI, 'telemetry', 'status'], { encoding: 'utf8', env });
    expect(st.stdout).toMatch(/Anonymous metrics: off; not sending/);
    const on = spawnSync(process.execPath, [CLI, 'telemetry', 'on'], { encoding: 'utf8', env });
    expect(on.stdout).toMatch(/Installation id [0-9a-f-]{36}/);
    expect(on.stdout).toMatch(/no endpoint is configured/);
    const show = spawnSync(process.execPath, [CLI, 'telemetry', 'show'], { encoding: 'utf8', env });
    expect(show.stdout).toContain('tally.telemetry.v1');
    expect(show.stdout).toMatch(/Never sent: prompts, code, diffs/);
    expect(show.stdout).toMatch(/"command": "verify"/);
    const off = spawnSync(process.execPath, [CLI, 'telemetry', 'off'], { encoding: 'utf8', env });
    expect(off.stdout).toMatch(/installation id and any queued events were deleted/);
    /* a user-facing command under CI never asks and never queues */
    const doc = spawnSync(process.execPath, [CLI, 'doctor', '--offline', '--plain'], { encoding: 'utf8', env: { ...env, CI: '1' } });
    expect(doc.stdout).not.toMatch(/Enable anonymous metrics/);
    expect(fs.existsSync(path.join(iso.home, 'telemetry-queue.jsonl'))).toBe(false);
  });
});
