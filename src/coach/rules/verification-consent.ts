import type { Rule } from '../types.js';
import { testRerunConsent } from '../../config.js';
import { detectTestCommand } from '../../judge/verify.js';

/* Asked once per repo. [a] grants, [s] or [m] declines; either answer is stored and the rule never fires again. */
export const verificationConsent: Rule = {
  id: 'verification-consent',
  describe: 'Ask once per repo whether the Judge may re-run the test suite',
  evaluate(ctx) {
    if (!ctx.cfg.judge.run_tests) return [];
    if (testRerunConsent(ctx.cfg, ctx.cwd) !== undefined) return [];
    const detected = detectTestCommand(ctx.cwd);
    if (!detected) return [];
    if (!ctx.events.some((e) => e.type === 'prompt')) return [];
    return [
      {
        rule: this.id,
        key: 'consent:test-rerun',
        severity: 'info',
        title: 'May the Judge run your tests?',
        message: `To verify claims independently, the receipt re-runs \`${detected.command}\` (${detected.basis}) in this repo with a scrubbed environment and a ${Math.round(ctx.cfg.judge.test_timeout_ms / 1000)}s timeout. Without it, test-related criteria are marked "unverifiable (tests not run: no consent)". Asked once per repo.`,
        usd_saved: 0,
        action: { kind: 'consent', label: 'Allow test re-runs in this repo (skip = no)', command: detected.command },
      },
    ];
  },
};
