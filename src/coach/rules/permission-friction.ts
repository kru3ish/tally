import path from 'node:path';
import type { Rule, Suggestion } from '../types.js';
import { countBy } from '../helpers.js';

export const PERMISSION_THRESHOLD = 2;

const SAFE_PREFIXES = ['git status', 'git diff', 'git log', 'npm test', 'npm run', 'npx vitest', 'npx tsc', 'pytest', 'python -m pytest', 'go test', 'cargo test', 'ls', 'cat', 'grep', 'rg', 'find', 'node ', 'bun test', 'pnpm test', 'yarn test', 'make test', 'gh pr view', 'gh issue view'];

export function commandPrefix(message: string): string | null {
  const m = /Bash\(([^)]+)\)/.exec(message) ?? /`([^`]+)`/.exec(message) ?? /(?:run|execute|use)\s+(?:the\s+)?(?:command\s+)?[`"']?([^`"'\n]+)/i.exec(message);
  const cmd = (m?.[1] ?? '').trim();
  if (!cmd) return null;
  for (const p of SAFE_PREFIXES) if (cmd.startsWith(p)) return p.trim();
  return cmd.split(/\s+/).slice(0, 2).join(' ');
}

export const permissionFriction: Rule = {
  id: 'permission-friction',
  describe: 'Repeated permission prompts for the same safe command',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const perms = ctx.events.filter((e) => e.type === 'permission');
    const byPrefix = countBy(perms, (e) => commandPrefix(String(e.data.message ?? '')) ?? '');
    for (const [prefix, evs] of byPrefix) {
      if (evs.length < PERMISSION_THRESHOLD) continue;
      const safe = SAFE_PREFIXES.some((p) => p.trim() === prefix);
      const rule = `Bash(${prefix}:*)`;
      out.push({
        rule: this.id,
        key: `perm:${prefix}`,
        severity: 'info',
        title: `${evs.length} prompts for \`${prefix}\``,
        message: `You've approved \`${prefix}\` ${evs.length} times this session${safe ? ' and it is read-only or a test runner' : ''}. Add \`${rule}\` to the allowlist, or run /fewer-permission-prompts to do this for everything at once.`,
        usd_saved: 0,
        action: {
          kind: 'settings',
          label: `Add ${rule} to .claude/settings.local.json`,
          file: path.join(ctx.cwd, '.claude', 'settings.local.json'),
          patch: { permissions: { allow: [rule] } },
          snippet: JSON.stringify({ permissions: { allow: [rule] } }, null, 2),
        },
      });
    }
    return out;
  },
};
