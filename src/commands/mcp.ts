/* `tally mcp` runs the MCP server on stdio (what the plugin manifest starts); `tally mcp --install` registers it for
   CLI installs through `claude mcp add`, so Claude can call tally_task / tally_unmet / tally_receipt / tally_flags. */
import { spawnSync } from 'node:child_process';
import { type Args, has } from '../cli.js';
import { serve } from '../mcp/server.js';
import { builtCliPath } from '../paths.js';
import { resolveClaudeBin } from '../llm/client.js';

export async function run(args: Args): Promise<number | void> {
  if (has(args, 'install') || has(args, 'uninstall')) {
    const claude = resolveClaudeBin(process.env.TALLY_CLAUDE_BIN);
    const cli = builtCliPath().replace(/\\/g, '/');
    const argv = has(args, 'install') ? [...claude.prefix, 'mcp', 'add', '--scope', 'user', 'tally', '--', 'node', cli, 'mcp'] : [...claude.prefix, 'mcp', 'remove', '--scope', 'user', 'tally'];
    const r = spawnSync(claude.bin, argv, { encoding: 'utf8', windowsHide: true });
    process.stdout.write((r.stdout || '') + (r.stderr || ''));
    if (r.status === 0) process.stdout.write(has(args, 'install') ? 'Tally MCP server registered (user scope). Claude can now call tally_task, tally_unmet, tally_receipt and tally_flags in every session.\n' : 'Tally MCP server removed.\n');
    return r.status ?? 1;
  }
  serve(process.cwd());
  await new Promise(() => {});
}
