/* Renders a captured `tally demo --plain --fast` transcript into docs/demo.cast (asciinema v2) and docs/demo.svg
   (an animated SVG that plays in a README). The text is the real demo output; only the timing is synthetic and
   the throwaway temp paths are shortened. Usage: node scripts/render-demo.mjs <captured-output.txt> */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/render-demo.mjs <captured demo output>');

const raw = fs
  .readFileSync(src, 'utf8')
  .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp\\(tally-demo-[A-Za-z0-9]+)/g, '/tmp/$1')
  .replace(/[A-Za-z]:\/Users\/[^/\s]+\/AppData\/Local\/Temp\/(tally-demo-[A-Za-z0-9]+)/g, '/tmp/$1')
  .replace(/\\/g, '/')
  .replace(/\r/g, '');
const lines = raw.split('\n');
while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

/* asciinema v2: one output event per line, paced so the whole run takes ~50 s */
const cols = 110;
const rows = 40;
const events = [];
let t = 0.3;
events.push([t, 'o', '$ tally demo\r\n']);
for (const line of lines) {
  const heavy = /^\[\d\]|^Tally receipt|^BORDERLINE|^!!/.test(line);
  t += heavy ? 1.2 : /^\s+\d\d:\d\d:\d\d/.test(line) ? 0.18 : 0.32;
  events.push([Number(t.toFixed(2)), 'o', line + '\r\n']);
}
t += 2;
const cast = [JSON.stringify({ version: 2, width: cols, height: rows, timestamp: 1789000000, title: 'tally demo (real output, synthetic timing)', env: { SHELL: '/bin/bash', TERM: 'xterm-256color' } }), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'demo.cast'), cast);

/* animated SVG: a scrolling terminal, each frame shows the last `rows` lines at that time */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colour = (line) => (/^!!/.test(line) ? '#f87171' : /^ ! /.test(line) ? '#fbbf24' : /^ · /.test(line) ? '#60a5fa' : /^\[\d\]/.test(line) ? '#a78bfa' : /→ \[|✔|passed/.test(line) ? '#4ade80' : /✘|FAIL|reverted|NOT WORTH IT/.test(line) ? '#f87171' : /^Tally receipt|^BORDERLINE/.test(line) ? '#f9fafb' : /^\s+\d\d:\d\d:\d\d/.test(line) ? '#9ca3af' : '#d1d5db');
const lineH = 17;
const charW = 7.2;
const width = Math.round(cols * charW + 32);
const height = rows * lineH + 40;
const total = t;
const shown = events.slice(1).map((e) => ({ at: e[0], text: e[2].replace(/\r\n$/, '') }));
const frames = [];
for (let i = 0; i < shown.length; i++) {
  const visible = shown.slice(Math.max(0, i + 1 - rows), i + 1);
  frames.push({ at: shown[i].at, visible });
}
let body = '';
frames.forEach((f, i) => {
  const begin = f.at.toFixed(2);
  /* the last frame stays on screen once the run finishes */
  const end = i + 1 < frames.length ? ` end="${frames[i + 1].at.toFixed(2)}s"` : '';
  body += `<g visibility="hidden"><set attributeName="visibility" to="visible" begin="${begin}s"${end}/>`;
  f.visible.forEach(({ text: line }, j) => {
    const cut = line.length > cols ? line.slice(0, cols - 1) + '…' : line;
    body += `<text x="16" y="${34 + j * lineH}" fill="${colour(line)}">${esc(cut)}</text>`;
  });
  body += '</g>';
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12.5">
<title>tally demo: real output, animated</title>
<rect width="100%" height="100%" rx="8" fill="#0b0f19"/>
<circle cx="18" cy="14" r="5" fill="#ef4444"/><circle cx="36" cy="14" r="5" fill="#f59e0b"/><circle cx="54" cy="14" r="5" fill="#22c55e"/>
<text x="${Math.round(width / 2)}" y="18" text-anchor="middle" fill="#6b7280" font-size="11">tally demo · real output, timing compressed · ${Math.round(total)}s</text>
<g><text x="16" y="34" fill="#d1d5db">$ tally demo</text><set attributeName="visibility" to="hidden" begin="${shown[0].at.toFixed(2)}s"/></g>
${body}
</svg>
`;
fs.writeFileSync(path.join(root, 'docs', 'demo.svg'), svg);
process.stdout.write(`docs/demo.cast (${events.length} events, ${Math.round(total)}s) and docs/demo.svg (${Math.round(svg.length / 1024)} KB, ${frames.length} frames)\n`);
