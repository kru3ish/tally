/* The one-time usefulness question at the terminal. Asked once after the fifth real verification, never again after any
   answer including skip, never in CI or a non-interactive shell. The answer stays local (usefulness.json); telemetry,
   when enabled, counts the answer and nothing else about it. */
import readline from 'node:readline';
import { countVerification, shouldAskUsefulness, recordUsefulness, parseUsefulnessAnswer, USEFULNESS_QUESTION } from './store.js';

export { countVerification, shouldAskUsefulness };

export async function askUsefulness(io: { question?: (q: string) => Promise<string>; out?: (s: string) => void } = {}): Promise<'yes' | 'no' | 'skip'> {
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
  out('\nOne question, asked once: ');
  const answer = parseUsefulnessAnswer(await question(USEFULNESS_QUESTION));
  recordUsefulness(answer);
  out(answer === 'yes' ? 'Good to know. `tally feedback` on the criterion that caught it helps the calibration.\n' : answer === 'no' ? 'Noted. If a verdict was wrong, `tally feedback wrong <c#> --report` is the fastest way to get it fixed.\n' : 'Skipped; it will not ask again.\n');
  return answer;
}
