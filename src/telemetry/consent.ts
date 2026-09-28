/* The first-run consent question for anonymous metrics. Default No; asked once; the answer is stored either way. */
import readline from 'node:readline';
import { shouldAskConsent, enableTelemetry, markAsked, CONSENT_QUESTION } from './index.js';

export { shouldAskConsent };

export async function askConsent(io: { question?: (q: string) => Promise<string>; out?: (s: string) => void } = {}): Promise<boolean> {
  const out = io.out ?? ((s: string) => process.stdout.write(s));
  const question =
    io.question ??
    ((q: string) =>
      new Promise<string>((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => {
          rl.close();
          res(a);
        });
      }));
  const answer = (await question(CONSENT_QUESTION)).trim().toLowerCase();
  const yes = answer === 'y' || answer === 'yes';
  if (yes) {
    const s = enableTelemetry();
    out(`On. Installation id ${s.installation_id}. \`tally telemetry show\` prints exactly what is sent; \`tally telemetry off\` turns it off and deletes the id.\n\n`);
  } else {
    markAsked();
    out('Off. It will not ask again; `tally telemetry on` enables it later.\n\n');
  }
  return yes;
}
