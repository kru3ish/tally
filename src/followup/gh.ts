import { spawnSync } from 'node:child_process';

export interface GhStatus {
  ok: boolean;
  installed: boolean;
  reason: string;
  fix: string;
}

let cached: GhStatus | null = null;

export function ghInstallHint(): string {
  if (process.platform === 'win32') return 'winget install GitHub.cli (then reopen the terminal) and run `gh auth login`';
  if (process.platform === 'darwin') return 'brew install gh && gh auth login';
  return 'see https://github.com/cli/cli#installation, then run `gh auth login`';
}

/* Cheap, cached check used by doctor, write-back and follow-up so a missing gh is reported, never silently ignored. */
export function ghStatus(force = false): GhStatus {
  if (cached && !force) return cached;
  const v = spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (v.error || v.status !== 0) {
    cached = { ok: false, installed: false, reason: 'gh is not installed or not on PATH', fix: ghInstallHint() };
    return cached;
  }
  const a = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (a.status === 0) cached = { ok: true, installed: true, reason: '', fix: '' };
  else cached = { ok: false, installed: true, reason: 'gh is installed but not authenticated', fix: 'gh auth login' };
  return cached;
}

export function resetGhStatusCache(): void {
  cached = null;
}
