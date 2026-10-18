/* Writes the dashboard to a temp file (overwritten each time, so it is short-lived) and opens it in the browser. Never
   opens anything under CI, in tests, or on a Linux box without a display. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function dashboardPath(repoName: string): string {
  return path.join(os.tmpdir(), `tally-dashboard-${repoName.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'repo'}.html`);
}

export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI || env.TALLY_NO_OPEN || env.VITEST) return false;
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

export function writeAndOpen(html: string, file: string, open: boolean): { file: string; opened: boolean } {
  fs.writeFileSync(file, html);
  if (!open || !canOpenBrowser()) return { file, opened: false };
  try {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : ['xdg-open', [file]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return { file, opened: true };
  } catch {
    return { file, opened: false };
  }
}
