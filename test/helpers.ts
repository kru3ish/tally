import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, '..');
export const fixtures = path.join(here, 'fixtures');
export const basicFixture = path.join(fixtures, 'session-basic');

/* every temp dir a test file creates is removed when that file finishes; a run of the suite used to leave thousands behind.
   Registered here so each test file that imports the helpers gets the hook without repeating it. */
const created: string[] = [];
afterAll(() => {
  for (const d of created.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* a process may still hold a file on Windows; the next run's cleanup or the OS gets it */
    }
  }
});

export function tmpDir(prefix = 'tally-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

export function isolate(): { home: string; claude: string; restore: () => void } {
  const home = tmpDir('tally-home-');
  const claude = tmpDir('tally-claude-');
  const prev = { TALLY_HOME: process.env.TALLY_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.TALLY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  return {
    home,
    claude,
    restore: () => {
      if (prev.TALLY_HOME === undefined) delete process.env.TALLY_HOME;
      else process.env.TALLY_HOME = prev.TALLY_HOME;
      if (prev.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev.CLAUDE_CONFIG_DIR;
      /* macOS occasionally reports ENOTEMPTY while a just-exited child still holds a file; retry instead of failing the test */
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      fs.rmSync(claude, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    },
  };
}

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(basicFixture, name), 'utf8');
}
