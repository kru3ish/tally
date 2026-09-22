#!/usr/bin/env node
import { createRequire as __tallyCreateRequire } from "node:module";
const require = __tallyCreateRequire(import.meta.url);

// src/hooks/hook.ts
import fs2 from "node:fs";
import path2 from "node:path";
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

// src/hooks/hook.ts
var here = path2.dirname(fileURLToPath(import.meta.url));
var CLI = process.env.TALLY_HOOK_CLI || [path2.join(here, "cli.js"), path2.join(here, "..", "cli.js")].find((p) => fs2.existsSync(p)) || path2.join(here, "cli.js");
var SHIP_RE = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/;
var TASK_URL_RE = /https?:\/\/(github\.com\/[^\s/]+\/[^\s/]+\/(issues|pull)\/\d+|[^\s]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|linear\.app\/[^\s]+\/issue\/[A-Z0-9]+-\d+[^\s]*)/;
var TASK_MD_RE = /(?:^|\s)((?:[A-Za-z]:)?[^\s"']+\.md)(?=\s|$)/;
var MAX_FIELD = 2e3;
function readStdin() {
  try {
    return fs2.readFileSync(0, "utf8");
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
  appendLine(path2.join(sessionDir(session), "events.jsonl"), JSON.stringify(ev));
}
function alreadySeen(session, event, toolUseId) {
  if (!toolUseId) return false;
  const file = path2.join(sessionDir(session), "seen.txt");
  const key = `${event}:${toolUseId}
`;
  try {
    if (fs2.existsSync(file) && fs2.readFileSync(file, "utf8").includes(key)) return true;
    fs2.appendFileSync(file, key);
  } catch {
  }
  return false;
}
function spawnDetached(args) {
  if (process.env.TALLY_NO_SPAWN) {
    appendLine(path2.join(tallyHome(), "spawn.log"), JSON.stringify({ ts: nowIso(), args }));
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
      const gitPath = path2.join(dir, ".git");
      if (fs2.existsSync(gitPath)) {
        let gitDir = gitPath;
        if (fs2.statSync(gitPath).isFile()) {
          const m = /gitdir:\s*(.+)/.exec(fs2.readFileSync(gitPath, "utf8"));
          if (!m) return void 0;
          gitDir = path2.resolve(dir, m[1].trim());
        }
        const head = fs2.readFileSync(path2.join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*(.+)$/.exec(head);
        if (!ref) return head;
        const refFile = path2.join(gitDir, ref[1]);
        if (fs2.existsSync(refFile)) return fs2.readFileSync(refFile, "utf8").trim();
        const packed = path2.join(gitDir, "packed-refs");
        if (fs2.existsSync(packed)) {
          for (const line of fs2.readFileSync(packed, "utf8").split("\n")) {
            const [sha, name] = line.split(" ");
            if (name === ref[1]) return sha;
          }
        }
        return void 0;
      }
      const parent = path2.dirname(dir);
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
    const global = readJson(path2.join(path2.dirname(home), ".claude.json"), {});
    for (const k of Object.keys(global.mcpServers ?? {})) mcp.add(k);
    if (cwd) for (const k of Object.keys(global.projects?.[cwd]?.mcpServers ?? {})) mcp.add(k);
    if (cwd) {
      const proj = readJson(path2.join(cwd, ".mcp.json"), {});
      for (const k of Object.keys(proj.mcpServers ?? {})) mcp.add(k);
    }
    const settings = readJson(path2.join(home, "settings.json"), {});
    for (const [k, v] of Object.entries(settings.enabledPlugins ?? {})) if (v) plugins.add(k.split("@")[0]);
    const skillDirs = [path2.join(home, "skills"), cwd ? path2.join(cwd, ".claude", "skills") : ""].filter(Boolean);
    for (const d of skillDirs) {
      if (!fs2.existsSync(d)) continue;
      for (const s of fs2.readdirSync(d)) if (fs2.existsSync(path2.join(d, s, "SKILL.md"))) skills.add(s);
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
function autopilotEnabled() {
  const cfg = readJson(configFile(), {});
  return cfg.coach?.autopilot !== false;
}
function lastReceipt(cwd) {
  if (!cwd) return "";
  const key = repoKey(cwd);
  const file = historyFile();
  if (!fs2.existsSync(file)) return "";
  const lines = fs2.readFileSync(file, "utf8").trim().split("\n").slice(-300);
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
  if (!fs2.existsSync(file)) return "";
  const lines = fs2.readFileSync(file, "utf8").trim().split("\n").slice(-200);
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
  const file = path2.join(sessionDir(session), "inject.jsonl");
  if (!fs2.existsSync(file)) return "";
  const lines = fs2.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
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
  fs2.writeFileSync(file, kept.join("\n") + "\n");
  return pending.map((n) => `Tally: ${n}`).join("\n");
}
function followupDue() {
  const state = readJson(path2.join(tallyHome(), "followup-state.json"), {});
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
      const isFirst = !fs2.existsSync(path2.join(sessionDir(session), "task.json")) && !fs2.existsSync(path2.join(sessionDir(session), "task.pending"));
      record(session, "prompt", cwd, { prompt: truncate(prompt), chars: prompt.length });
      updateActive(session, { cwd, transcript_path: input.transcript_path });
      if (isFirst) {
        const url = TASK_URL_RE.exec(prompt)?.[0];
        const md = !url ? TASK_MD_RE.exec(prompt)?.[1] : void 0;
        const ref = url ?? (md && cwd && fs2.existsSync(path2.resolve(cwd, md)) ? path2.resolve(cwd, md) : void 0);
        if (ref) {
          fs2.writeFileSync(path2.join(sessionDir(session), "task.pending"), ref);
          spawnDetached(["task", ref, "--session", session, "--cwd", cwd ?? "", "--auto"]);
        } else if (prompt.trim().length > 0) {
          fs2.writeFileSync(path2.join(sessionDir(session), "task.pending"), "text");
          spawnDetached(["task", "--text", truncate(prompt, 4e3), "--session", session, "--cwd", cwd ?? "", "--auto"]);
        }
      }
      const ctx = deliverInjects(session);
      if (ctx) out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } };
      break;
    }
    case "PreToolUse": {
      if (alreadySeen(session, event, input.tool_use_id)) break;
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
