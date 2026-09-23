#!/usr/bin/env node
import { createRequire as __tallyCreateRequire } from "node:module";
const require = __tallyCreateRequire(import.meta.url);

// src/hooks/hook.ts
import fs3 from "node:fs";
import path3 from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/paths.ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
function tallyHome() {
  return process.env.TALLY_HOME || path.join(os.homedir(), ".tally");
}
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}
function sessionsDir() {
  return path.join(tallyHome(), "sessions");
}
function sessionDir(id) {
  return path.join(sessionsDir(), safeId(id));
}
function safeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function historyFile() {
  return path.join(tallyHome(), "history.jsonl");
}
function configFile() {
  return path.join(tallyHome(), "config.json");
}
function activeFile() {
  return path.join(tallyHome(), "active.json");
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}
function repoKey(cwd) {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// src/redact.ts
var PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***"],
  [/sk-[A-Za-z0-9]{20,}/g, "sk-***"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA***"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/lin_api_[A-Za-z0-9]{10,}/g, "lin_api_***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1***"],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1***$2"],
  [/((?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[=:]\s*["']?)([^\s"'&,;]{6,})/gi, "$1***"],
  [/(https?:\/\/[^\s:@/]+:)[^\s@/]+(@)/g, "$1***$2"]
];
function redact(text) {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

// src/judge/quickcheck.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { spawnSync } from "node:child_process";
function safeRegex(p) {
  try {
    return new RegExp(p, "i");
  } catch {
    return null;
  }
}
function baseHead(session) {
  const f = path2.join(sessionDir(session), "events.jsonl");
  if (!fs2.existsSync(f)) return void 0;
  for (const line of fs2.readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"session_start"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "session_start" && e.data?.git_head) return e.data.git_head;
    } catch {
    }
  }
  return void 0;
}
function gitDiff(cwd, base) {
  if (!fs2.existsSync(path2.join(cwd, ".git"))) return { files: [], text: "" };
  const range = base ? [base] : ["HEAD"];
  const names = spawnSync("git", ["diff", "--name-only", ...range], { cwd, encoding: "utf8", windowsHide: true, timeout: 3e3 });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8", windowsHide: true, timeout: 3e3 });
  const files = [...(names.stdout ?? "").split("\n"), ...(untracked.stdout ?? "").split("\n")].map((s) => s.trim()).filter(Boolean);
  const diff = spawnSync("git", ["diff", "--no-color", ...range], { cwd, encoding: "utf8", windowsHide: true, timeout: 3e3, maxBuffer: 8 * 1024 * 1024 });
  return { files, text: diff.stdout ?? "" };
}
var norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
function quickChecks(session, cwd) {
  const task = readJson(path2.join(sessionDir(session), "task.json"), null);
  const criteria = task?.criteria ?? [];
  const items = [];
  let diff = null;
  const getDiff = () => diff ??= cwd ? gitDiff(cwd, baseHead(session)) : { files: [], text: "" };
  for (const c of criteria) {
    const ch = c.check;
    if (!ch || ch.kind === "none") {
      items.push({ id: c.id, text: c.text, kind: "judgment", status: "unknown", why: "needs the Judge (a reader decides this one)" });
      continue;
    }
    if (ch.kind === "file_exists" && ch.path && cwd) {
      const ok = fs2.existsSync(path2.join(cwd, ch.path));
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: ok ? "met" : "unmet", why: `${ch.path} ${ok ? "exists" : "does not exist"}` });
    } else if (ch.kind === "file_contains" && ch.path && ch.pattern && cwd) {
      const p = path2.join(cwd, ch.path);
      const re = safeRegex(ch.pattern);
      if (!fs2.existsSync(p)) items.push({ id: c.id, text: c.text, kind: ch.kind, status: "unmet", why: `${ch.path} does not exist` });
      else if (!re) items.push({ id: c.id, text: c.text, kind: ch.kind, status: "unknown", why: "invalid pattern" });
      else {
        const ok = re.test(fs2.readFileSync(p, "utf8"));
        items.push({ id: c.id, text: c.text, kind: ch.kind, status: ok ? "met" : "unmet", why: `${ch.path} ${ok ? "matches" : "does not match"} /${ch.pattern}/` });
      }
    } else if (ch.kind === "file_changed" && ch.path) {
      const d = getDiff();
      const want = norm(ch.path);
      const hit = ch.path === "." || ch.path === "*" ? d.files[0] : d.files.find((f) => norm(f) === want || norm(f).endsWith("/" + want) || want.endsWith("/" + norm(f)));
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: hit ? "met" : "unmet", why: hit ? `${hit} is changed` : `${ch.path} is not changed yet (${d.files.length} file(s) changed so far)` });
    } else if (ch.kind === "diff_contains" && ch.pattern) {
      const d = getDiff();
      const re = safeRegex(ch.pattern);
      const ok = !!re && re.test(d.text);
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: ok ? "met" : "unmet", why: ok ? `the diff matches /${ch.pattern}/` : `the diff does not match /${ch.pattern}/ yet` });
    } else {
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: "unknown", why: ch.kind === "tests_pass" ? "tests are run by the Judge (tally judge), not here" : ch.kind === "pr" ? "decided by the push / PR events at judge time" : `${ch.kind} is run by the Judge` });
    }
  }
  const checked = items.filter((i) => i.status !== "unknown").length;
  const progress = { ts: (/* @__PURE__ */ new Date()).toISOString(), met: items.filter((i) => i.status === "met").length, checked, total: items.length, items };
  try {
    writeJson(path2.join(sessionDir(session), "progress.json"), progress);
  } catch {
  }
  return progress;
}

// src/hooks/hook.ts
var here = path3.dirname(fileURLToPath(import.meta.url));
var CLI = process.env.TALLY_HOOK_CLI || [path3.join(here, "cli.js"), path3.join(here, "..", "cli.js")].find((p) => fs3.existsSync(p)) || path3.join(here, "cli.js");
var SHIP_RE = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/;
var TASK_URL_RE = /https?:\/\/(github\.com\/[^\s/]+\/[^\s/]+\/(issues|pull)\/\d+|[^\s]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|linear\.app\/[^\s]+\/issue\/[A-Z0-9]+-\d+[^\s]*)/;
var TASK_MD_RE = /(?:^|\s)((?:[A-Za-z]:)?[^\s"']+\.md)(?=\s|$)/;
var MAX_FIELD = 2e3;
function readStdin() {
  try {
    return fs3.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function truncate(s, n = MAX_FIELD) {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? str.slice(0, n) + `\u2026[+${str.length - n}]` : str;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function record(session, type, cwd, data) {
  const ev = { ts: nowIso(), type, session, cwd, data: redactDeep(data) };
  appendLine(path3.join(sessionDir(session), "events.jsonl"), JSON.stringify(ev));
}
function alreadySeen(session, event, toolUseId) {
  if (!toolUseId) return false;
  const file = path3.join(sessionDir(session), "seen.txt");
  const key = `${event}:${toolUseId}
`;
  try {
    if (fs3.existsSync(file) && fs3.readFileSync(file, "utf8").includes(key)) return true;
    fs3.appendFileSync(file, key);
  } catch {
  }
  return false;
}
function spawnDetached(args) {
  if (process.env.TALLY_NO_SPAWN) {
    appendLine(path3.join(tallyHome(), "spawn.log"), JSON.stringify({ ts: nowIso(), args }));
    return;
  }
  try {
    const child = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.unref();
  } catch {
  }
}
function gitHead(cwd) {
  if (!cwd) return void 0;
  try {
    let dir = cwd;
    for (let i = 0; i < 6; i++) {
      const gitPath = path3.join(dir, ".git");
      if (fs3.existsSync(gitPath)) {
        let gitDir = gitPath;
        if (fs3.statSync(gitPath).isFile()) {
          const m = /gitdir:\s*(.+)/.exec(fs3.readFileSync(gitPath, "utf8"));
          if (!m) return void 0;
          gitDir = path3.resolve(dir, m[1].trim());
        }
        const head = fs3.readFileSync(path3.join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*(.+)$/.exec(head);
        if (!ref) return head;
        const refFile = path3.join(gitDir, ref[1]);
        if (fs3.existsSync(refFile)) return fs3.readFileSync(refFile, "utf8").trim();
        const packed = path3.join(gitDir, "packed-refs");
        if (fs3.existsSync(packed)) {
          for (const line of fs3.readFileSync(packed, "utf8").split("\n")) {
            const [sha, name] = line.split(" ");
            if (name === ref[1]) return sha;
          }
        }
        return void 0;
      }
      const parent = path3.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return void 0;
}
function loadedInventory(cwd) {
  const mcp = /* @__PURE__ */ new Set();
  const skills = /* @__PURE__ */ new Set();
  const plugins = /* @__PURE__ */ new Set();
  try {
    const home = claudeHome();
    const global = readJson(path3.join(path3.dirname(home), ".claude.json"), {});
    for (const k of Object.keys(global.mcpServers ?? {})) mcp.add(k);
    if (cwd) for (const k of Object.keys(global.projects?.[cwd]?.mcpServers ?? {})) mcp.add(k);
    if (cwd) {
      const proj = readJson(path3.join(cwd, ".mcp.json"), {});
      for (const k of Object.keys(proj.mcpServers ?? {})) mcp.add(k);
    }
    const settings = readJson(path3.join(home, "settings.json"), {});
    for (const [k, v] of Object.entries(settings.enabledPlugins ?? {})) if (v) plugins.add(k.split("@")[0]);
    const skillDirs = [path3.join(home, "skills"), cwd ? path3.join(cwd, ".claude", "skills") : ""].filter(Boolean);
    for (const d of skillDirs) {
      if (!fs3.existsSync(d)) continue;
      for (const s of fs3.readdirSync(d)) if (fs3.existsSync(path3.join(d, s, "SKILL.md"))) skills.add(s);
    }
  } catch {
  }
  return { mcp: [...mcp], skills: [...skills], plugins: [...plugins] };
}
function updateActive(session, patch, remove = false) {
  const file = activeFile();
  const active = readJson(file, {});
  if (remove) delete active[session];
  else active[session] = { ...active[session] ?? {}, ...patch, last_seen: nowIso() };
  const cutoff = Date.now() - 24 * 3600 * 1e3;
  for (const [k, v] of Object.entries(active)) if (Date.parse(String(v.last_seen ?? "")) < cutoff) delete active[k];
  writeJson(file, active);
}
function dodGate(session, cwd, stopHookActive) {
  if (stopHookActive || !fs3.existsSync(path3.join(sessionDir(session), "task.json"))) return void 0;
  const cfg = readJson(configFile(), {});
  if (cfg.coach?.dod_gate === false) return void 0;
  const max = cfg.coach?.dod_max_blocks ?? 1;
  const marker = path3.join(sessionDir(session), "dod-gate.json");
  const state = readJson(marker, { blocks: 0 });
  const progress = quickChecks(session, cwd);
  const unmet = progress.items.filter((i) => i.status === "unmet");
  if (!unmet.length || state.blocks >= max) return void 0;
  writeJson(marker, { blocks: state.blocks + 1, ts: nowIso(), unmet: unmet.map((u) => u.id) });
  record(session, "dod_gate", cwd, { unmet: unmet.map((u) => u.id), block: state.blocks + 1 });
  const reason = `Tally: ${unmet.length} acceptance criteri${unmet.length === 1 ? "on is" : "a are"} still unmet by mechanical check: ${unmet.map((u) => `${u.id} "${u.text}" (${u.why})`).join("; ")}. Address ${unmet.length === 1 ? "it" : "them"}, or say why ${unmet.length === 1 ? "it is" : "they are"} out of scope.`;
  return { decision: "block", reason };
}
function autopilotEnabled() {
  const cfg = readJson(configFile(), {});
  return cfg.coach?.autopilot !== false;
}
function lastReceipt(cwd) {
  if (!cwd) return "";
  const key = repoKey(cwd);
  const file = historyFile();
  if (!fs3.existsSync(file)) return "";
  const lines = fs3.readFileSync(file, "utf8").trim().split("\n").slice(-300);
  for (const line of lines.reverse()) {
    try {
      const h = JSON.parse(line);
      if (h.repo !== key || !h.verdict || h.internal) continue;
      const money = (n) => `$${(n ?? 0).toFixed(2)}`;
      return `Tally: last receipt in this repo: "${h.task_title ?? "task"}" ${h.completion_pct ?? 0}% complete, ${money(h.cost_usd)} spent, ${money(h.waste_usd)} waste, verdict ${h.final_verdict ?? h.verdict}${h.final_status && h.final_status !== "unknown" ? ` (${h.final_status})` : ""}.`;
    } catch {
    }
  }
  return "";
}
function historyLessons(cwd) {
  if (!cwd) return "";
  const key = repoKey(cwd);
  const file = historyFile();
  if (!fs3.existsSync(file)) return "";
  const lines = fs3.readFileSync(file, "utf8").trim().split("\n").slice(-200);
  const lessons = [];
  for (const line of lines.reverse()) {
    try {
      const h = JSON.parse(line);
      if (h.repo !== key) continue;
      for (const r of h.recommendations ?? []) if (lessons.length < 3 && !lessons.includes(r)) lessons.push(r);
      if (h.final_status === "reverted" || h.final_status === "needed rework") {
        const l = `Last time "${h.task_title ?? "a task"}" was judged ${h.verdict ?? ""} but later ${h.final_status}. Verify against the acceptance criteria before shipping.`;
        if (lessons.length < 3 && !lessons.includes(l)) lessons.push(l);
      }
      if (lessons.length >= 3) break;
    } catch {
    }
  }
  return lessons.length ? `Tally: past receipts in this repo recorded these lessons:
- ${lessons.join("\n- ")}` : "";
}
function deliverInjects(session) {
  const file = path3.join(sessionDir(session), "inject.jsonl");
  if (!fs3.existsSync(file)) return "";
  const lines = fs3.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const pending = [];
  const kept = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.delivered) kept.push(line);
      else {
        pending.push(item.note);
        kept.push(JSON.stringify({ ...item, delivered: true, delivered_at: nowIso() }));
      }
    } catch {
    }
  }
  if (!pending.length) return "";
  fs3.writeFileSync(file, kept.join("\n") + "\n");
  return pending.map((n) => `Tally: ${n}`).join("\n");
}
function followupDue() {
  const state = readJson(path3.join(tallyHome(), "followup-state.json"), {});
  const last = state.last_run ? Date.parse(state.last_run) : 0;
  return Date.now() - last > 24 * 3600 * 1e3;
}
function main() {
  if (process.env.TALLY_INTERNAL) return;
  const raw = readStdin();
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  if (!input || typeof input !== "object") input = {};
  const event = process.argv[2] || input.hook_event_name || "Unknown";
  const session = String(input.session_id || "unknown");
  const cwd = input.cwd;
  ensureDir(sessionDir(session));
  let out;
  switch (event) {
    case "SessionStart": {
      const loaded = loadedInventory(cwd);
      record(session, "session_start", cwd, {
        source: input.source,
        model: input.model,
        transcript_path: input.transcript_path,
        git_head: gitHead(cwd),
        loaded
      });
      updateActive(session, { cwd, transcript_path: input.transcript_path, model: input.model, started: nowIso() });
      const ctx = [lastReceipt(cwd), historyLessons(cwd), deliverInjects(session)].filter(Boolean).join("\n");
      if (ctx) out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } };
      if (followupDue()) spawnDetached(["followup", "--auto"]);
      break;
    }
    case "UserPromptSubmit": {
      const prompt = String(input.prompt ?? "");
      const isFirst = !fs3.existsSync(path3.join(sessionDir(session), "task.json")) && !fs3.existsSync(path3.join(sessionDir(session), "task.pending"));
      record(session, "prompt", cwd, { prompt: truncate(prompt), chars: prompt.length });
      updateActive(session, { cwd, transcript_path: input.transcript_path });
      if (isFirst) {
        const url = TASK_URL_RE.exec(prompt)?.[0];
        const md = !url ? TASK_MD_RE.exec(prompt)?.[1] : void 0;
        const ref = url ?? (md && cwd && fs3.existsSync(path3.resolve(cwd, md)) ? path3.resolve(cwd, md) : void 0);
        if (ref) {
          fs3.writeFileSync(path3.join(sessionDir(session), "task.pending"), ref);
          spawnDetached(["task", ref, "--session", session, "--cwd", cwd ?? "", "--auto"]);
        } else if (prompt.trim().length > 0) {
          fs3.writeFileSync(path3.join(sessionDir(session), "task.pending"), "text");
          spawnDetached(["task", "--text", truncate(prompt, 4e3), "--session", session, "--cwd", cwd ?? "", "--auto"]);
        }
      }
      const ctx = deliverInjects(session);
      if (ctx) out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } };
      break;
    }
    case "PreToolUse": {
      if (alreadySeen(session, event, input.tool_use_id)) break;
      const stopFile = path3.join(sessionDir(session), "hard-stop.json");
      const cmd0 = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
      if (fs3.existsSync(stopFile) && !/budget\s+approve/.test(cmd0)) {
        const stop = readJson(stopFile, {});
        out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Tally: this session has spent $${(stop.spend_usd ?? 0).toFixed(2)} against the repo policy's $${(stop.budget_usd ?? 0).toFixed(2)} budget (hard stop). A human can lift it with: tally budget approve --note "<why>"` } };
        record(session, "hard_stop_denied", cwd, { tool_name: input.tool_name, tool_use_id: input.tool_use_id });
        break;
      }
      record(session, "pre_tool", cwd, {
        tool_name: input.tool_name,
        tool_input: shrinkInput(input.tool_input),
        tool_use_id: input.tool_use_id,
        agent: input.agent_id ?? null
      });
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      if (alreadySeen(session, event, input.tool_use_id)) break;
      const resp = input.tool_response;
      const respText = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
      const isError = event === "PostToolUseFailure" || !!resp && typeof resp === "object" && (resp.is_error === true || resp.interrupted === true) || /^\s*(Error|error:|Command failed|Exit code [1-9])/.test(respText);
      record(session, "post_tool", cwd, {
        tool_name: input.tool_name,
        tool_input: shrinkInput(input.tool_input),
        tool_use_id: input.tool_use_id,
        is_error: isError,
        response_chars: respText.length,
        response_head: truncate(respText, 600),
        agent: input.agent_id ?? null
      });
      const cmd = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
      if (input.tool_name === "Bash" && cmd && SHIP_RE.test(cmd) && !isError) {
        const kind = /gh\s+pr\s+create/.test(cmd) ? "pr" : /gh\s+pr\s+merge/.test(cmd) ? "merge" : /publish|upload/.test(cmd) ? "publish" : "push";
        const url = /https?:\/\/\S+/.exec(respText)?.[0];
        record(session, "ship", cwd, { kind, command: redact(cmd), url });
        spawnDetached(["judge", session, "--auto", "--reason", kind]);
      }
      break;
    }
    case "Stop": {
      record(session, "stop", cwd, { last_assistant_message: truncate(input.last_assistant_message, 800) });
      updateActive(session, { cwd, transcript_path: input.transcript_path });
      const gate = dodGate(session, cwd, input.stop_hook_active === true);
      if (gate) out = gate;
      if (autopilotEnabled()) spawnDetached(["coach", "--tick", "--session", session, "--cwd", cwd ?? "", "--auto"]);
      break;
    }
    case "PreCompact": {
      record(session, "pre_compact", cwd, { trigger: input.trigger });
      break;
    }
    case "Notification": {
      record(session, "permission", cwd, { notification_type: input.notification_type, message: truncate(input.message, 400) });
      break;
    }
    case "SessionEnd": {
      record(session, "session_end", cwd, { reason: input.reason, transcript_path: input.transcript_path });
      updateActive(session, {}, true);
      spawnDetached(["finalize", session, "--auto"]);
      break;
    }
    default: {
      record(session, "note", cwd, { event, keys: Object.keys(input) });
    }
  }
  if (out) process.stdout.write(JSON.stringify(out));
}
function shrinkInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (k === "content" || k === "new_string" || k === "old_string") out[k] = truncate(v, 300);
    else out[k] = typeof v === "string" ? truncate(v, 600) : v;
  }
  return out;
}
try {
  main();
} catch {
}
process.exitCode = 0;
