import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, '..');
export const fixtures = path.join(here, 'fixtures');
export const basicFixture = path.join(fixtures, 'session-basic');

export function tmpDir(prefix = 'tally-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(claude, { recursive: true, force: true });
    },
  };
}

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(basicFixture, name), 'utf8');
}
