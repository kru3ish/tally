#!/usr/bin/env node
import { createRequire as __tallyCreateRequire } from "node:module";
const require = __tallyCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/paths.ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
function isInternalCwd(cwd) {
  return !!cwd && cwd.replace(/\\/g, "/").toLowerCase().includes(INTERNAL_CWD_MARKER);
}
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
function pricingFile() {
  return path.join(tallyHome(), "pricing.json");
}
function experimentsFile() {
  return path.join(tallyHome(), "experiments.json");
}
function activeFile() {
  return path.join(tallyHome(), "active.json");
}
function undoLog() {
  return path.join(tallyHome(), "undo.jsonl");
}
function mutesFile() {
  return path.join(tallyHome(), "mutes.json");
}
function tallyLog() {
  return path.join(tallyHome(), "tally.log");
}
function encodeProjectDir(cwd) {
  return cwd.replace(/[:\\/.]/g, "-");
}
function projectTranscriptsDir(cwd) {
  return path.join(claudeHome(), "projects", encodeProjectDir(cwd));
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
function log(msg) {
  try {
    appendLine(tallyLog(), `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}`);
  } catch {
  }
}
function repoKey(cwd) {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function packageRoot() {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === "@kru3ish/tally") {
          cachedRoot = dir;
          return dir;
        }
      } catch {
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = dir;
  return dir;
}
function builtHookPath() {
  return path.join(packageRoot(), "dist", "hook.js");
}
function builtCliPath() {
  return path.join(packageRoot(), "dist", "cli.js");
}
var INTERNAL_CWD_MARKER, cachedRoot;
var init_paths = __esm({
  "src/paths.ts"() {
    "use strict";
    INTERNAL_CWD_MARKER = "tally-llm-";
    cachedRoot = null;
  }
});

// src/install/install.ts
import fs2 from "node:fs";
import path2 from "node:path";
function hookScriptPath() {
  return builtHookPath().replace(/\\/g, "/");
}
function hookCommand(event, scriptPath = hookScriptPath()) {
  return `node "${scriptPath}" ${event}`;
}
function isTallyHook(h) {
  if (!h || typeof h !== "object") return false;
  const o = h;
  const parts = [typeof o.command === "string" ? o.command : "", ...Array.isArray(o.args) ? o.args.map(String) : []];
  const joined = parts.join(" ");
  return /tally[^\s"']*[\\/](?:dist[\\/])?(?:hooks[\\/])?hook\.js/i.test(joined) || /CLAUDE_PLUGIN_ROOT\}?[\\/]dist[\\/](?:hooks[\\/])?hook\.js/i.test(joined);
}
function enabledPluginIds(cwd = process.cwd()) {
  const files = [path2.join(claudeHome(), "settings.json"), path2.join(claudeHome(), "settings.local.json"), path2.join(cwd, ".claude", "settings.json"), path2.join(cwd, ".claude", "settings.local.json")];
  const ids = /* @__PURE__ */ new Set();
  for (const f of files) {
    const s = readJson(f, {});
    for (const [k, v] of Object.entries(s.enabledPlugins ?? {})) if (v && /^tally@/i.test(k)) ids.add(k);
  }
  return [...ids];
}
function statusLineCommand(cliPath = builtCliPath()) {
  return `node "${cliPath.replace(/\\/g, "/")}" statusline`;
}
function isTallyStatusLine(v) {
  return !!v && typeof v === "object" && typeof v.command === "string" && /tally[^\s"']*[\\/]dist[\\/]cli\.js"?\s+statusline/i.test(v.command);
}
function installStatusLine(opts = {}) {
  const file = settingsPath("user");
  const command = statusLineCommand(opts.cliPath);
  const raw = fs2.existsSync(file) ? fs2.readFileSync(file, "utf8") : "";
  const settings = raw.trim() ? JSON.parse(raw) : {};
  const current = settings.statusLine;
  if (current && !isTallyStatusLine(current) && !opts.force) return { installed: false, file, command, reason: `A status line is already configured in ${file} (${String(current.command ?? current).slice(0, 80)}). Pass --force to replace it with Tally's.` };
  if (current && isTallyStatusLine(current) && current.command === command) return { installed: false, file, command, reason: `Tally's status line is already installed in ${file}.` };
  settings.statusLine = { type: "command", command, padding: 0 };
  ensureDir(path2.dirname(file));
  const indent = raw.trim() ? detectIndent(raw) : 2;
  fs2.writeFileSync(file, JSON.stringify(settings, null, indent) + (!raw || raw.endsWith("\n") ? "\n" : ""));
  return { installed: true, file, command };
}
function uninstallStatusLine() {
  const file = settingsPath("user");
  if (!fs2.existsSync(file)) return { removed: false };
  const raw = fs2.readFileSync(file, "utf8");
  const settings = JSON.parse(raw);
  if (!isTallyStatusLine(settings.statusLine)) return { removed: false };
  delete settings.statusLine;
  fs2.writeFileSync(file, JSON.stringify(settings, null, detectIndent(raw)) + (raw.endsWith("\n") ? "\n" : ""));
  return { removed: true };
}
function settingsPath(scope, cwd = process.cwd()) {
  return scope === "user" ? path2.join(claudeHome(), "settings.json") : path2.join(cwd, ".claude", "settings.json");
}
function detectIndent(raw) {
  const m = /\n([ \t]+)"/.exec(raw);
  return m ? m[1] : 2;
}
function backupDir() {
  return path2.join(tallyHome(), "backups");
}
function backup(file, scope) {
  ensureDir(backupDir());
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const dest = path2.join(backupDir(), `settings-${scope}-${stamp}.json`);
  if (!fs2.existsSync(file)) {
    fs2.writeFileSync(dest + ".missing", "");
    return dest + ".missing";
  }
  fs2.copyFileSync(file, dest);
  return dest;
}
function originalMarker(file) {
  return path2.join(backupDir(), "original-" + Buffer.from(file).toString("base64url") + ".json");
}
function install(opts) {
  const plugin = enabledPluginIds(opts.cwd);
  if (plugin.length && !opts.force) throw new PluginConflictError(plugin);
  const file = settingsPath(opts.scope, opts.cwd);
  const existed = fs2.existsSync(file);
  const raw = existed ? fs2.readFileSync(file, "utf8") : "";
  const bk = backup(file, opts.scope);
  const marker = originalMarker(file);
  if (!fs2.existsSync(marker)) {
    ensureDir(backupDir());
    if (existed) fs2.copyFileSync(file, marker);
    else fs2.writeFileSync(marker + ".missing", "");
  }
  const settings = existed && raw.trim() ? JSON.parse(raw) : {};
  settings.hooks ??= {};
  let added = 0;
  for (const { event, matcher, async } of HOOK_EVENTS) {
    const groups = settings.hooks[event] ??= [];
    const wanted = hookCommand(event, opts.scriptPath);
    for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => !(isTallyHook(h) && typeof h.command === "string" && h.command !== wanted && !fs2.existsSync(/"([^"]+hook\.js)"/.exec(h.command)?.[1] ?? "")));
    const already = groups.some((g) => (g.hooks ?? []).some(isTallyHook));
    if (already) continue;
    const hook = { type: "command", command: hookCommand(event, opts.scriptPath), timeout: 5 };
    if (async) hook.async = true;
    const group = { hooks: [hook] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
    added += 1;
  }
  let statusline = false;
  if (opts.scope === "user" && opts.statusline !== false && (!settings.statusLine || isTallyStatusLine(settings.statusLine))) {
    settings.statusLine = { type: "command", command: statusLineCommand(opts.scriptPath ? path2.join(path2.dirname(opts.scriptPath), "cli.js") : void 0), padding: 0 };
    statusline = true;
  }
  ensureDir(path2.dirname(file));
  const indent = existed && raw.trim() ? detectIndent(raw) : 2;
  const trailingNl = !existed || raw.endsWith("\n");
  fs2.writeFileSync(file, JSON.stringify(settings, null, indent) + (trailingNl ? "\n" : ""));
  return { file, added, backup: bk, statusline };
}
function uninstall(opts) {
  const file = settingsPath(opts.scope, opts.cwd);
  const marker = originalMarker(file);
  if (!fs2.existsSync(file)) {
    cleanupMarker(marker);
    return { file, removed: 0, restoredOriginal: false };
  }
  const raw = fs2.readFileSync(file, "utf8");
  const settings = JSON.parse(raw);
  let removed = 0;
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event] ?? [];
      const kept = [];
      for (const g of groups) {
        const before = (g.hooks ?? []).length;
        g.hooks = (g.hooks ?? []).filter((h) => !isTallyHook(h));
        removed += before - g.hooks.length;
        if (g.hooks.length) kept.push(g);
      }
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  if (isTallyStatusLine(settings.statusLine)) delete settings.statusLine;
  const hadOriginal = fs2.existsSync(marker);
  const originalMissing = fs2.existsSync(marker + ".missing");
  if (originalMissing) {
    if (Object.keys(settings).length === 0) {
      fs2.unlinkSync(file);
      cleanupMarker(marker);
      return { file, removed, restoredOriginal: true };
    }
  } else if (hadOriginal) {
    const originalRaw = fs2.readFileSync(marker, "utf8");
    try {
      if (deepEqual(JSON.parse(originalRaw), settings)) {
        fs2.writeFileSync(file, originalRaw);
        cleanupMarker(marker);
        return { file, removed, restoredOriginal: true };
      }
    } catch {
    }
  }
  const indent = detectIndent(raw);
  fs2.writeFileSync(file, JSON.stringify(settings, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  cleanupMarker(marker);
  return { file, removed, restoredOriginal: false };
}
function cleanupMarker(marker) {
  for (const f of [marker, marker + ".missing"]) if (fs2.existsSync(f)) fs2.unlinkSync(f);
}
function isInstalled(scope, cwd) {
  const file = settingsPath(scope, cwd);
  if (!fs2.existsSync(file)) return false;
  try {
    const s = JSON.parse(fs2.readFileSync(file, "utf8"));
    return Object.values(s.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isTallyHook)));
  } catch {
    return false;
  }
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
var HOOK_EVENTS, PluginConflictError;
var init_install = __esm({
  "src/install/install.ts"() {
    "use strict";
    init_paths();
    HOOK_EVENTS = [
      { event: "SessionStart", async: false },
      { event: "UserPromptSubmit", async: false },
      { event: "PreToolUse", async: true },
      { event: "PostToolUse", async: true },
      { event: "PostToolUseFailure", async: true },
      { event: "Stop", async: true },
      { event: "PreCompact", async: true },
      { event: "Notification", matcher: "permission_prompt", async: true },
      { event: "SessionEnd", async: false }
    ];
    PluginConflictError = class extends Error {
      constructor(ids) {
        super(`Tally is already enabled as a Claude Code plugin (${ids.join(", ")}), which installs these hooks itself. Installing again would record every event twice. Run /plugin uninstall tally first, or pass --force to install anyway.`);
        this.ids = ids;
      }
    };
  }
});

// src/cost/pricing.ts
import fs3 from "node:fs";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function bundledPricingPath() {
  const candidates = [path3.join(here, "pricing.json"), path3.join(here, "..", "..", "pricing.json"), path3.join(here, "..", "pricing.json")];
  for (const c of candidates) if (fs3.existsSync(c)) return c;
  return candidates[0];
}
function loadPricing() {
  if (cached) return cached;
  const bundled = readJson(bundledPricingPath(), null);
  const user = readJson(pricingFile(), null);
  const p = user ?? bundled;
  if (!p) throw new Error("pricing.json not found");
  cached = p;
  return p;
}
function canonicalModel(model, pricing = loadPricing()) {
  if (!model) return pricing.fallback;
  let m = model.toLowerCase().replace(/\[.*?\]/g, "").trim();
  if (pricing.aliases?.[m]) m = pricing.aliases[m];
  m = m.replace(/^(us|eu|apac)\./, "").replace(/^anthropic\./, "");
  const keys = Object.keys(pricing.models).sort((a, b) => b.length - a.length);
  for (const k of keys) if (m === k || m.startsWith(k + "-") || m.startsWith(k + "@")) return k;
  return pricing.fallback;
}
function priceFor(model, pricing = loadPricing()) {
  return pricing.models[canonicalModel(model, pricing)] ?? pricing.models[pricing.fallback];
}
function costOf(usage, model, pricing = loadPricing()) {
  const p = priceFor(model, pricing);
  const w1h = usage.cache_write_1h ?? 0;
  const w5m = Math.max(0, usage.cache_write - w1h);
  return (usage.input * p.input + usage.output * p.output + w5m * p.cache_write_5m + w1h * p.cache_write_1h + usage.cache_read * p.cache_read) / 1e6;
}
function isModel1M(model) {
  return !!model && /\[1m\]/i.test(model);
}
function emptyUsage() {
  return { input: 0, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
}
function addUsage(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_write: a.cache_write + b.cache_write,
    cache_write_1h: (a.cache_write_1h ?? 0) + (b.cache_write_1h ?? 0),
    cache_read: a.cache_read + b.cache_read
  };
}
function fmtUsd(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}
var here, cached;
var init_pricing = __esm({
  "src/cost/pricing.ts"() {
    "use strict";
    init_paths();
    here = path3.dirname(fileURLToPath2(import.meta.url));
    cached = null;
  }
});

// node_modules/zod/v3/helpers/util.js
var util, objectUtil, ZodParsedType, getParsedType;
var init_util = __esm({
  "node_modules/zod/v3/helpers/util.js"() {
    (function(util2) {
      util2.assertEqual = (_) => {
      };
      function assertIs(_arg) {
      }
      util2.assertIs = assertIs;
      function assertNever(_x) {
        throw new Error();
      }
      util2.assertNever = assertNever;
      util2.arrayToEnum = (items) => {
        const obj = {};
        for (const item of items) {
          obj[item] = item;
        }
        return obj;
      };
      util2.getValidEnumValues = (obj) => {
        const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
        const filtered = {};
        for (const k of validKeys) {
          filtered[k] = obj[k];
        }
        return util2.objectValues(filtered);
      };
      util2.objectValues = (obj) => {
        return util2.objectKeys(obj).map(function(e) {
          return obj[e];
        });
      };
      util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
        const keys = [];
        for (const key in object) {
          if (Object.prototype.hasOwnProperty.call(object, key)) {
            keys.push(key);
          }
        }
        return keys;
      };
      util2.find = (arr, checker) => {
        for (const item of arr) {
          if (checker(item))
            return item;
        }
        return void 0;
      };
      util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
      function joinValues(array, separator = " | ") {
        return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
      }
      util2.joinValues = joinValues;
      util2.jsonStringifyReplacer = (_, value) => {
        if (typeof value === "bigint") {
          return value.toString();
        }
        return value;
      };
    })(util || (util = {}));
    (function(objectUtil2) {
      objectUtil2.mergeShapes = (first, second) => {
        return {
          ...first,
          ...second
          // second overwrites first
        };
      };
    })(objectUtil || (objectUtil = {}));
    ZodParsedType = util.arrayToEnum([
      "string",
      "nan",
      "number",
      "integer",
      "float",
      "boolean",
      "date",
      "bigint",
      "symbol",
      "function",
      "undefined",
      "null",
      "array",
      "object",
      "unknown",
      "promise",
      "void",
      "never",
      "map",
      "set"
    ]);
    getParsedType = (data) => {
      const t = typeof data;
      switch (t) {
        case "undefined":
          return ZodParsedType.undefined;
        case "string":
          return ZodParsedType.string;
        case "number":
          return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
        case "boolean":
          return ZodParsedType.boolean;
        case "function":
          return ZodParsedType.function;
        case "bigint":
          return ZodParsedType.bigint;
        case "symbol":
          return ZodParsedType.symbol;
        case "object":
          if (Array.isArray(data)) {
            return ZodParsedType.array;
          }
          if (data === null) {
            return ZodParsedType.null;
          }
          if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
            return ZodParsedType.promise;
          }
          if (typeof Map !== "undefined" && data instanceof Map) {
            return ZodParsedType.map;
          }
          if (typeof Set !== "undefined" && data instanceof Set) {
            return ZodParsedType.set;
          }
          if (typeof Date !== "undefined" && data instanceof Date) {
            return ZodParsedType.date;
          }
          return ZodParsedType.object;
        default:
          return ZodParsedType.unknown;
      }
    };
  }
});

// node_modules/zod/v3/ZodError.js
var ZodIssueCode, quotelessJson, ZodError;
var init_ZodError = __esm({
  "node_modules/zod/v3/ZodError.js"() {
    init_util();
    ZodIssueCode = util.arrayToEnum([
      "invalid_type",
      "invalid_literal",
      "custom",
      "invalid_union",
      "invalid_union_discriminator",
      "invalid_enum_value",
      "unrecognized_keys",
      "invalid_arguments",
      "invalid_return_type",
      "invalid_date",
      "invalid_string",
      "too_small",
      "too_big",
      "invalid_intersection_types",
      "not_multiple_of",
      "not_finite"
    ]);
    quotelessJson = (obj) => {
      const json = JSON.stringify(obj, null, 2);
      return json.replace(/"([^"]+)":/g, "$1:");
    };
    ZodError = class _ZodError extends Error {
      get errors() {
        return this.issues;
      }
      constructor(issues) {
        super();
        this.issues = [];
        this.addIssue = (sub) => {
          this.issues = [...this.issues, sub];
        };
        this.addIssues = (subs = []) => {
          this.issues = [...this.issues, ...subs];
        };
        const actualProto = new.target.prototype;
        if (Object.setPrototypeOf) {
          Object.setPrototypeOf(this, actualProto);
        } else {
          this.__proto__ = actualProto;
        }
        this.name = "ZodError";
        this.issues = issues;
      }
      format(_mapper) {
        const mapper = _mapper || function(issue) {
          return issue.message;
        };
        const fieldErrors = { _errors: [] };
        const processError = (error) => {
          for (const issue of error.issues) {
            if (issue.code === "invalid_union") {
              issue.unionErrors.map(processError);
            } else if (issue.code === "invalid_return_type") {
              processError(issue.returnTypeError);
            } else if (issue.code === "invalid_arguments") {
              processError(issue.argumentsError);
            } else if (issue.path.length === 0) {
              fieldErrors._errors.push(mapper(issue));
            } else {
              let curr = fieldErrors;
              let i = 0;
              while (i < issue.path.length) {
                const el = issue.path[i];
                const terminal = i === issue.path.length - 1;
                if (!terminal) {
                  curr[el] = curr[el] || { _errors: [] };
                } else {
                  curr[el] = curr[el] || { _errors: [] };
                  curr[el]._errors.push(mapper(issue));
                }
                curr = curr[el];
                i++;
              }
            }
          }
        };
        processError(this);
        return fieldErrors;
      }
      static assert(value) {
        if (!(value instanceof _ZodError)) {
          throw new Error(`Not a ZodError: ${value}`);
        }
      }
      toString() {
        return this.message;
      }
      get message() {
        return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
      }
      get isEmpty() {
        return this.issues.length === 0;
      }
      flatten(mapper = (issue) => issue.message) {
        const fieldErrors = {};
        const formErrors = [];
        for (const sub of this.issues) {
          if (sub.path.length > 0) {
            const firstEl = sub.path[0];
            fieldErrors[firstEl] = fieldErrors[firstEl] || [];
            fieldErrors[firstEl].push(mapper(sub));
          } else {
            formErrors.push(mapper(sub));
          }
        }
        return { formErrors, fieldErrors };
      }
      get formErrors() {
        return this.flatten();
      }
    };
    ZodError.create = (issues) => {
      const error = new ZodError(issues);
      return error;
    };
  }
});

// node_modules/zod/v3/locales/en.js
var errorMap, en_default;
var init_en = __esm({
  "node_modules/zod/v3/locales/en.js"() {
    init_ZodError();
    init_util();
    errorMap = (issue, _ctx) => {
      let message;
      switch (issue.code) {
        case ZodIssueCode.invalid_type:
          if (issue.received === ZodParsedType.undefined) {
            message = "Required";
          } else {
            message = `Expected ${issue.expected}, received ${issue.received}`;
          }
          break;
        case ZodIssueCode.invalid_literal:
          message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
          break;
        case ZodIssueCode.unrecognized_keys:
          message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
          break;
        case ZodIssueCode.invalid_union:
          message = `Invalid input`;
          break;
        case ZodIssueCode.invalid_union_discriminator:
          message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
          break;
        case ZodIssueCode.invalid_enum_value:
          message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
          break;
        case ZodIssueCode.invalid_arguments:
          message = `Invalid function arguments`;
          break;
        case ZodIssueCode.invalid_return_type:
          message = `Invalid function return type`;
          break;
        case ZodIssueCode.invalid_date:
          message = `Invalid date`;
          break;
        case ZodIssueCode.invalid_string:
          if (typeof issue.validation === "object") {
            if ("includes" in issue.validation) {
              message = `Invalid input: must include "${issue.validation.includes}"`;
              if (typeof issue.validation.position === "number") {
                message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
              }
            } else if ("startsWith" in issue.validation) {
              message = `Invalid input: must start with "${issue.validation.startsWith}"`;
            } else if ("endsWith" in issue.validation) {
              message = `Invalid input: must end with "${issue.validation.endsWith}"`;
            } else {
              util.assertNever(issue.validation);
            }
          } else if (issue.validation !== "regex") {
            message = `Invalid ${issue.validation}`;
          } else {
            message = "Invalid";
          }
          break;
        case ZodIssueCode.too_small:
          if (issue.type === "array")
            message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
          else if (issue.type === "string")
            message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
          else if (issue.type === "number")
            message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
          else if (issue.type === "bigint")
            message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
          else if (issue.type === "date")
            message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
          else
            message = "Invalid input";
          break;
        case ZodIssueCode.too_big:
          if (issue.type === "array")
            message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
          else if (issue.type === "string")
            message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
          else if (issue.type === "number")
            message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
          else if (issue.type === "bigint")
            message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
          else if (issue.type === "date")
            message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
          else
            message = "Invalid input";
          break;
        case ZodIssueCode.custom:
          message = `Invalid input`;
          break;
        case ZodIssueCode.invalid_intersection_types:
          message = `Intersection results could not be merged`;
          break;
        case ZodIssueCode.not_multiple_of:
          message = `Number must be a multiple of ${issue.multipleOf}`;
          break;
        case ZodIssueCode.not_finite:
          message = "Number must be finite";
          break;
        default:
          message = _ctx.defaultError;
          util.assertNever(issue);
      }
      return { message };
    };
    en_default = errorMap;
  }
});

// node_modules/zod/v3/errors.js
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
var overrideErrorMap;
var init_errors = __esm({
  "node_modules/zod/v3/errors.js"() {
    init_en();
    overrideErrorMap = en_default;
  }
});

// node_modules/zod/v3/helpers/parseUtil.js
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var makeIssue, EMPTY_PATH, ParseStatus, INVALID, DIRTY, OK, isAborted, isDirty, isValid, isAsync;
var init_parseUtil = __esm({
  "node_modules/zod/v3/helpers/parseUtil.js"() {
    init_errors();
    init_en();
    makeIssue = (params) => {
      const { data, path: path37, errorMaps, issueData } = params;
      const fullPath = [...path37, ...issueData.path || []];
      const fullIssue = {
        ...issueData,
        path: fullPath
      };
      if (issueData.message !== void 0) {
        return {
          ...issueData,
          path: fullPath,
          message: issueData.message
        };
      }
      let errorMessage = "";
      const maps = errorMaps.filter((m) => !!m).slice().reverse();
      for (const map of maps) {
        errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
      }
      return {
        ...issueData,
        path: fullPath,
        message: errorMessage
      };
    };
    EMPTY_PATH = [];
    ParseStatus = class _ParseStatus {
      constructor() {
        this.value = "valid";
      }
      dirty() {
        if (this.value === "valid")
          this.value = "dirty";
      }
      abort() {
        if (this.value !== "aborted")
          this.value = "aborted";
      }
      static mergeArray(status, results) {
        const arrayValue = [];
        for (const s of results) {
          if (s.status === "aborted")
            return INVALID;
          if (s.status === "dirty")
            status.dirty();
          arrayValue.push(s.value);
        }
        return { status: status.value, value: arrayValue };
      }
      static async mergeObjectAsync(status, pairs) {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value
          });
        }
        return _ParseStatus.mergeObjectSync(status, syncPairs);
      }
      static mergeObjectSync(status, pairs) {
        const finalObject = {};
        for (const pair of pairs) {
          const { key, value } = pair;
          if (key.status === "aborted")
            return INVALID;
          if (value.status === "aborted")
            return INVALID;
          if (key.status === "dirty")
            status.dirty();
          if (value.status === "dirty")
            status.dirty();
          if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
            finalObject[key.value] = value.value;
          }
        }
        return { status: status.value, value: finalObject };
      }
    };
    INVALID = Object.freeze({
      status: "aborted"
    });
    DIRTY = (value) => ({ status: "dirty", value });
    OK = (value) => ({ status: "valid", value });
    isAborted = (x) => x.status === "aborted";
    isDirty = (x) => x.status === "dirty";
    isValid = (x) => x.status === "valid";
    isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
  }
});

// node_modules/zod/v3/helpers/typeAliases.js
var init_typeAliases = __esm({
  "node_modules/zod/v3/helpers/typeAliases.js"() {
  }
});

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
var init_errorUtil = __esm({
  "node_modules/zod/v3/helpers/errorUtil.js"() {
    (function(errorUtil2) {
      errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
      errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
    })(errorUtil || (errorUtil = {}));
  }
});

// node_modules/zod/v3/types.js
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var ParseInputLazyPath, handleResult, ZodType, cuidRegex, cuid2Regex, ulidRegex, uuidRegex, nanoidRegex, jwtRegex, durationRegex, emailRegex, _emojiRegex, emojiRegex, ipv4Regex, ipv4CidrRegex, ipv6Regex, ipv6CidrRegex, base64Regex, base64urlRegex, dateRegexSource, dateRegex, ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodDate, ZodSymbol, ZodUndefined, ZodNull, ZodAny, ZodUnknown, ZodNever, ZodVoid, ZodArray, ZodObject, ZodUnion, getDiscriminator, ZodDiscriminatedUnion, ZodIntersection, ZodTuple, ZodRecord, ZodMap, ZodSet, ZodFunction, ZodLazy, ZodLiteral, ZodEnum, ZodNativeEnum, ZodPromise, ZodEffects, ZodOptional, ZodNullable, ZodDefault, ZodCatch, ZodNaN, BRAND, ZodBranded, ZodPipeline, ZodReadonly, late, ZodFirstPartyTypeKind, instanceOfType, stringType, numberType, nanType, bigIntType, booleanType, dateType, symbolType, undefinedType, nullType, anyType, unknownType, neverType, voidType, arrayType, objectType, strictObjectType, unionType, discriminatedUnionType, intersectionType, tupleType, recordType, mapType, setType, functionType, lazyType, literalType, enumType, nativeEnumType, promiseType, effectsType, optionalType, nullableType, preprocessType, pipelineType, ostring, onumber, oboolean, coerce, NEVER;
var init_types = __esm({
  "node_modules/zod/v3/types.js"() {
    init_ZodError();
    init_errors();
    init_errorUtil();
    init_parseUtil();
    init_util();
    ParseInputLazyPath = class {
      constructor(parent, value, path37, key) {
        this._cachedPath = [];
        this.parent = parent;
        this.data = value;
        this._path = path37;
        this._key = key;
      }
      get path() {
        if (!this._cachedPath.length) {
          if (Array.isArray(this._key)) {
            this._cachedPath.push(...this._path, ...this._key);
          } else {
            this._cachedPath.push(...this._path, this._key);
          }
        }
        return this._cachedPath;
      }
    };
    handleResult = (ctx, result) => {
      if (isValid(result)) {
        return { success: true, data: result.value };
      } else {
        if (!ctx.common.issues.length) {
          throw new Error("Validation failed but no issues detected.");
        }
        return {
          success: false,
          get error() {
            if (this._error)
              return this._error;
            const error = new ZodError(ctx.common.issues);
            this._error = error;
            return this._error;
          }
        };
      }
    };
    ZodType = class {
      get description() {
        return this._def.description;
      }
      _getType(input) {
        return getParsedType(input.data);
      }
      _getOrReturnCtx(input, ctx) {
        return ctx || {
          common: input.parent.common,
          data: input.data,
          parsedType: getParsedType(input.data),
          schemaErrorMap: this._def.errorMap,
          path: input.path,
          parent: input.parent
        };
      }
      _processInputParams(input) {
        return {
          status: new ParseStatus(),
          ctx: {
            common: input.parent.common,
            data: input.data,
            parsedType: getParsedType(input.data),
            schemaErrorMap: this._def.errorMap,
            path: input.path,
            parent: input.parent
          }
        };
      }
      _parseSync(input) {
        const result = this._parse(input);
        if (isAsync(result)) {
          throw new Error("Synchronous parse encountered promise.");
        }
        return result;
      }
      _parseAsync(input) {
        const result = this._parse(input);
        return Promise.resolve(result);
      }
      parse(data, params) {
        const result = this.safeParse(data, params);
        if (result.success)
          return result.data;
        throw result.error;
      }
      safeParse(data, params) {
        const ctx = {
          common: {
            issues: [],
            async: params?.async ?? false,
            contextualErrorMap: params?.errorMap
          },
          path: params?.path || [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data,
          parsedType: getParsedType(data)
        };
        const result = this._parseSync({ data, path: ctx.path, parent: ctx });
        return handleResult(ctx, result);
      }
      "~validate"(data) {
        const ctx = {
          common: {
            issues: [],
            async: !!this["~standard"].async
          },
          path: [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data,
          parsedType: getParsedType(data)
        };
        if (!this["~standard"].async) {
          try {
            const result = this._parseSync({ data, path: [], parent: ctx });
            return isValid(result) ? {
              value: result.value
            } : {
              issues: ctx.common.issues
            };
          } catch (err) {
            if (err?.message?.toLowerCase()?.includes("encountered")) {
              this["~standard"].async = true;
            }
            ctx.common = {
              issues: [],
              async: true
            };
          }
        }
        return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        });
      }
      async parseAsync(data, params) {
        const result = await this.safeParseAsync(data, params);
        if (result.success)
          return result.data;
        throw result.error;
      }
      async safeParseAsync(data, params) {
        const ctx = {
          common: {
            issues: [],
            contextualErrorMap: params?.errorMap,
            async: true
          },
          path: params?.path || [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data,
          parsedType: getParsedType(data)
        };
        const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
        const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
        return handleResult(ctx, result);
      }
      refine(check, message) {
        const getIssueProperties = (val) => {
          if (typeof message === "string" || typeof message === "undefined") {
            return { message };
          } else if (typeof message === "function") {
            return message(val);
          } else {
            return message;
          }
        };
        return this._refinement((val, ctx) => {
          const result = check(val);
          const setError = () => ctx.addIssue({
            code: ZodIssueCode.custom,
            ...getIssueProperties(val)
          });
          if (typeof Promise !== "undefined" && result instanceof Promise) {
            return result.then((data) => {
              if (!data) {
                setError();
                return false;
              } else {
                return true;
              }
            });
          }
          if (!result) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      refinement(check, refinementData) {
        return this._refinement((val, ctx) => {
          if (!check(val)) {
            ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
            return false;
          } else {
            return true;
          }
        });
      }
      _refinement(refinement) {
        return new ZodEffects({
          schema: this,
          typeName: ZodFirstPartyTypeKind.ZodEffects,
          effect: { type: "refinement", refinement }
        });
      }
      superRefine(refinement) {
        return this._refinement(refinement);
      }
      constructor(def) {
        this.spa = this.safeParseAsync;
        this._def = def;
        this.parse = this.parse.bind(this);
        this.safeParse = this.safeParse.bind(this);
        this.parseAsync = this.parseAsync.bind(this);
        this.safeParseAsync = this.safeParseAsync.bind(this);
        this.spa = this.spa.bind(this);
        this.refine = this.refine.bind(this);
        this.refinement = this.refinement.bind(this);
        this.superRefine = this.superRefine.bind(this);
        this.optional = this.optional.bind(this);
        this.nullable = this.nullable.bind(this);
        this.nullish = this.nullish.bind(this);
        this.array = this.array.bind(this);
        this.promise = this.promise.bind(this);
        this.or = this.or.bind(this);
        this.and = this.and.bind(this);
        this.transform = this.transform.bind(this);
        this.brand = this.brand.bind(this);
        this.default = this.default.bind(this);
        this.catch = this.catch.bind(this);
        this.describe = this.describe.bind(this);
        this.pipe = this.pipe.bind(this);
        this.readonly = this.readonly.bind(this);
        this.isNullable = this.isNullable.bind(this);
        this.isOptional = this.isOptional.bind(this);
        this["~standard"] = {
          version: 1,
          vendor: "zod",
          validate: (data) => this["~validate"](data)
        };
      }
      optional() {
        return ZodOptional.create(this, this._def);
      }
      nullable() {
        return ZodNullable.create(this, this._def);
      }
      nullish() {
        return this.nullable().optional();
      }
      array() {
        return ZodArray.create(this);
      }
      promise() {
        return ZodPromise.create(this, this._def);
      }
      or(option) {
        return ZodUnion.create([this, option], this._def);
      }
      and(incoming) {
        return ZodIntersection.create(this, incoming, this._def);
      }
      transform(transform) {
        return new ZodEffects({
          ...processCreateParams(this._def),
          schema: this,
          typeName: ZodFirstPartyTypeKind.ZodEffects,
          effect: { type: "transform", transform }
        });
      }
      default(def) {
        const defaultValueFunc = typeof def === "function" ? def : () => def;
        return new ZodDefault({
          ...processCreateParams(this._def),
          innerType: this,
          defaultValue: defaultValueFunc,
          typeName: ZodFirstPartyTypeKind.ZodDefault
        });
      }
      brand() {
        return new ZodBranded({
          typeName: ZodFirstPartyTypeKind.ZodBranded,
          type: this,
          ...processCreateParams(this._def)
        });
      }
      catch(def) {
        const catchValueFunc = typeof def === "function" ? def : () => def;
        return new ZodCatch({
          ...processCreateParams(this._def),
          innerType: this,
          catchValue: catchValueFunc,
          typeName: ZodFirstPartyTypeKind.ZodCatch
        });
      }
      describe(description) {
        const This = this.constructor;
        return new This({
          ...this._def,
          description
        });
      }
      pipe(target) {
        return ZodPipeline.create(this, target);
      }
      readonly() {
        return ZodReadonly.create(this);
      }
      isOptional() {
        return this.safeParse(void 0).success;
      }
      isNullable() {
        return this.safeParse(null).success;
      }
    };
    cuidRegex = /^c[^\s-]{8,}$/i;
    cuid2Regex = /^[0-9a-z]+$/;
    ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
    uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
    nanoidRegex = /^[a-z0-9_-]{21}$/i;
    jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
    durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
    emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
    _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
    ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
    ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
    ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
    base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
    base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
    dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
    dateRegex = new RegExp(`^${dateRegexSource}$`);
    ZodString = class _ZodString extends ZodType {
      _parse(input) {
        if (this._def.coerce) {
          input.data = String(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.string) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.string,
            received: ctx2.parsedType
          });
          return INVALID;
        }
        const status = new ParseStatus();
        let ctx = void 0;
        for (const check of this._def.checks) {
          if (check.kind === "min") {
            if (input.data.length < check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: check.value,
                type: "string",
                inclusive: true,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            if (input.data.length > check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: check.value,
                type: "string",
                inclusive: true,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "length") {
            const tooBig = input.data.length > check.value;
            const tooSmall = input.data.length < check.value;
            if (tooBig || tooSmall) {
              ctx = this._getOrReturnCtx(input, ctx);
              if (tooBig) {
                addIssueToContext(ctx, {
                  code: ZodIssueCode.too_big,
                  maximum: check.value,
                  type: "string",
                  inclusive: true,
                  exact: true,
                  message: check.message
                });
              } else if (tooSmall) {
                addIssueToContext(ctx, {
                  code: ZodIssueCode.too_small,
                  minimum: check.value,
                  type: "string",
                  inclusive: true,
                  exact: true,
                  message: check.message
                });
              }
              status.dirty();
            }
          } else if (check.kind === "email") {
            if (!emailRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "email",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "emoji") {
            if (!emojiRegex) {
              emojiRegex = new RegExp(_emojiRegex, "u");
            }
            if (!emojiRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "emoji",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "uuid") {
            if (!uuidRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "uuid",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "nanoid") {
            if (!nanoidRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "nanoid",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "cuid") {
            if (!cuidRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "cuid",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "cuid2") {
            if (!cuid2Regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "cuid2",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "ulid") {
            if (!ulidRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "ulid",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "url") {
            try {
              new URL(input.data);
            } catch {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "url",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "regex") {
            check.regex.lastIndex = 0;
            const testResult = check.regex.test(input.data);
            if (!testResult) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "regex",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "trim") {
            input.data = input.data.trim();
          } else if (check.kind === "includes") {
            if (!input.data.includes(check.value, check.position)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_string,
                validation: { includes: check.value, position: check.position },
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "toLowerCase") {
            input.data = input.data.toLowerCase();
          } else if (check.kind === "toUpperCase") {
            input.data = input.data.toUpperCase();
          } else if (check.kind === "startsWith") {
            if (!input.data.startsWith(check.value)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_string,
                validation: { startsWith: check.value },
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "endsWith") {
            if (!input.data.endsWith(check.value)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_string,
                validation: { endsWith: check.value },
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "datetime") {
            const regex = datetimeRegex(check);
            if (!regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_string,
                validation: "datetime",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "date") {
            const regex = dateRegex;
            if (!regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_string,
                validation: "date",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "time") {
            const regex = timeRegex(check);
            if (!regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_string,
                validation: "time",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "duration") {
            if (!durationRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "duration",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "ip") {
            if (!isValidIP(input.data, check.version)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "ip",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "jwt") {
            if (!isValidJWT(input.data, check.alg)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "jwt",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "cidr") {
            if (!isValidCidr(input.data, check.version)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "cidr",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "base64") {
            if (!base64Regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "base64",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "base64url") {
            if (!base64urlRegex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                validation: "base64url",
                code: ZodIssueCode.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else {
            util.assertNever(check);
          }
        }
        return { status: status.value, value: input.data };
      }
      _regex(regex, validation, message) {
        return this.refinement((data) => regex.test(data), {
          validation,
          code: ZodIssueCode.invalid_string,
          ...errorUtil.errToObj(message)
        });
      }
      _addCheck(check) {
        return new _ZodString({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      email(message) {
        return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
      }
      url(message) {
        return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
      }
      emoji(message) {
        return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
      }
      uuid(message) {
        return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
      }
      nanoid(message) {
        return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
      }
      cuid(message) {
        return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
      }
      cuid2(message) {
        return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
      }
      ulid(message) {
        return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
      }
      base64(message) {
        return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
      }
      base64url(message) {
        return this._addCheck({
          kind: "base64url",
          ...errorUtil.errToObj(message)
        });
      }
      jwt(options) {
        return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
      }
      ip(options) {
        return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
      }
      cidr(options) {
        return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
      }
      datetime(options) {
        if (typeof options === "string") {
          return this._addCheck({
            kind: "datetime",
            precision: null,
            offset: false,
            local: false,
            message: options
          });
        }
        return this._addCheck({
          kind: "datetime",
          precision: typeof options?.precision === "undefined" ? null : options?.precision,
          offset: options?.offset ?? false,
          local: options?.local ?? false,
          ...errorUtil.errToObj(options?.message)
        });
      }
      date(message) {
        return this._addCheck({ kind: "date", message });
      }
      time(options) {
        if (typeof options === "string") {
          return this._addCheck({
            kind: "time",
            precision: null,
            message: options
          });
        }
        return this._addCheck({
          kind: "time",
          precision: typeof options?.precision === "undefined" ? null : options?.precision,
          ...errorUtil.errToObj(options?.message)
        });
      }
      duration(message) {
        return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
      }
      regex(regex, message) {
        return this._addCheck({
          kind: "regex",
          regex,
          ...errorUtil.errToObj(message)
        });
      }
      includes(value, options) {
        return this._addCheck({
          kind: "includes",
          value,
          position: options?.position,
          ...errorUtil.errToObj(options?.message)
        });
      }
      startsWith(value, message) {
        return this._addCheck({
          kind: "startsWith",
          value,
          ...errorUtil.errToObj(message)
        });
      }
      endsWith(value, message) {
        return this._addCheck({
          kind: "endsWith",
          value,
          ...errorUtil.errToObj(message)
        });
      }
      min(minLength, message) {
        return this._addCheck({
          kind: "min",
          value: minLength,
          ...errorUtil.errToObj(message)
        });
      }
      max(maxLength, message) {
        return this._addCheck({
          kind: "max",
          value: maxLength,
          ...errorUtil.errToObj(message)
        });
      }
      length(len, message) {
        return this._addCheck({
          kind: "length",
          value: len,
          ...errorUtil.errToObj(message)
        });
      }
      /**
       * Equivalent to `.min(1)`
       */
      nonempty(message) {
        return this.min(1, errorUtil.errToObj(message));
      }
      trim() {
        return new _ZodString({
          ...this._def,
          checks: [...this._def.checks, { kind: "trim" }]
        });
      }
      toLowerCase() {
        return new _ZodString({
          ...this._def,
          checks: [...this._def.checks, { kind: "toLowerCase" }]
        });
      }
      toUpperCase() {
        return new _ZodString({
          ...this._def,
          checks: [...this._def.checks, { kind: "toUpperCase" }]
        });
      }
      get isDatetime() {
        return !!this._def.checks.find((ch) => ch.kind === "datetime");
      }
      get isDate() {
        return !!this._def.checks.find((ch) => ch.kind === "date");
      }
      get isTime() {
        return !!this._def.checks.find((ch) => ch.kind === "time");
      }
      get isDuration() {
        return !!this._def.checks.find((ch) => ch.kind === "duration");
      }
      get isEmail() {
        return !!this._def.checks.find((ch) => ch.kind === "email");
      }
      get isURL() {
        return !!this._def.checks.find((ch) => ch.kind === "url");
      }
      get isEmoji() {
        return !!this._def.checks.find((ch) => ch.kind === "emoji");
      }
      get isUUID() {
        return !!this._def.checks.find((ch) => ch.kind === "uuid");
      }
      get isNANOID() {
        return !!this._def.checks.find((ch) => ch.kind === "nanoid");
      }
      get isCUID() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid");
      }
      get isCUID2() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid2");
      }
      get isULID() {
        return !!this._def.checks.find((ch) => ch.kind === "ulid");
      }
      get isIP() {
        return !!this._def.checks.find((ch) => ch.kind === "ip");
      }
      get isCIDR() {
        return !!this._def.checks.find((ch) => ch.kind === "cidr");
      }
      get isBase64() {
        return !!this._def.checks.find((ch) => ch.kind === "base64");
      }
      get isBase64url() {
        return !!this._def.checks.find((ch) => ch.kind === "base64url");
      }
      get minLength() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min;
      }
      get maxLength() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max;
      }
    };
    ZodString.create = (params) => {
      return new ZodString({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodString,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params)
      });
    };
    ZodNumber = class _ZodNumber extends ZodType {
      constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
        this.step = this.multipleOf;
      }
      _parse(input) {
        if (this._def.coerce) {
          input.data = Number(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.number) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.number,
            received: ctx2.parsedType
          });
          return INVALID;
        }
        let ctx = void 0;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
          if (check.kind === "int") {
            if (!util.isInteger(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: "integer",
                received: "float",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "min") {
            const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
            if (tooSmall) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: check.value,
                type: "number",
                inclusive: check.inclusive,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
            if (tooBig) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: check.value,
                type: "number",
                inclusive: check.inclusive,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "multipleOf") {
            if (floatSafeRemainder(input.data, check.value) !== 0) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.not_multiple_of,
                multipleOf: check.value,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "finite") {
            if (!Number.isFinite(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.not_finite,
                message: check.message
              });
              status.dirty();
            }
          } else {
            util.assertNever(check);
          }
        }
        return { status: status.value, value: input.data };
      }
      gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
      }
      gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
      }
      lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
      }
      lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
      }
      setLimit(kind, value, inclusive, message) {
        return new _ZodNumber({
          ...this._def,
          checks: [
            ...this._def.checks,
            {
              kind,
              value,
              inclusive,
              message: errorUtil.toString(message)
            }
          ]
        });
      }
      _addCheck(check) {
        return new _ZodNumber({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      int(message) {
        return this._addCheck({
          kind: "int",
          message: errorUtil.toString(message)
        });
      }
      positive(message) {
        return this._addCheck({
          kind: "min",
          value: 0,
          inclusive: false,
          message: errorUtil.toString(message)
        });
      }
      negative(message) {
        return this._addCheck({
          kind: "max",
          value: 0,
          inclusive: false,
          message: errorUtil.toString(message)
        });
      }
      nonpositive(message) {
        return this._addCheck({
          kind: "max",
          value: 0,
          inclusive: true,
          message: errorUtil.toString(message)
        });
      }
      nonnegative(message) {
        return this._addCheck({
          kind: "min",
          value: 0,
          inclusive: true,
          message: errorUtil.toString(message)
        });
      }
      multipleOf(value, message) {
        return this._addCheck({
          kind: "multipleOf",
          value,
          message: errorUtil.toString(message)
        });
      }
      finite(message) {
        return this._addCheck({
          kind: "finite",
          message: errorUtil.toString(message)
        });
      }
      safe(message) {
        return this._addCheck({
          kind: "min",
          inclusive: true,
          value: Number.MIN_SAFE_INTEGER,
          message: errorUtil.toString(message)
        })._addCheck({
          kind: "max",
          inclusive: true,
          value: Number.MAX_SAFE_INTEGER,
          message: errorUtil.toString(message)
        });
      }
      get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min;
      }
      get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max;
      }
      get isInt() {
        return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
      }
      get isFinite() {
        let max = null;
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
            return true;
          } else if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          } else if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return Number.isFinite(min) && Number.isFinite(max);
      }
    };
    ZodNumber.create = (params) => {
      return new ZodNumber({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodNumber,
        coerce: params?.coerce || false,
        ...processCreateParams(params)
      });
    };
    ZodBigInt = class _ZodBigInt extends ZodType {
      constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
      }
      _parse(input) {
        if (this._def.coerce) {
          try {
            input.data = BigInt(input.data);
          } catch {
            return this._getInvalidInput(input);
          }
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.bigint) {
          return this._getInvalidInput(input);
        }
        let ctx = void 0;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
          if (check.kind === "min") {
            const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
            if (tooSmall) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                type: "bigint",
                minimum: check.value,
                inclusive: check.inclusive,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
            if (tooBig) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                type: "bigint",
                maximum: check.value,
                inclusive: check.inclusive,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "multipleOf") {
            if (input.data % check.value !== BigInt(0)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.not_multiple_of,
                multipleOf: check.value,
                message: check.message
              });
              status.dirty();
            }
          } else {
            util.assertNever(check);
          }
        }
        return { status: status.value, value: input.data };
      }
      _getInvalidInput(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.bigint,
          received: ctx.parsedType
        });
        return INVALID;
      }
      gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
      }
      gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
      }
      lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
      }
      lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
      }
      setLimit(kind, value, inclusive, message) {
        return new _ZodBigInt({
          ...this._def,
          checks: [
            ...this._def.checks,
            {
              kind,
              value,
              inclusive,
              message: errorUtil.toString(message)
            }
          ]
        });
      }
      _addCheck(check) {
        return new _ZodBigInt({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      positive(message) {
        return this._addCheck({
          kind: "min",
          value: BigInt(0),
          inclusive: false,
          message: errorUtil.toString(message)
        });
      }
      negative(message) {
        return this._addCheck({
          kind: "max",
          value: BigInt(0),
          inclusive: false,
          message: errorUtil.toString(message)
        });
      }
      nonpositive(message) {
        return this._addCheck({
          kind: "max",
          value: BigInt(0),
          inclusive: true,
          message: errorUtil.toString(message)
        });
      }
      nonnegative(message) {
        return this._addCheck({
          kind: "min",
          value: BigInt(0),
          inclusive: true,
          message: errorUtil.toString(message)
        });
      }
      multipleOf(value, message) {
        return this._addCheck({
          kind: "multipleOf",
          value,
          message: errorUtil.toString(message)
        });
      }
      get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min;
      }
      get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max;
      }
    };
    ZodBigInt.create = (params) => {
      return new ZodBigInt({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodBigInt,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params)
      });
    };
    ZodBoolean = class extends ZodType {
      _parse(input) {
        if (this._def.coerce) {
          input.data = Boolean(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.boolean) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.boolean,
            received: ctx.parsedType
          });
          return INVALID;
        }
        return OK(input.data);
      }
    };
    ZodBoolean.create = (params) => {
      return new ZodBoolean({
        typeName: ZodFirstPartyTypeKind.ZodBoolean,
        coerce: params?.coerce || false,
        ...processCreateParams(params)
      });
    };
    ZodDate = class _ZodDate extends ZodType {
      _parse(input) {
        if (this._def.coerce) {
          input.data = new Date(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.date) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.date,
            received: ctx2.parsedType
          });
          return INVALID;
        }
        if (Number.isNaN(input.data.getTime())) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_date
          });
          return INVALID;
        }
        const status = new ParseStatus();
        let ctx = void 0;
        for (const check of this._def.checks) {
          if (check.kind === "min") {
            if (input.data.getTime() < check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                message: check.message,
                inclusive: true,
                exact: false,
                minimum: check.value,
                type: "date"
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            if (input.data.getTime() > check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                message: check.message,
                inclusive: true,
                exact: false,
                maximum: check.value,
                type: "date"
              });
              status.dirty();
            }
          } else {
            util.assertNever(check);
          }
        }
        return {
          status: status.value,
          value: new Date(input.data.getTime())
        };
      }
      _addCheck(check) {
        return new _ZodDate({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      min(minDate, message) {
        return this._addCheck({
          kind: "min",
          value: minDate.getTime(),
          message: errorUtil.toString(message)
        });
      }
      max(maxDate, message) {
        return this._addCheck({
          kind: "max",
          value: maxDate.getTime(),
          message: errorUtil.toString(message)
        });
      }
      get minDate() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min != null ? new Date(min) : null;
      }
      get maxDate() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max != null ? new Date(max) : null;
      }
    };
    ZodDate.create = (params) => {
      return new ZodDate({
        checks: [],
        coerce: params?.coerce || false,
        typeName: ZodFirstPartyTypeKind.ZodDate,
        ...processCreateParams(params)
      });
    };
    ZodSymbol = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.symbol) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.symbol,
            received: ctx.parsedType
          });
          return INVALID;
        }
        return OK(input.data);
      }
    };
    ZodSymbol.create = (params) => {
      return new ZodSymbol({
        typeName: ZodFirstPartyTypeKind.ZodSymbol,
        ...processCreateParams(params)
      });
    };
    ZodUndefined = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.undefined,
            received: ctx.parsedType
          });
          return INVALID;
        }
        return OK(input.data);
      }
    };
    ZodUndefined.create = (params) => {
      return new ZodUndefined({
        typeName: ZodFirstPartyTypeKind.ZodUndefined,
        ...processCreateParams(params)
      });
    };
    ZodNull = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.null) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.null,
            received: ctx.parsedType
          });
          return INVALID;
        }
        return OK(input.data);
      }
    };
    ZodNull.create = (params) => {
      return new ZodNull({
        typeName: ZodFirstPartyTypeKind.ZodNull,
        ...processCreateParams(params)
      });
    };
    ZodAny = class extends ZodType {
      constructor() {
        super(...arguments);
        this._any = true;
      }
      _parse(input) {
        return OK(input.data);
      }
    };
    ZodAny.create = (params) => {
      return new ZodAny({
        typeName: ZodFirstPartyTypeKind.ZodAny,
        ...processCreateParams(params)
      });
    };
    ZodUnknown = class extends ZodType {
      constructor() {
        super(...arguments);
        this._unknown = true;
      }
      _parse(input) {
        return OK(input.data);
      }
    };
    ZodUnknown.create = (params) => {
      return new ZodUnknown({
        typeName: ZodFirstPartyTypeKind.ZodUnknown,
        ...processCreateParams(params)
      });
    };
    ZodNever = class extends ZodType {
      _parse(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.never,
          received: ctx.parsedType
        });
        return INVALID;
      }
    };
    ZodNever.create = (params) => {
      return new ZodNever({
        typeName: ZodFirstPartyTypeKind.ZodNever,
        ...processCreateParams(params)
      });
    };
    ZodVoid = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.void,
            received: ctx.parsedType
          });
          return INVALID;
        }
        return OK(input.data);
      }
    };
    ZodVoid.create = (params) => {
      return new ZodVoid({
        typeName: ZodFirstPartyTypeKind.ZodVoid,
        ...processCreateParams(params)
      });
    };
    ZodArray = class _ZodArray extends ZodType {
      _parse(input) {
        const { ctx, status } = this._processInputParams(input);
        const def = this._def;
        if (ctx.parsedType !== ZodParsedType.array) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.array,
            received: ctx.parsedType
          });
          return INVALID;
        }
        if (def.exactLength !== null) {
          const tooBig = ctx.data.length > def.exactLength.value;
          const tooSmall = ctx.data.length < def.exactLength.value;
          if (tooBig || tooSmall) {
            addIssueToContext(ctx, {
              code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
              minimum: tooSmall ? def.exactLength.value : void 0,
              maximum: tooBig ? def.exactLength.value : void 0,
              type: "array",
              inclusive: true,
              exact: true,
              message: def.exactLength.message
            });
            status.dirty();
          }
        }
        if (def.minLength !== null) {
          if (ctx.data.length < def.minLength.value) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: def.minLength.value,
              type: "array",
              inclusive: true,
              exact: false,
              message: def.minLength.message
            });
            status.dirty();
          }
        }
        if (def.maxLength !== null) {
          if (ctx.data.length > def.maxLength.value) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: def.maxLength.value,
              type: "array",
              inclusive: true,
              exact: false,
              message: def.maxLength.message
            });
            status.dirty();
          }
        }
        if (ctx.common.async) {
          return Promise.all([...ctx.data].map((item, i) => {
            return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
          })).then((result2) => {
            return ParseStatus.mergeArray(status, result2);
          });
        }
        const result = [...ctx.data].map((item, i) => {
          return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        });
        return ParseStatus.mergeArray(status, result);
      }
      get element() {
        return this._def.type;
      }
      min(minLength, message) {
        return new _ZodArray({
          ...this._def,
          minLength: { value: minLength, message: errorUtil.toString(message) }
        });
      }
      max(maxLength, message) {
        return new _ZodArray({
          ...this._def,
          maxLength: { value: maxLength, message: errorUtil.toString(message) }
        });
      }
      length(len, message) {
        return new _ZodArray({
          ...this._def,
          exactLength: { value: len, message: errorUtil.toString(message) }
        });
      }
      nonempty(message) {
        return this.min(1, message);
      }
    };
    ZodArray.create = (schema, params) => {
      return new ZodArray({
        type: schema,
        minLength: null,
        maxLength: null,
        exactLength: null,
        typeName: ZodFirstPartyTypeKind.ZodArray,
        ...processCreateParams(params)
      });
    };
    ZodObject = class _ZodObject extends ZodType {
      constructor() {
        super(...arguments);
        this._cached = null;
        this.nonstrict = this.passthrough;
        this.augment = this.extend;
      }
      _getCached() {
        if (this._cached !== null)
          return this._cached;
        const shape = this._def.shape();
        const keys = util.objectKeys(shape);
        this._cached = { shape, keys };
        return this._cached;
      }
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.object) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.object,
            received: ctx2.parsedType
          });
          return INVALID;
        }
        const { status, ctx } = this._processInputParams(input);
        const { shape, keys: shapeKeys } = this._getCached();
        const extraKeys = [];
        if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
          for (const key in ctx.data) {
            if (!shapeKeys.includes(key)) {
              extraKeys.push(key);
            }
          }
        }
        const pairs = [];
        for (const key of shapeKeys) {
          const keyValidator = shape[key];
          const value = ctx.data[key];
          pairs.push({
            key: { status: "valid", value: key },
            value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
            alwaysSet: key in ctx.data
          });
        }
        if (this._def.catchall instanceof ZodNever) {
          const unknownKeys = this._def.unknownKeys;
          if (unknownKeys === "passthrough") {
            for (const key of extraKeys) {
              pairs.push({
                key: { status: "valid", value: key },
                value: { status: "valid", value: ctx.data[key] }
              });
            }
          } else if (unknownKeys === "strict") {
            if (extraKeys.length > 0) {
              addIssueToContext(ctx, {
                code: ZodIssueCode.unrecognized_keys,
                keys: extraKeys
              });
              status.dirty();
            }
          } else if (unknownKeys === "strip") {
          } else {
            throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
          }
        } else {
          const catchall = this._def.catchall;
          for (const key of extraKeys) {
            const value = ctx.data[key];
            pairs.push({
              key: { status: "valid", value: key },
              value: catchall._parse(
                new ParseInputLazyPath(ctx, value, ctx.path, key)
                //, ctx.child(key), value, getParsedType(value)
              ),
              alwaysSet: key in ctx.data
            });
          }
        }
        if (ctx.common.async) {
          return Promise.resolve().then(async () => {
            const syncPairs = [];
            for (const pair of pairs) {
              const key = await pair.key;
              const value = await pair.value;
              syncPairs.push({
                key,
                value,
                alwaysSet: pair.alwaysSet
              });
            }
            return syncPairs;
          }).then((syncPairs) => {
            return ParseStatus.mergeObjectSync(status, syncPairs);
          });
        } else {
          return ParseStatus.mergeObjectSync(status, pairs);
        }
      }
      get shape() {
        return this._def.shape();
      }
      strict(message) {
        errorUtil.errToObj;
        return new _ZodObject({
          ...this._def,
          unknownKeys: "strict",
          ...message !== void 0 ? {
            errorMap: (issue, ctx) => {
              const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
              if (issue.code === "unrecognized_keys")
                return {
                  message: errorUtil.errToObj(message).message ?? defaultError
                };
              return {
                message: defaultError
              };
            }
          } : {}
        });
      }
      strip() {
        return new _ZodObject({
          ...this._def,
          unknownKeys: "strip"
        });
      }
      passthrough() {
        return new _ZodObject({
          ...this._def,
          unknownKeys: "passthrough"
        });
      }
      // const AugmentFactory =
      //   <Def extends ZodObjectDef>(def: Def) =>
      //   <Augmentation extends ZodRawShape>(
      //     augmentation: Augmentation
      //   ): ZodObject<
      //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
      //     Def["unknownKeys"],
      //     Def["catchall"]
      //   > => {
      //     return new ZodObject({
      //       ...def,
      //       shape: () => ({
      //         ...def.shape(),
      //         ...augmentation,
      //       }),
      //     }) as any;
      //   };
      extend(augmentation) {
        return new _ZodObject({
          ...this._def,
          shape: () => ({
            ...this._def.shape(),
            ...augmentation
          })
        });
      }
      /**
       * Prior to zod@1.0.12 there was a bug in the
       * inferred type of merged objects. Please
       * upgrade if you are experiencing issues.
       */
      merge(merging) {
        const merged = new _ZodObject({
          unknownKeys: merging._def.unknownKeys,
          catchall: merging._def.catchall,
          shape: () => ({
            ...this._def.shape(),
            ...merging._def.shape()
          }),
          typeName: ZodFirstPartyTypeKind.ZodObject
        });
        return merged;
      }
      // merge<
      //   Incoming extends AnyZodObject,
      //   Augmentation extends Incoming["shape"],
      //   NewOutput extends {
      //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
      //       ? Augmentation[k]["_output"]
      //       : k extends keyof Output
      //       ? Output[k]
      //       : never;
      //   },
      //   NewInput extends {
      //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
      //       ? Augmentation[k]["_input"]
      //       : k extends keyof Input
      //       ? Input[k]
      //       : never;
      //   }
      // >(
      //   merging: Incoming
      // ): ZodObject<
      //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
      //   Incoming["_def"]["unknownKeys"],
      //   Incoming["_def"]["catchall"],
      //   NewOutput,
      //   NewInput
      // > {
      //   const merged: any = new ZodObject({
      //     unknownKeys: merging._def.unknownKeys,
      //     catchall: merging._def.catchall,
      //     shape: () =>
      //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
      //     typeName: ZodFirstPartyTypeKind.ZodObject,
      //   }) as any;
      //   return merged;
      // }
      setKey(key, schema) {
        return this.augment({ [key]: schema });
      }
      // merge<Incoming extends AnyZodObject>(
      //   merging: Incoming
      // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
      // ZodObject<
      //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
      //   Incoming["_def"]["unknownKeys"],
      //   Incoming["_def"]["catchall"]
      // > {
      //   // const mergedShape = objectUtil.mergeShapes(
      //   //   this._def.shape(),
      //   //   merging._def.shape()
      //   // );
      //   const merged: any = new ZodObject({
      //     unknownKeys: merging._def.unknownKeys,
      //     catchall: merging._def.catchall,
      //     shape: () =>
      //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
      //     typeName: ZodFirstPartyTypeKind.ZodObject,
      //   }) as any;
      //   return merged;
      // }
      catchall(index) {
        return new _ZodObject({
          ...this._def,
          catchall: index
        });
      }
      pick(mask) {
        const shape = {};
        for (const key of util.objectKeys(mask)) {
          if (mask[key] && this.shape[key]) {
            shape[key] = this.shape[key];
          }
        }
        return new _ZodObject({
          ...this._def,
          shape: () => shape
        });
      }
      omit(mask) {
        const shape = {};
        for (const key of util.objectKeys(this.shape)) {
          if (!mask[key]) {
            shape[key] = this.shape[key];
          }
        }
        return new _ZodObject({
          ...this._def,
          shape: () => shape
        });
      }
      /**
       * @deprecated
       */
      deepPartial() {
        return deepPartialify(this);
      }
      partial(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
          const fieldSchema = this.shape[key];
          if (mask && !mask[key]) {
            newShape[key] = fieldSchema;
          } else {
            newShape[key] = fieldSchema.optional();
          }
        }
        return new _ZodObject({
          ...this._def,
          shape: () => newShape
        });
      }
      required(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
          if (mask && !mask[key]) {
            newShape[key] = this.shape[key];
          } else {
            const fieldSchema = this.shape[key];
            let newField = fieldSchema;
            while (newField instanceof ZodOptional) {
              newField = newField._def.innerType;
            }
            newShape[key] = newField;
          }
        }
        return new _ZodObject({
          ...this._def,
          shape: () => newShape
        });
      }
      keyof() {
        return createZodEnum(util.objectKeys(this.shape));
      }
    };
    ZodObject.create = (shape, params) => {
      return new ZodObject({
        shape: () => shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params)
      });
    };
    ZodObject.strictCreate = (shape, params) => {
      return new ZodObject({
        shape: () => shape,
        unknownKeys: "strict",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params)
      });
    };
    ZodObject.lazycreate = (shape, params) => {
      return new ZodObject({
        shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params)
      });
    };
    ZodUnion = class extends ZodType {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const options = this._def.options;
        function handleResults(results) {
          for (const result of results) {
            if (result.result.status === "valid") {
              return result.result;
            }
          }
          for (const result of results) {
            if (result.result.status === "dirty") {
              ctx.common.issues.push(...result.ctx.common.issues);
              return result.result;
            }
          }
          const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_union,
            unionErrors
          });
          return INVALID;
        }
        if (ctx.common.async) {
          return Promise.all(options.map(async (option) => {
            const childCtx = {
              ...ctx,
              common: {
                ...ctx.common,
                issues: []
              },
              parent: null
            };
            return {
              result: await option._parseAsync({
                data: ctx.data,
                path: ctx.path,
                parent: childCtx
              }),
              ctx: childCtx
            };
          })).then(handleResults);
        } else {
          let dirty = void 0;
          const issues = [];
          for (const option of options) {
            const childCtx = {
              ...ctx,
              common: {
                ...ctx.common,
                issues: []
              },
              parent: null
            };
            const result = option._parseSync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx
            });
            if (result.status === "valid") {
              return result;
            } else if (result.status === "dirty" && !dirty) {
              dirty = { result, ctx: childCtx };
            }
            if (childCtx.common.issues.length) {
              issues.push(childCtx.common.issues);
            }
          }
          if (dirty) {
            ctx.common.issues.push(...dirty.ctx.common.issues);
            return dirty.result;
          }
          const unionErrors = issues.map((issues2) => new ZodError(issues2));
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_union,
            unionErrors
          });
          return INVALID;
        }
      }
      get options() {
        return this._def.options;
      }
    };
    ZodUnion.create = (types, params) => {
      return new ZodUnion({
        options: types,
        typeName: ZodFirstPartyTypeKind.ZodUnion,
        ...processCreateParams(params)
      });
    };
    getDiscriminator = (type) => {
      if (type instanceof ZodLazy) {
        return getDiscriminator(type.schema);
      } else if (type instanceof ZodEffects) {
        return getDiscriminator(type.innerType());
      } else if (type instanceof ZodLiteral) {
        return [type.value];
      } else if (type instanceof ZodEnum) {
        return type.options;
      } else if (type instanceof ZodNativeEnum) {
        return util.objectValues(type.enum);
      } else if (type instanceof ZodDefault) {
        return getDiscriminator(type._def.innerType);
      } else if (type instanceof ZodUndefined) {
        return [void 0];
      } else if (type instanceof ZodNull) {
        return [null];
      } else if (type instanceof ZodOptional) {
        return [void 0, ...getDiscriminator(type.unwrap())];
      } else if (type instanceof ZodNullable) {
        return [null, ...getDiscriminator(type.unwrap())];
      } else if (type instanceof ZodBranded) {
        return getDiscriminator(type.unwrap());
      } else if (type instanceof ZodReadonly) {
        return getDiscriminator(type.unwrap());
      } else if (type instanceof ZodCatch) {
        return getDiscriminator(type._def.innerType);
      } else {
        return [];
      }
    };
    ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.object) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.object,
            received: ctx.parsedType
          });
          return INVALID;
        }
        const discriminator = this.discriminator;
        const discriminatorValue = ctx.data[discriminator];
        const option = this.optionsMap.get(discriminatorValue);
        if (!option) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_union_discriminator,
            options: Array.from(this.optionsMap.keys()),
            path: [discriminator]
          });
          return INVALID;
        }
        if (ctx.common.async) {
          return option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
        } else {
          return option._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
        }
      }
      get discriminator() {
        return this._def.discriminator;
      }
      get options() {
        return this._def.options;
      }
      get optionsMap() {
        return this._def.optionsMap;
      }
      /**
       * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
       * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
       * have a different value for each object in the union.
       * @param discriminator the name of the discriminator property
       * @param types an array of object schemas
       * @param params
       */
      static create(discriminator, options, params) {
        const optionsMap = /* @__PURE__ */ new Map();
        for (const type of options) {
          const discriminatorValues = getDiscriminator(type.shape[discriminator]);
          if (!discriminatorValues.length) {
            throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
          }
          for (const value of discriminatorValues) {
            if (optionsMap.has(value)) {
              throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
            }
            optionsMap.set(value, type);
          }
        }
        return new _ZodDiscriminatedUnion({
          typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
          discriminator,
          options,
          optionsMap,
          ...processCreateParams(params)
        });
      }
    };
    ZodIntersection = class extends ZodType {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const handleParsed = (parsedLeft, parsedRight) => {
          if (isAborted(parsedLeft) || isAborted(parsedRight)) {
            return INVALID;
          }
          const merged = mergeValues(parsedLeft.value, parsedRight.value);
          if (!merged.valid) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_intersection_types
            });
            return INVALID;
          }
          if (isDirty(parsedLeft) || isDirty(parsedRight)) {
            status.dirty();
          }
          return { status: status.value, value: merged.data };
        };
        if (ctx.common.async) {
          return Promise.all([
            this._def.left._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            }),
            this._def.right._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            })
          ]).then(([left, right]) => handleParsed(left, right));
        } else {
          return handleParsed(this._def.left._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          }), this._def.right._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          }));
        }
      }
    };
    ZodIntersection.create = (left, right, params) => {
      return new ZodIntersection({
        left,
        right,
        typeName: ZodFirstPartyTypeKind.ZodIntersection,
        ...processCreateParams(params)
      });
    };
    ZodTuple = class _ZodTuple extends ZodType {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.array) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.array,
            received: ctx.parsedType
          });
          return INVALID;
        }
        if (ctx.data.length < this._def.items.length) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: this._def.items.length,
            inclusive: true,
            exact: false,
            type: "array"
          });
          return INVALID;
        }
        const rest = this._def.rest;
        if (!rest && ctx.data.length > this._def.items.length) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: this._def.items.length,
            inclusive: true,
            exact: false,
            type: "array"
          });
          status.dirty();
        }
        const items = [...ctx.data].map((item, itemIndex) => {
          const schema = this._def.items[itemIndex] || this._def.rest;
          if (!schema)
            return null;
          return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
        }).filter((x) => !!x);
        if (ctx.common.async) {
          return Promise.all(items).then((results) => {
            return ParseStatus.mergeArray(status, results);
          });
        } else {
          return ParseStatus.mergeArray(status, items);
        }
      }
      get items() {
        return this._def.items;
      }
      rest(rest) {
        return new _ZodTuple({
          ...this._def,
          rest
        });
      }
    };
    ZodTuple.create = (schemas, params) => {
      if (!Array.isArray(schemas)) {
        throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
      }
      return new ZodTuple({
        items: schemas,
        typeName: ZodFirstPartyTypeKind.ZodTuple,
        rest: null,
        ...processCreateParams(params)
      });
    };
    ZodRecord = class _ZodRecord extends ZodType {
      get keySchema() {
        return this._def.keyType;
      }
      get valueSchema() {
        return this._def.valueType;
      }
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.object) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.object,
            received: ctx.parsedType
          });
          return INVALID;
        }
        const pairs = [];
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        for (const key in ctx.data) {
          pairs.push({
            key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
            value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
            alwaysSet: key in ctx.data
          });
        }
        if (ctx.common.async) {
          return ParseStatus.mergeObjectAsync(status, pairs);
        } else {
          return ParseStatus.mergeObjectSync(status, pairs);
        }
      }
      get element() {
        return this._def.valueType;
      }
      static create(first, second, third) {
        if (second instanceof ZodType) {
          return new _ZodRecord({
            keyType: first,
            valueType: second,
            typeName: ZodFirstPartyTypeKind.ZodRecord,
            ...processCreateParams(third)
          });
        }
        return new _ZodRecord({
          keyType: ZodString.create(),
          valueType: first,
          typeName: ZodFirstPartyTypeKind.ZodRecord,
          ...processCreateParams(second)
        });
      }
    };
    ZodMap = class extends ZodType {
      get keySchema() {
        return this._def.keyType;
      }
      get valueSchema() {
        return this._def.valueType;
      }
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.map) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.map,
            received: ctx.parsedType
          });
          return INVALID;
        }
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        const pairs = [...ctx.data.entries()].map(([key, value], index) => {
          return {
            key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
            value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
          };
        });
        if (ctx.common.async) {
          const finalMap = /* @__PURE__ */ new Map();
          return Promise.resolve().then(async () => {
            for (const pair of pairs) {
              const key = await pair.key;
              const value = await pair.value;
              if (key.status === "aborted" || value.status === "aborted") {
                return INVALID;
              }
              if (key.status === "dirty" || value.status === "dirty") {
                status.dirty();
              }
              finalMap.set(key.value, value.value);
            }
            return { status: status.value, value: finalMap };
          });
        } else {
          const finalMap = /* @__PURE__ */ new Map();
          for (const pair of pairs) {
            const key = pair.key;
            const value = pair.value;
            if (key.status === "aborted" || value.status === "aborted") {
              return INVALID;
            }
            if (key.status === "dirty" || value.status === "dirty") {
              status.dirty();
            }
            finalMap.set(key.value, value.value);
          }
          return { status: status.value, value: finalMap };
        }
      }
    };
    ZodMap.create = (keyType, valueType, params) => {
      return new ZodMap({
        valueType,
        keyType,
        typeName: ZodFirstPartyTypeKind.ZodMap,
        ...processCreateParams(params)
      });
    };
    ZodSet = class _ZodSet extends ZodType {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.set) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.set,
            received: ctx.parsedType
          });
          return INVALID;
        }
        const def = this._def;
        if (def.minSize !== null) {
          if (ctx.data.size < def.minSize.value) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: def.minSize.value,
              type: "set",
              inclusive: true,
              exact: false,
              message: def.minSize.message
            });
            status.dirty();
          }
        }
        if (def.maxSize !== null) {
          if (ctx.data.size > def.maxSize.value) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: def.maxSize.value,
              type: "set",
              inclusive: true,
              exact: false,
              message: def.maxSize.message
            });
            status.dirty();
          }
        }
        const valueType = this._def.valueType;
        function finalizeSet(elements2) {
          const parsedSet = /* @__PURE__ */ new Set();
          for (const element of elements2) {
            if (element.status === "aborted")
              return INVALID;
            if (element.status === "dirty")
              status.dirty();
            parsedSet.add(element.value);
          }
          return { status: status.value, value: parsedSet };
        }
        const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
        if (ctx.common.async) {
          return Promise.all(elements).then((elements2) => finalizeSet(elements2));
        } else {
          return finalizeSet(elements);
        }
      }
      min(minSize, message) {
        return new _ZodSet({
          ...this._def,
          minSize: { value: minSize, message: errorUtil.toString(message) }
        });
      }
      max(maxSize, message) {
        return new _ZodSet({
          ...this._def,
          maxSize: { value: maxSize, message: errorUtil.toString(message) }
        });
      }
      size(size, message) {
        return this.min(size, message).max(size, message);
      }
      nonempty(message) {
        return this.min(1, message);
      }
    };
    ZodSet.create = (valueType, params) => {
      return new ZodSet({
        valueType,
        minSize: null,
        maxSize: null,
        typeName: ZodFirstPartyTypeKind.ZodSet,
        ...processCreateParams(params)
      });
    };
    ZodFunction = class _ZodFunction extends ZodType {
      constructor() {
        super(...arguments);
        this.validate = this.implement;
      }
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.function) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.function,
            received: ctx.parsedType
          });
          return INVALID;
        }
        function makeArgsIssue(args, error) {
          return makeIssue({
            data: args,
            path: ctx.path,
            errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
            issueData: {
              code: ZodIssueCode.invalid_arguments,
              argumentsError: error
            }
          });
        }
        function makeReturnsIssue(returns, error) {
          return makeIssue({
            data: returns,
            path: ctx.path,
            errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
            issueData: {
              code: ZodIssueCode.invalid_return_type,
              returnTypeError: error
            }
          });
        }
        const params = { errorMap: ctx.common.contextualErrorMap };
        const fn = ctx.data;
        if (this._def.returns instanceof ZodPromise) {
          const me = this;
          return OK(async function(...args) {
            const error = new ZodError([]);
            const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
              error.addIssue(makeArgsIssue(args, e));
              throw error;
            });
            const result = await Reflect.apply(fn, this, parsedArgs);
            const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
              error.addIssue(makeReturnsIssue(result, e));
              throw error;
            });
            return parsedReturns;
          });
        } else {
          const me = this;
          return OK(function(...args) {
            const parsedArgs = me._def.args.safeParse(args, params);
            if (!parsedArgs.success) {
              throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
            }
            const result = Reflect.apply(fn, this, parsedArgs.data);
            const parsedReturns = me._def.returns.safeParse(result, params);
            if (!parsedReturns.success) {
              throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
            }
            return parsedReturns.data;
          });
        }
      }
      parameters() {
        return this._def.args;
      }
      returnType() {
        return this._def.returns;
      }
      args(...items) {
        return new _ZodFunction({
          ...this._def,
          args: ZodTuple.create(items).rest(ZodUnknown.create())
        });
      }
      returns(returnType) {
        return new _ZodFunction({
          ...this._def,
          returns: returnType
        });
      }
      implement(func) {
        const validatedFunc = this.parse(func);
        return validatedFunc;
      }
      strictImplement(func) {
        const validatedFunc = this.parse(func);
        return validatedFunc;
      }
      static create(args, returns, params) {
        return new _ZodFunction({
          args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
          returns: returns || ZodUnknown.create(),
          typeName: ZodFirstPartyTypeKind.ZodFunction,
          ...processCreateParams(params)
        });
      }
    };
    ZodLazy = class extends ZodType {
      get schema() {
        return this._def.getter();
      }
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const lazySchema = this._def.getter();
        return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
      }
    };
    ZodLazy.create = (getter, params) => {
      return new ZodLazy({
        getter,
        typeName: ZodFirstPartyTypeKind.ZodLazy,
        ...processCreateParams(params)
      });
    };
    ZodLiteral = class extends ZodType {
      _parse(input) {
        if (input.data !== this._def.value) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            received: ctx.data,
            code: ZodIssueCode.invalid_literal,
            expected: this._def.value
          });
          return INVALID;
        }
        return { status: "valid", value: input.data };
      }
      get value() {
        return this._def.value;
      }
    };
    ZodLiteral.create = (value, params) => {
      return new ZodLiteral({
        value,
        typeName: ZodFirstPartyTypeKind.ZodLiteral,
        ...processCreateParams(params)
      });
    };
    ZodEnum = class _ZodEnum extends ZodType {
      _parse(input) {
        if (typeof input.data !== "string") {
          const ctx = this._getOrReturnCtx(input);
          const expectedValues = this._def.values;
          addIssueToContext(ctx, {
            expected: util.joinValues(expectedValues),
            received: ctx.parsedType,
            code: ZodIssueCode.invalid_type
          });
          return INVALID;
        }
        if (!this._cache) {
          this._cache = new Set(this._def.values);
        }
        if (!this._cache.has(input.data)) {
          const ctx = this._getOrReturnCtx(input);
          const expectedValues = this._def.values;
          addIssueToContext(ctx, {
            received: ctx.data,
            code: ZodIssueCode.invalid_enum_value,
            options: expectedValues
          });
          return INVALID;
        }
        return OK(input.data);
      }
      get options() {
        return this._def.values;
      }
      get enum() {
        const enumValues = {};
        for (const val of this._def.values) {
          enumValues[val] = val;
        }
        return enumValues;
      }
      get Values() {
        const enumValues = {};
        for (const val of this._def.values) {
          enumValues[val] = val;
        }
        return enumValues;
      }
      get Enum() {
        const enumValues = {};
        for (const val of this._def.values) {
          enumValues[val] = val;
        }
        return enumValues;
      }
      extract(values, newDef = this._def) {
        return _ZodEnum.create(values, {
          ...this._def,
          ...newDef
        });
      }
      exclude(values, newDef = this._def) {
        return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
          ...this._def,
          ...newDef
        });
      }
    };
    ZodEnum.create = createZodEnum;
    ZodNativeEnum = class extends ZodType {
      _parse(input) {
        const nativeEnumValues = util.getValidEnumValues(this._def.values);
        const ctx = this._getOrReturnCtx(input);
        if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
          const expectedValues = util.objectValues(nativeEnumValues);
          addIssueToContext(ctx, {
            expected: util.joinValues(expectedValues),
            received: ctx.parsedType,
            code: ZodIssueCode.invalid_type
          });
          return INVALID;
        }
        if (!this._cache) {
          this._cache = new Set(util.getValidEnumValues(this._def.values));
        }
        if (!this._cache.has(input.data)) {
          const expectedValues = util.objectValues(nativeEnumValues);
          addIssueToContext(ctx, {
            received: ctx.data,
            code: ZodIssueCode.invalid_enum_value,
            options: expectedValues
          });
          return INVALID;
        }
        return OK(input.data);
      }
      get enum() {
        return this._def.values;
      }
    };
    ZodNativeEnum.create = (values, params) => {
      return new ZodNativeEnum({
        values,
        typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
        ...processCreateParams(params)
      });
    };
    ZodPromise = class extends ZodType {
      unwrap() {
        return this._def.type;
      }
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.promise,
            received: ctx.parsedType
          });
          return INVALID;
        }
        const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
        return OK(promisified.then((data) => {
          return this._def.type.parseAsync(data, {
            path: ctx.path,
            errorMap: ctx.common.contextualErrorMap
          });
        }));
      }
    };
    ZodPromise.create = (schema, params) => {
      return new ZodPromise({
        type: schema,
        typeName: ZodFirstPartyTypeKind.ZodPromise,
        ...processCreateParams(params)
      });
    };
    ZodEffects = class extends ZodType {
      innerType() {
        return this._def.schema;
      }
      sourceType() {
        return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
      }
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const effect = this._def.effect || null;
        const checkCtx = {
          addIssue: (arg) => {
            addIssueToContext(ctx, arg);
            if (arg.fatal) {
              status.abort();
            } else {
              status.dirty();
            }
          },
          get path() {
            return ctx.path;
          }
        };
        checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
        if (effect.type === "preprocess") {
          const processed = effect.transform(ctx.data, checkCtx);
          if (ctx.common.async) {
            return Promise.resolve(processed).then(async (processed2) => {
              if (status.value === "aborted")
                return INVALID;
              const result = await this._def.schema._parseAsync({
                data: processed2,
                path: ctx.path,
                parent: ctx
              });
              if (result.status === "aborted")
                return INVALID;
              if (result.status === "dirty")
                return DIRTY(result.value);
              if (status.value === "dirty")
                return DIRTY(result.value);
              return result;
            });
          } else {
            if (status.value === "aborted")
              return INVALID;
            const result = this._def.schema._parseSync({
              data: processed,
              path: ctx.path,
              parent: ctx
            });
            if (result.status === "aborted")
              return INVALID;
            if (result.status === "dirty")
              return DIRTY(result.value);
            if (status.value === "dirty")
              return DIRTY(result.value);
            return result;
          }
        }
        if (effect.type === "refinement") {
          const executeRefinement = (acc) => {
            const result = effect.refinement(acc, checkCtx);
            if (ctx.common.async) {
              return Promise.resolve(result);
            }
            if (result instanceof Promise) {
              throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
            }
            return acc;
          };
          if (ctx.common.async === false) {
            const inner = this._def.schema._parseSync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            });
            if (inner.status === "aborted")
              return INVALID;
            if (inner.status === "dirty")
              status.dirty();
            executeRefinement(inner.value);
            return { status: status.value, value: inner.value };
          } else {
            return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
              if (inner.status === "aborted")
                return INVALID;
              if (inner.status === "dirty")
                status.dirty();
              return executeRefinement(inner.value).then(() => {
                return { status: status.value, value: inner.value };
              });
            });
          }
        }
        if (effect.type === "transform") {
          if (ctx.common.async === false) {
            const base = this._def.schema._parseSync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            });
            if (!isValid(base))
              return INVALID;
            const result = effect.transform(base.value, checkCtx);
            if (result instanceof Promise) {
              throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
            }
            return { status: status.value, value: result };
          } else {
            return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
              if (!isValid(base))
                return INVALID;
              return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
                status: status.value,
                value: result
              }));
            });
          }
        }
        util.assertNever(effect);
      }
    };
    ZodEffects.create = (schema, effect, params) => {
      return new ZodEffects({
        schema,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect,
        ...processCreateParams(params)
      });
    };
    ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
      return new ZodEffects({
        schema,
        effect: { type: "preprocess", transform: preprocess },
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        ...processCreateParams(params)
      });
    };
    ZodOptional = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.undefined) {
          return OK(void 0);
        }
        return this._def.innerType._parse(input);
      }
      unwrap() {
        return this._def.innerType;
      }
    };
    ZodOptional.create = (type, params) => {
      return new ZodOptional({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodOptional,
        ...processCreateParams(params)
      });
    };
    ZodNullable = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.null) {
          return OK(null);
        }
        return this._def.innerType._parse(input);
      }
      unwrap() {
        return this._def.innerType;
      }
    };
    ZodNullable.create = (type, params) => {
      return new ZodNullable({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodNullable,
        ...processCreateParams(params)
      });
    };
    ZodDefault = class extends ZodType {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        let data = ctx.data;
        if (ctx.parsedType === ZodParsedType.undefined) {
          data = this._def.defaultValue();
        }
        return this._def.innerType._parse({
          data,
          path: ctx.path,
          parent: ctx
        });
      }
      removeDefault() {
        return this._def.innerType;
      }
    };
    ZodDefault.create = (type, params) => {
      return new ZodDefault({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodDefault,
        defaultValue: typeof params.default === "function" ? params.default : () => params.default,
        ...processCreateParams(params)
      });
    };
    ZodCatch = class extends ZodType {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const newCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          }
        };
        const result = this._def.innerType._parse({
          data: newCtx.data,
          path: newCtx.path,
          parent: {
            ...newCtx
          }
        });
        if (isAsync(result)) {
          return result.then((result2) => {
            return {
              status: "valid",
              value: result2.status === "valid" ? result2.value : this._def.catchValue({
                get error() {
                  return new ZodError(newCtx.common.issues);
                },
                input: newCtx.data
              })
            };
          });
        } else {
          return {
            status: "valid",
            value: result.status === "valid" ? result.value : this._def.catchValue({
              get error() {
                return new ZodError(newCtx.common.issues);
              },
              input: newCtx.data
            })
          };
        }
      }
      removeCatch() {
        return this._def.innerType;
      }
    };
    ZodCatch.create = (type, params) => {
      return new ZodCatch({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodCatch,
        catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
        ...processCreateParams(params)
      });
    };
    ZodNaN = class extends ZodType {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.nan) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.nan,
            received: ctx.parsedType
          });
          return INVALID;
        }
        return { status: "valid", value: input.data };
      }
    };
    ZodNaN.create = (params) => {
      return new ZodNaN({
        typeName: ZodFirstPartyTypeKind.ZodNaN,
        ...processCreateParams(params)
      });
    };
    BRAND = Symbol("zod_brand");
    ZodBranded = class extends ZodType {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
          data,
          path: ctx.path,
          parent: ctx
        });
      }
      unwrap() {
        return this._def.type;
      }
    };
    ZodPipeline = class _ZodPipeline extends ZodType {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.common.async) {
          const handleAsync = async () => {
            const inResult = await this._def.in._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            });
            if (inResult.status === "aborted")
              return INVALID;
            if (inResult.status === "dirty") {
              status.dirty();
              return DIRTY(inResult.value);
            } else {
              return this._def.out._parseAsync({
                data: inResult.value,
                path: ctx.path,
                parent: ctx
              });
            }
          };
          return handleAsync();
        } else {
          const inResult = this._def.in._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (inResult.status === "aborted")
            return INVALID;
          if (inResult.status === "dirty") {
            status.dirty();
            return {
              status: "dirty",
              value: inResult.value
            };
          } else {
            return this._def.out._parseSync({
              data: inResult.value,
              path: ctx.path,
              parent: ctx
            });
          }
        }
      }
      static create(a, b) {
        return new _ZodPipeline({
          in: a,
          out: b,
          typeName: ZodFirstPartyTypeKind.ZodPipeline
        });
      }
    };
    ZodReadonly = class extends ZodType {
      _parse(input) {
        const result = this._def.innerType._parse(input);
        const freeze = (data) => {
          if (isValid(data)) {
            data.value = Object.freeze(data.value);
          }
          return data;
        };
        return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
      }
      unwrap() {
        return this._def.innerType;
      }
    };
    ZodReadonly.create = (type, params) => {
      return new ZodReadonly({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodReadonly,
        ...processCreateParams(params)
      });
    };
    late = {
      object: ZodObject.lazycreate
    };
    (function(ZodFirstPartyTypeKind2) {
      ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
      ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
      ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
      ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
      ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
      ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
      ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
      ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
      ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
      ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
      ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
      ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
      ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
      ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
      ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
      ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
      ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
      ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
      ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
      ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
      ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
      ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
      ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
      ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
      ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
      ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
      ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
      ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
      ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
      ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
      ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
      ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
      ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
      ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
      ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
      ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
    })(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
    instanceOfType = (cls, params = {
      message: `Input not instance of ${cls.name}`
    }) => custom((data) => data instanceof cls, params);
    stringType = ZodString.create;
    numberType = ZodNumber.create;
    nanType = ZodNaN.create;
    bigIntType = ZodBigInt.create;
    booleanType = ZodBoolean.create;
    dateType = ZodDate.create;
    symbolType = ZodSymbol.create;
    undefinedType = ZodUndefined.create;
    nullType = ZodNull.create;
    anyType = ZodAny.create;
    unknownType = ZodUnknown.create;
    neverType = ZodNever.create;
    voidType = ZodVoid.create;
    arrayType = ZodArray.create;
    objectType = ZodObject.create;
    strictObjectType = ZodObject.strictCreate;
    unionType = ZodUnion.create;
    discriminatedUnionType = ZodDiscriminatedUnion.create;
    intersectionType = ZodIntersection.create;
    tupleType = ZodTuple.create;
    recordType = ZodRecord.create;
    mapType = ZodMap.create;
    setType = ZodSet.create;
    functionType = ZodFunction.create;
    lazyType = ZodLazy.create;
    literalType = ZodLiteral.create;
    enumType = ZodEnum.create;
    nativeEnumType = ZodNativeEnum.create;
    promiseType = ZodPromise.create;
    effectsType = ZodEffects.create;
    optionalType = ZodOptional.create;
    nullableType = ZodNullable.create;
    preprocessType = ZodEffects.createWithPreprocess;
    pipelineType = ZodPipeline.create;
    ostring = () => stringType().optional();
    onumber = () => numberType().optional();
    oboolean = () => booleanType().optional();
    coerce = {
      string: (arg) => ZodString.create({ ...arg, coerce: true }),
      number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
      boolean: (arg) => ZodBoolean.create({
        ...arg,
        coerce: true
      }),
      bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
      date: (arg) => ZodDate.create({ ...arg, coerce: true })
    };
    NEVER = INVALID;
  }
});

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});
var init_external = __esm({
  "node_modules/zod/v3/external.js"() {
    init_errors();
    init_parseUtil();
    init_typeAliases();
    init_util();
    init_types();
    init_ZodError();
  }
});

// node_modules/zod/index.js
var init_zod = __esm({
  "node_modules/zod/index.js"() {
    init_external();
    init_external();
  }
});

// src/config.ts
function testRerunConsent(cfg, cwd) {
  return cfg.consent.test_rerun[repoKey(cwd)];
}
function setTestRerunConsent(cwd, value) {
  return saveConfig({ consent: { test_rerun: { [repoKey(cwd)]: value } } });
}
function loadConfig() {
  const raw = readJson(configFile(), {});
  const parsed = ConfigSchema.safeParse(raw);
  const cfg = parsed.success ? parsed.data : ConfigSchema.parse({});
  cfg.jira.base_url ??= process.env.JIRA_BASE_URL;
  cfg.jira.email ??= process.env.JIRA_EMAIL;
  cfg.jira.api_token ??= process.env.JIRA_API_TOKEN;
  cfg.linear.api_key ??= process.env.LINEAR_API_KEY;
  return cfg;
}
function saveConfig(patch) {
  const current = readJson(configFile(), {});
  const merged = ConfigSchema.parse(deepMerge(current, patch));
  const toWrite = structuredClone(merged);
  delete toWrite.jira;
  delete toWrite.linear;
  writeJson(configFile(), toWrite);
  return merged;
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)) {
      out[k] = deepMerge(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
var ConfigSchema;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_zod();
    init_paths();
    ConfigSchema = external_exports.object({
      hourly_rate: external_exports.number().positive().default(75),
      writeback: external_exports.boolean().default(false),
      auto_apply: external_exports.enum(["off", "ask", "auto"]).default("ask"),
      models: external_exports.object({
        judge: external_exports.string().default("opus"),
        tier1: external_exports.string().default("haiku"),
        tier2_escalation: external_exports.string().default("sonnet"),
        coach: external_exports.string().default("haiku"),
        intake: external_exports.string().default("haiku")
      }).default({}),
      context_window: external_exports.number().int().positive().default(2e5),
      baseline_context_tokens: external_exports.number().int().nonnegative().default(15e3),
      coach: external_exports.object({
        min_interval_s: external_exports.number().nonnegative().default(180),
        max_per_session: external_exports.number().int().positive().default(8),
        llm_interval_s: external_exports.number().nonnegative().default(90),
        llm_min_session_usd: external_exports.number().nonnegative().default(1),
        auto_mute_after_skips: external_exports.number().int().positive().default(3),
        context_warn_pct: external_exports.number().default(70),
        context_critical_pct: external_exports.number().default(85),
        /* the hooks run the Coach after every assistant turn and hand observations to Claude without a pane */
        autopilot: external_exports.boolean().default(true)
      }).default({}),
      judge: external_exports.object({
        test_timeout_ms: external_exports.number().int().positive().default(3e5),
        run_tests: external_exports.boolean().default(true),
        deepThreshold: external_exports.number().nonnegative().default(3),
        tier1_confidence_floor: external_exports.number().min(0).max(1).default(0.6),
        tier1_evidence_tokens: external_exports.number().int().positive().default(6e3),
        tier2_escalation_tokens: external_exports.number().int().positive().default(3e3),
        /* below this session cost an escalation re-check runs on the small model (a claude -p call has a ~5.6k-token floor,
           so a sonnet escalation alone is ~5% of a $0.50 session); from here to deepThreshold it uses models.tier2_escalation */
        escalation_model_from_usd: external_exports.number().nonnegative().default(1)
      }).default({}),
      followup_days: external_exports.number().int().positive().default(7),
      dead_weight_sessions: external_exports.number().int().positive().default(5),
      jira: external_exports.object({
        base_url: external_exports.string().optional(),
        email: external_exports.string().optional(),
        api_token: external_exports.string().optional()
      }).default({}),
      linear: external_exports.object({ api_key: external_exports.string().optional() }).default({}),
      consent: external_exports.object({ test_rerun: external_exports.record(external_exports.boolean()).default({}) }).default({})
    });
  }
});

// src/commands/install.ts
var install_exports = {};
__export(install_exports, {
  run: () => run,
  runUninstall: () => runUninstall
});
import fs4 from "node:fs";
async function run(args) {
  const scope = has(args, "project") ? "project" : "user";
  ensureDir(tallyHome());
  if (!fs4.existsSync(pricingFile())) fs4.copyFileSync(bundledPricingPath(), pricingFile());
  saveConfig({});
  let r;
  try {
    r = install({ scope, cwd: process.cwd(), force: has(args, "force") });
  } catch (err) {
    if (err instanceof PluginConflictError) {
      process.stderr.write(`${err.message}
`);
      return 1;
    }
    throw err;
  }
  process.stdout.write(`Installed ${r.added} hook group(s) into ${r.file}${r.statusline ? " and the Tally status line" : ""}
`);
  if (r.backup) process.stdout.write(`Backup: ${r.backup}
`);
  process.stdout.write(`Data dir: ${tallyHome()}
The Coach now runs on its own after every turn (autopilot) and the status line shows the task, spend and flags; \`tally watch\` opens the optional one-key pane. Check with \`tally doctor\`.
`);
}
async function runUninstall(args) {
  const scope = has(args, "project") ? "project" : "user";
  if (!isInstalled(scope, process.cwd())) {
    process.stdout.write(`No Tally hooks found in ${scope} settings.
`);
  }
  const r = uninstall({ scope, cwd: process.cwd() });
  process.stdout.write(`Removed ${r.removed} hook(s) from ${r.file}${r.restoredOriginal ? " (original bytes restored)" : ""}
`);
}
var init_install2 = __esm({
  "src/commands/install.ts"() {
    "use strict";
    init_cli();
    init_install();
    init_paths();
    init_pricing();
    init_config();
  }
});

// src/llm/client.ts
import fs5 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
import { spawn, spawnSync } from "node:child_process";
function tallySpendFile() {
  return path4.join(tallyHome(), "tally-spend.jsonl");
}
function recordTallySpend(entry) {
  appendLine(tallySpendFile(), JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry }));
}
function resolveClaudeBin(explicit) {
  if (explicit) return /\.[cm]?js$/i.test(explicit) ? { bin: process.execPath, prefix: [explicit] } : { bin: explicit, prefix: [] };
  if (resolvedClaude) return resolvedClaude;
  let result = { bin: "claude", prefix: [] };
  if (process.platform === "win32") {
    const where = spawnSync("where.exe", ["claude"], { encoding: "utf8", windowsHide: true });
    const first = (where.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && /\.cmd$/i.test(first) && fs5.existsSync(first)) {
      const body = fs5.readFileSync(first, "utf8");
      const m = /"%dp0%\\([^"]+\.js)"/i.exec(body) ?? /"%~dp0\\([^"]+\.js)"/i.exec(body);
      if (m) {
        const js = path4.join(path4.dirname(first), m[1]);
        if (fs5.existsSync(js)) result = { bin: process.execPath, prefix: [js] };
      }
    } else if (first && /\.exe$/i.test(first)) {
      result = { bin: first, prefix: [] };
    }
  }
  resolvedClaude = result;
  return result;
}
function killTree(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
  }
}
function runProcess(bin, args, opts) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const verbatim = isWin && /cmd(\.exe)?$/i.test(bin);
    const env = opts.replaceEnv ? { ...opts.env ?? {} } : { ...process.env, ...opts.env ?? {} };
    const child = spawn(bin, args, { cwd: opts.cwd, shell: opts.shell ?? false, windowsHide: true, detached: !isWin, windowsVerbatimArguments: verbatim, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      setTimeout(() => finish(null), 300);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => stdout += d.toString("utf8"));
    child.stderr?.on("data", (d) => stderr += d.toString("utf8"));
    child.on("error", (e) => {
      stderr += String(e);
      finish(-1);
    });
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => setTimeout(() => finish(code), 200));
    if (opts.input !== void 0) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}
function makeLlm(opts = {}) {
  if (opts.stub || process.env.TALLY_LLM === "stub") return new StubLlm(opts.stub ?? defaultStubs(), opts.session);
  return new ClaudeCli({ session: opts.session });
}
function defaultStubs() {
  return {
    intake: () => ({
      title: "Task",
      criteria: [{ text: "The requested change is implemented", source: "inferred" }],
      spec_quality: { score: 4, missing: ["acceptance criteria", "test expectations"], questions: ["What does done look like?"] },
      estimate_hours: 2,
      rationale: "stub"
    }),
    judge: () => ({
      criteria: [],
      quality_score: 6,
      quality_reason: "stub",
      verdict_reason: "stub",
      recommendations: ["stub"]
    }),
    coach: () => ({ suggestions: [] })
  };
}
var ClaudeCli, StubLlm, resolvedClaude;
var init_client = __esm({
  "src/llm/client.ts"() {
    "use strict";
    init_paths();
    init_pricing();
    ClaudeCli = class {
      constructor(opts = {}) {
        this.opts = opts;
      }
      async complete(req) {
        try {
          return await this.completeOnce(req, 4);
        } catch (err) {
          if (err instanceof Error && /error_max_turns/.test(err.message)) return this.completeOnce(req, 10);
          throw err;
        }
      }
      async completeOnce(req, maxTurns) {
        const started = Date.now();
        const cwd = fs5.mkdtempSync(path4.join(os2.tmpdir(), "tally-llm-"));
        const viaStdin = req.prompt.length > 6e3;
        const args = [
          "-p",
          viaStdin ? "The full evidence pack follows on stdin. Judge it exactly as instructed in the system prompt and return only the JSON object." : req.prompt,
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(req.schema),
          "--model",
          req.model,
          "--system-prompt",
          req.system,
          "--max-turns",
          String(maxTurns),
          "--tools",
          "",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--strict-mcp-config"
        ];
        const resolved = resolveClaudeBin(this.opts.claudeBin ?? process.env.TALLY_CLAUDE_BIN);
        const out = await runProcess(resolved.bin, [...resolved.prefix, ...args], { cwd, timeoutMs: req.timeoutMs ?? 24e4, env: { TALLY_INTERNAL: "1", CLAUDE_CODE_ENTRYPOINT: "tally" }, input: viaStdin ? req.prompt : void 0 });
        fs5.rmSync(cwd, { recursive: true, force: true });
        let parsed;
        try {
          parsed = JSON.parse(out.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
        } catch {
          throw new Error(`claude -p returned non-JSON output: ${out.stdout.slice(0, 300)} ${out.stderr.slice(0, 300)}`);
        }
        if (parsed.is_error || process.env.TALLY_LLM_DEBUG) {
          const dir = path4.join(tallyHome(), "llm-debug");
          fs5.mkdirSync(dir, { recursive: true });
          fs5.writeFileSync(path4.join(dir, `${Date.now()}-${req.kind}${req.tier ?? ""}.json`), JSON.stringify({ model: req.model, args: args.map((a) => a.length > 4e3 ? a.slice(0, 4e3) + "\u2026" : a), stdout: out.stdout.slice(0, 2e4), stderr: out.stderr.slice(0, 4e3), code: out.code, timedOut: out.timedOut }, null, 2));
        }
        if (parsed.is_error) {
          const p = parsed;
          throw new Error(`claude -p error (${p.subtype ?? "error"}${p.api_error_status ? ` ${p.api_error_status}` : ""}, model ${req.model}): ${parsed.result || out.stderr.trim().slice(0, 300) || "no detail"}`);
        }
        let data = parsed.structured_output;
        if (data === void 0 && typeof parsed.result === "string") {
          try {
            data = JSON.parse(parsed.result);
          } catch {
            throw new Error("claude -p returned no structured output");
          }
        }
        if (data === void 0) throw new Error("claude -p returned no structured output");
        const u = parsed.usage ?? {};
        const usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_write: u.cache_creation_input_tokens ?? 0,
          cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0
        };
        const usageEntries = Object.entries(parsed.modelUsage ?? {});
        const wanted = canonicalModel(req.model);
        const modelKey = usageEntries.find(([k]) => canonicalModel(k) === wanted)?.[0] ?? usageEntries.sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))[0]?.[0];
        const model = canonicalModel(modelKey ?? req.model);
        const cost_usd = parsed.total_cost_usd ?? 0;
        recordTallySpend({ kind: req.tier ? `${req.kind}:tier${req.tier}` : req.kind, model, cost_usd, usage, session: this.opts.session });
        log(`llm ${req.kind}${req.tier ? ":tier" + req.tier : ""} model=${model} cost=${cost_usd.toFixed(4)} ms=${Date.now() - started}`);
        return { data, usage, cost_usd, model, duration_ms: Date.now() - started };
      }
    };
    StubLlm = class {
      constructor(responders, session) {
        this.responders = responders;
        this.session = session;
      }
      calls = [];
      async complete(req) {
        this.calls.push(req);
        const r = this.responders[req.kind];
        if (!r) throw new Error(`StubLlm: no responder for ${req.kind}`);
        const usage = { input: 1200, output: 400, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
        const cost_usd = req.kind === "judge" ? req.tier === 1 ? 0.012 : 0.05 : 4e-3;
        recordTallySpend({ kind: req.kind, model: `stub:${req.model}`, cost_usd, usage, session: this.session });
        return { data: r(req), usage, cost_usd, model: `stub:${req.model}`, duration_ms: 1 };
      }
    };
    resolvedClaude = null;
  }
});

// src/task/fetchers.ts
import fs6 from "node:fs";
import path5 from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";
function classifyRef(ref, cwd, deps = realDeps) {
  const gh = GH_RE.exec(ref);
  if (gh) return { kind: "github", ref, url: gh[0], owner: gh[1], repo: gh[2], number: Number(gh[4]), is_pr: gh[3] === "pull" };
  const jira = JIRA_RE.exec(ref);
  if (jira) return { kind: "jira", ref, url: jira[0], key: jira[2] };
  const lin = LINEAR_RE.exec(ref);
  if (lin) return { kind: "linear", ref, url: lin[0], key: lin[1] };
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(ref.trim())) return { kind: "jira", ref, key: ref.trim() };
  if (/\.md$/i.test(ref.trim()) && !/\s/.test(ref.trim())) {
    const p = path5.isAbsolute(ref.trim()) ? ref.trim() : path5.resolve(cwd, ref.trim());
    if (deps.exists(p)) return { kind: "file", ref: p };
  }
  return { kind: "text", ref };
}
function storyPointsFrom(fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (/story.?points?|estimate/i.test(k) && typeof v === "number") return v;
    if (k.startsWith("customfield_") && typeof v === "number" && v > 0 && v <= 40 && /1001[0-9]|1002[0-9]/.test(k)) return v;
  }
  return void 0;
}
function adfToText(node) {
  if (!node || typeof node !== "object") return "";
  const n = node;
  if (n.type === "text") return n.text ?? "";
  const inner = (n.content ?? []).map(adfToText).join("");
  if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") return inner + "\n";
  return inner;
}
async function fetchTask(ref, opts) {
  const deps = opts.deps ?? realDeps;
  const source = classifyRef(ref, opts.cwd, deps);
  const fallback = (err) => ({
    source: { ...source, kind: source.kind },
    title: firstLine(opts.promptText ?? ref),
    body: opts.promptText ?? ref,
    labels: [],
    fetch_error: err
  });
  try {
    switch (source.kind) {
      case "github": {
        const sub = source.is_pr ? "pr" : "issue";
        const r = deps.exec("gh", [sub, "view", source.url, "--json", "title,body,labels,number,url,state"]);
        if (!r.ok) return fallback(`gh ${sub} view failed: ${r.stderr.trim().slice(0, 200)}`);
        const j = JSON.parse(r.stdout);
        const labels = (j.labels ?? []).map((l) => l.name);
        const sp = labels.map((l) => /^(?:sp|points?)[:\s-]*(\d+)$/i.exec(l)?.[1]).find(Boolean);
        return { source, title: j.title, body: j.body ?? "", labels, state: j.state, story_points: sp ? Number(sp) : void 0 };
      }
      case "jira": {
        const base = opts.cfg.jira.base_url ?? (source.url ? new URL(source.url).origin : void 0);
        if (!base || !opts.cfg.jira.email || !opts.cfg.jira.api_token) return fallback("Jira not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)");
        const auth = Buffer.from(`${opts.cfg.jira.email}:${opts.cfg.jira.api_token}`).toString("base64");
        const r = await deps.fetch(`${base.replace(/\/$/, "")}/rest/api/3/issue/${source.key}`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
        if (!r.ok) return fallback(`Jira ${r.status}`);
        const j = JSON.parse(await r.text());
        const desc = typeof j.fields.description === "string" ? j.fields.description : adfToText(j.fields.description);
        return { source: { ...source, url: source.url ?? `${base}/browse/${source.key}` }, title: j.fields.summary ?? source.key, body: desc, labels: j.fields.labels ?? [], state: j.fields.status?.name, story_points: storyPointsFrom(j.fields) };
      }
      case "linear": {
        if (!opts.cfg.linear.api_key) return fallback("Linear not configured (LINEAR_API_KEY)");
        const r = await deps.fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: opts.cfg.linear.api_key, "Content-Type": "application/json" },
          body: JSON.stringify({ query: `query($id: String!) { issue(id: $id) { id identifier title description estimate url state { name } labels { nodes { name } } } }`, variables: { id: source.key } })
        });
        if (!r.ok) return fallback(`Linear ${r.status}`);
        const j = JSON.parse(await r.text());
        const issue = j.data?.issue;
        if (!issue) return fallback(`Linear returned no issue: ${JSON.stringify(j.errors ?? "").slice(0, 200)}`);
        return { source: { ...source, url: issue.url ?? source.url }, title: issue.title, body: issue.description ?? "", labels: (issue.labels?.nodes ?? []).map((l) => l.name), state: issue.state?.name, story_points: issue.estimate };
      }
      case "file": {
        const body = deps.readFile(source.ref);
        const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? path5.basename(source.ref, ".md");
        return { source, title, body, labels: [] };
      }
      default:
        return { source, title: firstLine(ref), body: ref, labels: [] };
    }
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
}
function firstLine(s) {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "Untitled task";
  return line.length > 90 ? line.slice(0, 87) + "..." : line;
}
var realDeps, GH_RE, JIRA_RE, LINEAR_RE;
var init_fetchers = __esm({
  "src/task/fetchers.ts"() {
    "use strict";
    realDeps = {
      exec: (bin, args) => {
        const r = spawnSync2(bin, args, { encoding: "utf8", windowsHide: true, timeout: 3e4, ...process.platform === "win32" ? { shell: false } : {} });
        return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      fetch: async (url, init) => {
        const r = await fetch(url, init);
        return { ok: r.ok, status: r.status, text: () => r.text() };
      },
      readFile: (p) => fs6.readFileSync(p, "utf8"),
      exists: (p) => fs6.existsSync(p)
    };
    GH_RE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(issues|pull)\/(\d+)/;
    JIRA_RE = /https?:\/\/([^/\s]+)\/browse\/([A-Z][A-Z0-9]+-\d+)/;
    LINEAR_RE = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z0-9]+-\d+)/;
  }
});

// src/store/events.ts
import fs7 from "node:fs";
import path6 from "node:path";
function eventsFile(sessionId) {
  return path6.join(sessionDir(sessionId), "events.jsonl");
}
function appendEvent(ev) {
  appendLine(eventsFile(ev.session), JSON.stringify(ev));
}
function readEvents(sessionId) {
  return readEventsFile(eventsFile(sessionId));
}
function readEventsFile(file) {
  if (!fs7.existsSync(file)) return [];
  const out = [];
  for (const line of fs7.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
function listSessions() {
  const dir = sessionsDir();
  if (!fs7.existsSync(dir)) return [];
  return fs7.readdirSync(dir).filter((d) => fs7.existsSync(path6.join(dir, d, "events.jsonl"))).map((d) => ({ d, m: fs7.statSync(path6.join(dir, d, "events.jsonl")).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.d);
}
var EventTail;
var init_events = __esm({
  "src/store/events.ts"() {
    "use strict";
    init_paths();
    EventTail = class {
      constructor(file) {
        this.file = file;
      }
      offset = 0;
      poll() {
        if (!fs7.existsSync(this.file)) return [];
        const size = fs7.statSync(this.file).size;
        if (size <= this.offset) return [];
        const fd = fs7.openSync(this.file, "r");
        try {
          const buf = Buffer.alloc(size - this.offset);
          fs7.readSync(fd, buf, 0, buf.length, this.offset);
          const text = buf.toString("utf8");
          const lastNl = text.lastIndexOf("\n");
          if (lastNl < 0) return [];
          this.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
          const out = [];
          for (const line of text.slice(0, lastNl).split("\n")) {
            if (!line.trim()) continue;
            try {
              out.push(JSON.parse(line));
            } catch {
            }
          }
          return out;
        } finally {
          fs7.closeSync(fd);
        }
      }
    };
  }
});

// src/judge/verify.ts
import fs8 from "node:fs";
import path7 from "node:path";
function detectTestCommand(cwd) {
  const pkg = path7.join(cwd, "package.json");
  if (fs8.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs8.readFileSync(pkg, "utf8"));
      const t = j.scripts?.test;
      if (t && !/no test specified/i.test(t)) {
        const runner = fs8.existsSync(path7.join(cwd, "bun.lockb")) || fs8.existsSync(path7.join(cwd, "bun.lock")) ? "bun test" : fs8.existsSync(path7.join(cwd, "pnpm-lock.yaml")) ? "pnpm test" : fs8.existsSync(path7.join(cwd, "yarn.lock")) ? "yarn test" : "npm test";
        return { command: runner === "bun test" ? "bun run test" : runner, basis: "package.json scripts.test" };
      }
    } catch {
    }
  }
  const has2 = (f) => fs8.existsSync(path7.join(cwd, f));
  if (has2("pytest.ini") || has2("conftest.py") || has2("tests") && (has2("pyproject.toml") || has2("setup.py") || has2("requirements.txt"))) return { command: "python -m pytest -q", basis: "pytest layout" };
  if (has2("pyproject.toml")) {
    const p = fs8.readFileSync(path7.join(cwd, "pyproject.toml"), "utf8");
    if (/pytest/.test(p)) return { command: "python -m pytest -q", basis: "pyproject.toml mentions pytest" };
  }
  if (has2("go.mod")) return { command: "go test ./...", basis: "go.mod" };
  if (has2("Cargo.toml")) return { command: "cargo test", basis: "Cargo.toml" };
  if (has2("Makefile") && /^test:/m.test(fs8.readFileSync(path7.join(cwd, "Makefile"), "utf8"))) return { command: "make test", basis: "Makefile test target" };
  if (has2("mix.exs")) return { command: "mix test", basis: "mix.exs" };
  if (has2("Gemfile") && has2("spec")) return { command: "bundle exec rspec", basis: "Gemfile + spec/" };
  if (has2("pom.xml")) return { command: "mvn -q test", basis: "pom.xml" };
  if (has2("build.gradle") || has2("build.gradle.kts")) return { command: "gradle test", basis: "gradle build file" };
  return null;
}
function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === void 0) continue;
    if (ENV_KEEP.has(k)) out[k] = v;
    else if (!SECRET_LIKE.test(k) && !/^(TALLY_|CLAUDE_)/.test(k) && !/^[A-Z0-9_]*(TOKEN|KEY|SECRET)[A-Z0-9_]*$/i.test(k) && v.length < 200 && !/^(sk-|ghp_|xox|AKIA|eyJ)/.test(v)) out[k] = v;
  }
  out.TALLY_INTERNAL = "1";
  out.TALLY_TEST_RERUN = "1";
  return out;
}
async function runVerification(cwd, opts) {
  if (opts.enabled === false) return { ran: false, reason: "disabled in config (judge.run_tests=false)" };
  if (opts.consent !== true) return { ran: false, reason: NO_CONSENT_REASON, consent: opts.consent };
  const detected = opts.command ? { command: opts.command, basis: "configured" } : detectTestCommand(cwd);
  if (!detected) return { ran: false, reason: "no test command detected", consent: true };
  const started = Date.now();
  const isWin = process.platform === "win32";
  const r = await runProcess(isWin ? "cmd.exe" : "sh", isWin ? ["/d", "/s", "/c", `"${detected.command}"`] : ["-c", detected.command], { cwd, timeoutMs: opts.timeoutMs, env: scrubEnv(), replaceEnv: true });
  const out = (r.stdout + "\n" + r.stderr).trim();
  return {
    ran: true,
    command: detected.command,
    basis: detected.basis,
    passed: !r.timedOut && r.code === 0,
    exit_code: r.code,
    timed_out: r.timedOut,
    duration_ms: Date.now() - started,
    output_tail: out.length > 3e3 ? "\u2026" + out.slice(-3e3) : out,
    env_scrubbed: true,
    consent: true
  };
}
var NO_CONSENT_REASON, ENV_KEEP, SECRET_LIKE;
var init_verify = __esm({
  "src/judge/verify.ts"() {
    "use strict";
    init_client();
    NO_CONSENT_REASON = "tests not run: no consent";
    ENV_KEEP = /* @__PURE__ */ new Set(["PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "COMSPEC", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "ProgramFiles", "PROGRAMDATA", "ProgramData", "USER", "USERNAME", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "CI", "NODE_ENV", "NODE_OPTIONS", "npm_config_cache", "GOPATH", "GOROOT", "GOCACHE", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "NVM_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
    SECRET_LIKE = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|CERT|API|JIRA|LINEAR|ANTHROPIC|OPENAI|GITHUB|GH_|AWS_|AZURE_|GCP_|GOOGLE_|STRIPE|SLACK|TWILIO|DATABASE_URL|DB_|REDIS|MONGO|POSTGRES|NPM_|VERCEL|CLAUDE)/i;
  }
});

// src/judge/checks.ts
import fs9 from "node:fs";
import path8 from "node:path";
function parseCheck(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  if (!r.kind || r.kind === "none") return null;
  const p = CheckSpecSchema.safeParse(raw);
  return p.success ? p.data : null;
}
function norm(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
function fileMatches(candidates, wanted) {
  const w = norm(wanted);
  return candidates.find((c) => {
    const n = norm(c);
    return n === w || n.endsWith("/" + w) || w.endsWith("/" + n);
  });
}
function safeRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}
function commandAllowed(command, cwd, testCommand) {
  const c = command.trim();
  if (testCommand && c === testCommand.trim()) return true;
  const m = /^(?:npm|pnpm|yarn|bun) run ([\w:.-]+)$/.exec(c) ?? /^npm (test|run\s+[\w:.-]+)$/.exec(c);
  if (m) {
    try {
      const pkg = JSON.parse(fs9.readFileSync(path8.join(cwd, "package.json"), "utf8"));
      const script = m[1] === "test" ? "test" : m[1].replace(/^run\s+/, "");
      return !!pkg.scripts?.[script];
    } catch {
      return false;
    }
  }
  if (/^npx tsc( --noEmit)?( -p [\w./-]+)?$/.test(c)) return fs9.existsSync(path8.join(cwd, "tsconfig.json"));
  if (/^make [\w-]+$/.test(c)) return fs9.existsSync(path8.join(cwd, "Makefile"));
  if (/^(python -m )?pytest( -q)?$/.test(c) || /^go test \.\/\.\.\.$/.test(c) || /^cargo test$/.test(c)) return true;
  return false;
}
async function resolveCheck(check, ctx) {
  const { evidence: ev, verification: ver } = ctx;
  if (ctx.noTree && check.kind !== "tests_pass" && check.kind !== "pr") {
    const rec = ev.reconstruction;
    if (check.kind === "file_changed") {
      const hit = check.path === "." || check.path === "*" ? rec.changes[0]?.file : fileMatches(rec.changes.map((c) => c.file), check.path);
      return hit ? { status: "met", evidence: `${hit} was written by the session (reconstructed from the transcript, not verified against disk)`, files: [hit] } : { status: "unverifiable", evidence: `no git tree for this session and the transcript shows no write to ${check.path}`, files: [] };
    }
    if (check.kind === "diff_contains") {
      const re = safeRegex(check.pattern);
      if (!re) return { status: "unverifiable", evidence: `invalid pattern ${check.pattern}`, files: [] };
      const m = re.exec(rec.diff_text);
      return m ? { status: "met", evidence: `reconstructed changes match /${check.pattern}/ ("${m[0].slice(0, 60)}"), not verified against disk`, files: [] } : { status: "unverifiable", evidence: `no git tree for this session and the reconstructed changes do not match /${check.pattern}/`, files: [] };
    }
    return { status: "unverifiable", evidence: `no git tree for this session; a ${check.kind} check needs a real tree`, files: [] };
  }
  switch (check.kind) {
    case "tests_pass": {
      if (!ver.ran) return { status: "unverifiable", evidence: `tests not run (${ver.reason ?? "unknown"})`, files: [] };
      return ver.passed ? { status: "met", evidence: `independent run of \`${ver.command}\` passed`, files: [] } : { status: "unmet", evidence: `independent run of \`${ver.command}\` ${ver.timed_out ? "timed out" : `failed (exit ${ver.exit_code})`}`, files: [] };
    }
    case "file_exists": {
      const p = path8.join(ctx.cwd, check.path);
      return fs9.existsSync(p) ? { status: "met", evidence: `${check.path} exists`, files: [check.path] } : { status: "unmet", evidence: `${check.path} does not exist`, files: [] };
    }
    case "file_changed": {
      const hit = check.path === "." || check.path === "*" ? ev.git.files_changed[0] : fileMatches(ev.git.files_changed, check.path);
      return hit ? { status: "met", evidence: `${hit} is in the diff`, files: [hit] } : { status: "unmet", evidence: `${check.path} is not in the diff (${ev.git.files_changed.length} files changed)`, files: [] };
    }
    case "file_contains": {
      const p = path8.join(ctx.cwd, check.path);
      if (!fs9.existsSync(p)) return { status: "unmet", evidence: `${check.path} does not exist`, files: [] };
      const re = safeRegex(check.pattern);
      if (!re) return { status: "unverifiable", evidence: `invalid pattern ${check.pattern}`, files: [] };
      const body = fs9.readFileSync(p, "utf8");
      const m = re.exec(body);
      return m ? { status: "met", evidence: `${check.path} matches /${check.pattern}/ ("${m[0].slice(0, 60)}")`, files: [check.path] } : { status: "unmet", evidence: `${check.path} does not match /${check.pattern}/`, files: [check.path] };
    }
    case "diff_contains": {
      const re = safeRegex(check.pattern);
      if (!re) return { status: "unverifiable", evidence: `invalid pattern ${check.pattern}`, files: [] };
      const m = re.exec(ev.git.diff_excerpt);
      return m ? { status: "met", evidence: `diff matches /${check.pattern}/ ("${m[0].slice(0, 60)}")`, files: [] } : { status: "unmet", evidence: `diff does not match /${check.pattern}/`, files: [] };
    }
    case "pr": {
      const kinds = ev.ship_events.map((s) => s.kind);
      const ok = check.state === "pushed" ? kinds.length > 0 : check.state === "opened" ? kinds.includes("pr") || kinds.includes("merge") : kinds.includes("merge");
      return ok ? { status: "met", evidence: `ship events: ${kinds.join(", ")}`, files: [] } : { status: "unmet", evidence: `no ${check.state} event recorded (${kinds.join(", ") || "none"})`, files: [] };
    }
    case "command": {
      if (!commandAllowed(check.command, ctx.cwd, ver.command)) return { status: "unverifiable", evidence: `command not in the repo's own scripts, not run: ${check.command}`, files: [] };
      if (ctx.consent !== true) return { status: "unverifiable", evidence: `${NO_CONSENT_REASON}: ${check.command}`, files: [] };
      if (ver.ran && ver.command === check.command) return ver.passed ? { status: "met", evidence: `\`${check.command}\` exited 0 (independent run)`, files: [] } : { status: "unmet", evidence: `\`${check.command}\` failed (exit ${ver.exit_code})`, files: [] };
      const isWin = process.platform === "win32";
      const r = await runProcess(isWin ? "cmd.exe" : "sh", isWin ? ["/d", "/s", "/c", `"${check.command}"`] : ["-c", check.command], { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, env: scrubEnv(), replaceEnv: true });
      const ok = !r.timedOut && r.code === check.expect_exit;
      return ok ? { status: "met", evidence: `\`${check.command}\` exited ${r.code}`, files: [] } : { status: "unmet", evidence: `\`${check.command}\` ${r.timedOut ? "timed out" : `exited ${r.code}, expected ${check.expect_exit}`}: ${(r.stdout + r.stderr).trim().slice(-300)}`, files: [] };
    }
  }
}
var CheckSpecSchema, CHECK_KINDS, CHECK_JSON_SCHEMA;
var init_checks = __esm({
  "src/judge/checks.ts"() {
    "use strict";
    init_zod();
    init_client();
    init_verify();
    CheckSpecSchema = external_exports.discriminatedUnion("kind", [
      external_exports.object({ kind: external_exports.literal("tests_pass") }),
      external_exports.object({ kind: external_exports.literal("file_exists"), path: external_exports.string().min(1) }),
      external_exports.object({ kind: external_exports.literal("file_changed"), path: external_exports.string().min(1) }),
      external_exports.object({ kind: external_exports.literal("file_contains"), path: external_exports.string().min(1), pattern: external_exports.string().min(1) }),
      external_exports.object({ kind: external_exports.literal("diff_contains"), pattern: external_exports.string().min(1) }),
      external_exports.object({ kind: external_exports.literal("command"), command: external_exports.string().min(1), expect_exit: external_exports.number().int().default(0) }),
      external_exports.object({ kind: external_exports.literal("pr"), state: external_exports.enum(["pushed", "opened", "merged"]).default("pushed") })
    ]);
    CHECK_KINDS = ["tests_pass", "file_exists", "file_changed", "file_contains", "diff_contains", "command", "pr"];
    CHECK_JSON_SCHEMA = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["none", ...CHECK_KINDS] },
        path: { type: "string" },
        pattern: { type: "string" },
        command: { type: "string" },
        expect_exit: { type: "number" },
        state: { type: "string", enum: ["pushed", "opened", "merged"] }
      },
      required: ["kind"]
    };
  }
});

// src/task/intake.ts
import fs10 from "node:fs";
import path9 from "node:path";
import crypto from "node:crypto";
function taskFile(session) {
  return path9.join(sessionDir(session), "task.json");
}
function intakeCacheKey(fetched, model) {
  const material = JSON.stringify({ kind: fetched.source.kind, ref: fetched.source.url ?? fetched.source.ref, title: fetched.title, body: fetched.body, labels: fetched.labels, sp: fetched.story_points ?? null, model, v: 2 });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}
function intakeCacheFile(key) {
  return path9.join(tallyHome(), "cache", "intake", `${key}.json`);
}
function loadTask(session) {
  const raw = readJson(taskFile(session), null);
  if (!raw) return null;
  const p = TaskSchema.safeParse(raw);
  return p.success ? p.data : null;
}
function computeEstimate(fetched, llmHours) {
  if (typeof fetched.story_points === "number" && fetched.story_points > 0) {
    return { hours: fetched.story_points * HOURS_PER_STORY_POINT, basis: "story_points", story_points: fetched.story_points };
  }
  if (llmHours > 0) return { hours: Math.round(llmHours * 10) / 10, basis: "llm" };
  return { hours: 2, basis: "default" };
}
function computeBudget(hours, hourlyRate) {
  return Math.max(BUDGET_FLOOR_USD, Math.round(hours * hourlyRate * BUDGET_FRACTION * 100) / 100);
}
async function intake(opts) {
  const existing = loadTask(opts.session);
  if (existing && !opts.force) return { task: existing, created: false };
  const ref = opts.ref ?? opts.text ?? "";
  const fetched = await fetchTask(ref, { cwd: opts.cwd, cfg: opts.cfg, deps: opts.deps, promptText: opts.text });
  if (opts.override) {
    fetched.title = opts.override.title;
    fetched.body = opts.override.body;
  }
  const bodyForLlm = fetched.body.slice(0, 12e3);
  const inferred = fetched.source.kind === "text";
  const ctxText = inferred && opts.context ? `
${opts.context.branch ? `BRANCH: ${opts.context.branch}
` : ""}${opts.context.commits?.length ? `COMMITS MADE DURING THE SESSION:
${opts.context.commits.slice(0, 20).map((c) => "- " + c).join("\n")}
` : ""}` : "";
  const prompt = `TITLE: ${fetched.title}
SOURCE: ${fetched.source.kind}${fetched.source.url ? " " + fetched.source.url : ""}${inferred ? " (no ticket: infer the task from the developer's own words, branch and commits; keep criteria to what they evidently set out to do)" : ""}
LABELS: ${fetched.labels.join(", ") || "(none)"}
${fetched.story_points ? `STORY POINTS: ${fetched.story_points}
` : ""}${ctxText}
DESCRIPTION:
${bodyForLlm || "(empty)"}`;
  const cacheKey = intakeCacheKey(fetched, opts.cfg.models.intake);
  const cachedOut = opts.noCache ? null : readJson(intakeCacheFile(cacheKey), null);
  let out;
  let cost = 0;
  let model;
  let cached3 = false;
  if (cachedOut) {
    out = cachedOut.out;
    model = cachedOut.model;
    cached3 = true;
  } else {
    const r2 = await opts.llm.complete({ kind: "intake", model: opts.cfg.models.intake, system: INTAKE_SYSTEM, prompt, schema: INTAKE_SCHEMA });
    out = r2.data;
    cost = r2.cost_usd;
    model = r2.model;
    writeJson(intakeCacheFile(cacheKey), { key: cacheKey, ts: (/* @__PURE__ */ new Date()).toISOString(), model, out });
  }
  const criteria = (out.criteria ?? []).filter((c) => c.text?.trim()).map((c, i) => {
    const check = parseCheck(c.check);
    return { id: `c${i + 1}`, text: c.text.trim(), source: c.source === "explicit" ? "explicit" : "inferred", kind: check ? "mechanical" : "judgment", ...check ? { check } : {} };
  });
  if (criteria.length === 0) criteria.push({ id: "c1", text: `Deliver: ${fetched.title}`, source: "inferred", kind: "judgment" });
  const r = { cost_usd: cost, model };
  const score = Math.max(0, Math.min(10, Number(out.spec_quality?.score ?? 0)));
  const estimate = computeEstimate(fetched, Number(out.estimate_hours ?? 0));
  const task = {
    session: opts.session,
    cwd: opts.cwd,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    frozen: true,
    source: fetched.source,
    title: out.title?.trim() || fetched.title,
    body_excerpt: fetched.body.slice(0, 1500),
    labels: fetched.labels,
    fetch_error: fetched.fetch_error,
    criteria,
    spec_quality: { score, missing: out.spec_quality?.missing ?? [], questions: out.spec_quality?.questions ?? [] },
    needs_clarification: score < 5,
    estimate,
    budget_usd: computeBudget(estimate.hours, opts.cfg.hourly_rate),
    hourly_rate: opts.cfg.hourly_rate,
    tally_cost_usd: r.cost_usd,
    model: r.model,
    cache_key: cacheKey,
    cached: cached3,
    ...opts.historical ? { historical: opts.historical } : {},
    ...inferred ? { inferred: true, confirmed: false, context: opts.context } : {}
  };
  TaskSchema.parse(task);
  ensureDir(sessionDir(opts.session));
  writeJson(taskFile(opts.session), task);
  const pending = path9.join(sessionDir(opts.session), "task.pending");
  if (fs10.existsSync(pending)) fs10.unlinkSync(pending);
  appendEvent({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    type: "task",
    session: opts.session,
    cwd: opts.cwd,
    data: { title: task.title, criteria: task.criteria.length, spec_quality: task.spec_quality.score, needs_clarification: task.needs_clarification, budget_usd: task.budget_usd, estimate_hours: task.estimate.hours, source: task.source.kind }
  });
  return { task, created: true };
}
function confirmTask(session) {
  const t = loadTask(session);
  if (!t) return null;
  t.confirmed = true;
  writeJson(taskFile(session), t);
  appendEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), type: "task", session, cwd: t.cwd, data: { confirmed: true, title: t.title } });
  return t;
}
function renderTask(task) {
  const lines = [];
  lines.push(`Task: ${task.title}  [${task.inferred ? task.confirmed ? "inferred task (confirmed)" : "inferred task (unconfirmed)" : task.source.kind}${task.source.url ? " " + task.source.url : ""}]`);
  if (task.fetch_error) lines.push(`  (fetch failed, used prompt text: ${task.fetch_error})`);
  lines.push(`Acceptance criteria (frozen):`);
  for (const c of task.criteria) lines.push(`  ${c.id}. ${c.text}${c.source === "inferred" ? "  (inferred)" : ""}  [${c.kind === "mechanical" ? `mechanical: ${c.check?.kind}` : "judgment"}]`);
  if (task.cached) lines.push(`  (intake served from cache; no model call)`);
  if (task.historical) lines.push(`  (historical: ${task.historical.note})`);
  lines.push(`Spec quality: ${task.spec_quality.score}/10${task.needs_clarification ? "  -> Clarify the ticket first" : ""}`);
  if (task.spec_quality.missing.length) lines.push(`  Missing: ${task.spec_quality.missing.join("; ")}`);
  if (task.needs_clarification && task.spec_quality.questions.length) {
    lines.push(`  Ask:`);
    for (const q of task.spec_quality.questions) lines.push(`   - ${q}`);
  }
  lines.push(`Estimate: ${task.estimate.hours}h human (${task.estimate.basis}${task.estimate.story_points ? `, ${task.estimate.story_points} SP` : ""})  Budget: $${task.budget_usd.toFixed(2)} API-equivalent`);
  return lines.join("\n");
}
var CriterionSchema, TaskSchema, HOURS_PER_STORY_POINT, BUDGET_FRACTION, BUDGET_FLOOR_USD, INTAKE_SCHEMA, INTAKE_SYSTEM;
var init_intake = __esm({
  "src/task/intake.ts"() {
    "use strict";
    init_zod();
    init_paths();
    init_fetchers();
    init_events();
    init_checks();
    CriterionSchema = external_exports.object({
      id: external_exports.string(),
      text: external_exports.string(),
      source: external_exports.enum(["explicit", "inferred"]),
      kind: external_exports.enum(["mechanical", "judgment"]).default("judgment"),
      check: CheckSpecSchema.optional()
    });
    TaskSchema = external_exports.object({
      session: external_exports.string(),
      cwd: external_exports.string().optional(),
      created_at: external_exports.string(),
      frozen: external_exports.literal(true),
      source: external_exports.object({
        kind: external_exports.enum(["github", "jira", "linear", "file", "text"]),
        ref: external_exports.string(),
        url: external_exports.string().optional(),
        owner: external_exports.string().optional(),
        repo: external_exports.string().optional(),
        number: external_exports.number().optional(),
        key: external_exports.string().optional(),
        is_pr: external_exports.boolean().optional()
      }),
      title: external_exports.string(),
      body_excerpt: external_exports.string(),
      labels: external_exports.array(external_exports.string()),
      fetch_error: external_exports.string().optional(),
      criteria: external_exports.array(CriterionSchema),
      spec_quality: external_exports.object({ score: external_exports.number().min(0).max(10), missing: external_exports.array(external_exports.string()), questions: external_exports.array(external_exports.string()) }),
      needs_clarification: external_exports.boolean(),
      estimate: external_exports.object({ hours: external_exports.number().nonnegative(), basis: external_exports.enum(["story_points", "llm", "default"]), story_points: external_exports.number().optional() }),
      budget_usd: external_exports.number().nonnegative(),
      hourly_rate: external_exports.number(),
      tally_cost_usd: external_exports.number(),
      model: external_exports.string(),
      cache_key: external_exports.string().optional(),
      cached: external_exports.boolean().optional(),
      historical: external_exports.object({ ticket_as_of: external_exports.enum(["current", "session_start"]), note: external_exports.string() }).optional(),
      /* no tracker link: criteria were inferred from the prompts, branch name and commits; unconfirmed until the user says so */
      inferred: external_exports.boolean().optional(),
      confirmed: external_exports.boolean().optional(),
      context: external_exports.object({ branch: external_exports.string().optional(), commits: external_exports.array(external_exports.string()).optional() }).optional()
    });
    HOURS_PER_STORY_POINT = 4;
    BUDGET_FRACTION = 0.25;
    BUDGET_FLOOR_USD = 2;
    INTAKE_SCHEMA = {
      type: "object",
      properties: {
        title: { type: "string" },
        criteria: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, source: { type: "string", enum: ["explicit", "inferred"] }, check: CHECK_JSON_SCHEMA }, required: ["text", "source", "check"] }
        },
        spec_quality: {
          type: "object",
          properties: { score: { type: "number" }, missing: { type: "array", items: { type: "string" } }, questions: { type: "array", items: { type: "string" } } },
          required: ["score", "missing", "questions"]
        },
        estimate_hours: { type: "number" },
        rationale: { type: "string" }
      },
      required: ["title", "criteria", "spec_quality", "estimate_hours", "rationale"]
    };
    INTAKE_SYSTEM = `You turn a software task description into a frozen checklist of acceptance criteria for a later, skeptical audit.
Rules:
- Each criterion must be a single verifiable statement about observable behaviour, code, tests, or docs. No vague "works well".
- Mark a criterion "explicit" when the ticket states it (including checkbox lists), "inferred" when a competent engineer would assume it (tests for new behaviour, no regressions). Keep inferred criteria to at most 3.
- spec_quality.score is 0-10: 10 = every criterion is testable and scoped; 5 = usable but missing key details; below 5 = the engineer should ask questions before starting. List what is missing and the exact questions to ask.
- estimate_hours is the human-hours a competent engineer would need without AI assistance, including tests. Be realistic, not optimistic.
- For each criterion give a "check": a mechanical test that decides it with no judgment, or kind "none" when only a reader can decide.
  Kinds: "tests_pass" (the project's test suite passes), "file_exists" {path}, "file_changed" {path} (the file appears in the diff), "file_contains" {path, pattern (regex)}, "diff_contains" {pattern (regex)}, "command" {command, expect_exit} (only the repo's own npm/make/test scripts), "pr" {state: pushed|opened|merged}.
  Prefer a check whenever the ticket names a file, a command, a test, or a PR outcome. Use "none" for behaviour that needs reading the code (correctness, edge cases, "works", "unchanged").
Return only the JSON object.`;
  }
});

// src/session.ts
import fs11 from "node:fs";
import path10 from "node:path";
function activeSessions() {
  const a = readJson(activeFile(), {});
  return Object.entries(a).map(([id, v]) => ({ id, cwd: v.cwd, transcript_path: v.transcript_path, model: v.model, last_seen: v.last_seen })).sort((x, y) => (y.last_seen ?? "").localeCompare(x.last_seen ?? ""));
}
function resolveSession(explicit, cwd) {
  if (explicit) return explicit;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  const active = activeSessions();
  const norm4 = (p) => (p ?? "").replace(/\\/g, "/").toLowerCase();
  const byCwd = cwd ? active.find((s) => norm4(s.cwd) === norm4(cwd)) : void 0;
  if (byCwd) return byCwd.id;
  if (active[0]) return active[0].id;
  const all = listSessions();
  if (cwd) {
    for (const id of all) {
      const ev = readEvents(id);
      if (ev.some((e) => norm4(e.cwd) === norm4(cwd))) return id;
    }
  }
  return all[0];
}
function transcriptPathFor(session) {
  const events = readEvents(session);
  for (const e of events) {
    const p = e.data.transcript_path;
    if (typeof p === "string" && fs11.existsSync(p)) return p;
  }
  const active = activeSessions().find((s) => s.id === session);
  if (active?.transcript_path && fs11.existsSync(active.transcript_path)) return active.transcript_path;
  const cwd = events.find((e) => e.cwd)?.cwd;
  if (cwd) {
    const candidate = path10.join(projectTranscriptsDir(cwd), `${session}.jsonl`);
    if (fs11.existsSync(candidate)) return candidate;
  }
  const local = path10.join(sessionDir(session), "transcript.jsonl");
  if (fs11.existsSync(local)) return local;
  return void 0;
}
function sessionCwd(session) {
  const events = readEvents(session);
  return events.find((e) => e.cwd)?.cwd ?? activeSessions().find((s) => s.id === session)?.cwd;
}
var init_session = __esm({
  "src/session.ts"() {
    "use strict";
    init_paths();
    init_events();
  }
});

// src/experiment/experiment.ts
import fs12 from "node:fs";
import path11 from "node:path";
function loadExperiments() {
  return readJson(experimentsFile(), { experiments: [] });
}
function saveExperiments(db) {
  writeJson(experimentsFile(), db);
}
function activeExperiment(cwd) {
  const key = repoKey(cwd);
  return loadExperiments().experiments.find((e) => e.repo === key && !e.stopped_at && e.assignments.length < e.tasks_total);
}
function startExperiment(cwd, kind, name, tasks) {
  const db = loadExperiments();
  const key = repoKey(cwd);
  for (const e of db.experiments) if (e.repo === key && !e.stopped_at) e.stopped_at = (/* @__PURE__ */ new Date()).toISOString();
  const exp = { id: `${kind}-${name}-${Date.now().toString(36)}`, repo: key, kind, name, tasks_total: tasks, started_at: (/* @__PURE__ */ new Date()).toISOString(), assignments: [], next_arm: "off" };
  db.experiments.push(exp);
  saveExperiments(db);
  applyArm(cwd, exp);
  return exp;
}
function stopExperiment(cwd) {
  const db = loadExperiments();
  const key = repoKey(cwd);
  const exp = db.experiments.find((e) => e.repo === key && !e.stopped_at);
  if (!exp) return void 0;
  exp.stopped_at = (/* @__PURE__ */ new Date()).toISOString();
  saveExperiments(db);
  restoreExperimentConfig(cwd);
  return exp;
}
function localSettingsPath(cwd) {
  return path11.join(cwd, ".claude", "settings.local.json");
}
function backupPath(exp) {
  return path11.join(tallyHome(), "backups", `experiment-${exp.id}-settings.local.json`);
}
function applyArm(cwd, exp) {
  if (exp.applied) return;
  const file = localSettingsPath(cwd);
  const hadFile = fs12.existsSync(file);
  const bk = backupPath(exp);
  ensureDir(path11.dirname(bk));
  if (hadFile) fs12.copyFileSync(file, bk);
  else if (fs12.existsSync(bk)) fs12.unlinkSync(bk);
  const settings = hadFile ? JSON.parse(fs12.readFileSync(file, "utf8")) : {};
  if (exp.next_arm === "off") {
    if (exp.kind === "skill") {
      const perms = settings.permissions ??= {};
      const deny = perms.deny ??= [];
      const rule = `Skill(${exp.name})`;
      if (!deny.includes(rule)) deny.push(rule);
    } else {
      for (const key of ["disabledMcpjsonServers", "disabledMcpServers"]) {
        const arr = settings[key] ??= [];
        if (!arr.includes(exp.name)) arr.push(exp.name);
      }
    }
    settings._tally_experiment = { id: exp.id, arm: "off", note: "temporary; restored by tally at session end" };
  } else {
    settings._tally_experiment = { id: exp.id, arm: "on", note: "temporary marker; restored by tally at session end" };
  }
  ensureDir(path11.dirname(file));
  fs12.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  const db = loadExperiments();
  const target = db.experiments.find((e) => e.id === exp.id);
  if (target) {
    target.applied = { arm: exp.next_arm, settings_file: file, backup_file: bk, had_file: hadFile };
    saveExperiments(db);
  }
}
function recordAssignment(cwd, session) {
  const db = loadExperiments();
  const exp = db.experiments.find((e) => e.repo === repoKey(cwd) && !e.stopped_at && e.assignments.length < e.tasks_total);
  if (!exp || !exp.applied) return void 0;
  if (exp.applied.session && exp.applied.session !== session) return exp.applied.arm;
  if (!exp.applied.session) {
    exp.applied.session = session;
    exp.assignments.push({ session, arm: exp.applied.arm, started_at: (/* @__PURE__ */ new Date()).toISOString(), applied: true });
    saveExperiments(db);
  }
  return exp.applied.arm;
}
function restoreExperimentConfig(cwd, session) {
  const db = loadExperiments();
  const key = repoKey(cwd);
  let restored = false;
  for (const exp of db.experiments) {
    if (exp.repo !== key || !exp.applied) continue;
    if (session && exp.applied.session && exp.applied.session !== session) continue;
    const { settings_file, backup_file, had_file } = exp.applied;
    if (had_file && fs12.existsSync(backup_file)) fs12.copyFileSync(backup_file, settings_file);
    else if (!had_file && fs12.existsSync(settings_file)) fs12.unlinkSync(settings_file);
    if (fs12.existsSync(backup_file)) fs12.unlinkSync(backup_file);
    exp.next_arm = exp.applied.arm === "on" ? "off" : "on";
    delete exp.applied;
    restored = true;
  }
  if (restored) saveExperiments(db);
  return restored;
}
function prepareNextArm(cwd) {
  const exp = activeExperiment(cwd);
  if (exp && !exp.applied) applyArm(cwd, exp);
}
var init_experiment = __esm({
  "src/experiment/experiment.ts"() {
    "use strict";
    init_paths();
  }
});

// src/commands/task.ts
var task_exports = {};
__export(task_exports, {
  run: () => run2
});
async function run2(args) {
  const cfg = loadConfig();
  const cwd = flag(args, "cwd") || process.cwd();
  const session = resolveSession(flag(args, "session"), cwd);
  if (!session) {
    process.stderr.write("No active Tally session found. Start Claude Code with Tally hooks installed, or pass --session <id>.\n");
    return 1;
  }
  if (has(args, "confirm")) {
    const t = confirmTask(session);
    process.stdout.write(t ? `Confirmed: ${t.title} (${t.criteria.length} criteria)
` : "No task to confirm.\n");
    return t ? 0 : 1;
  }
  const editText = flag(args, "edit");
  const linkRef = flag(args, "link");
  if (editText || linkRef) {
    const r = await intake({ session, cwd, ref: linkRef, text: editText, cfg, llm: makeLlm({ session }), force: true });
    if (editText) confirmTask(session);
    process.stdout.write(renderTask(loadTask(session) ?? r.task) + "\n");
    return;
  }
  const text = flag(args, "text");
  const ref = args._.join(" ").trim();
  if (!ref && !text) {
    const existing = loadTask(session);
    if (existing) {
      process.stdout.write(renderTask(existing) + "\n");
      return;
    }
    process.stderr.write("Usage: tally task <url|path|text>\n");
    return 1;
  }
  recordAssignment(cwd, session);
  const llm = makeLlm({ session });
  const { task, created } = await intake({ session, cwd, ref: ref || void 0, text, cfg, llm, force: has(args, "force"), noCache: has(args, "no-cache") });
  if (!created && !has(args, "auto")) process.stdout.write("(task already frozen for this session; use --force to replace)\n");
  if (!has(args, "auto") || has(args, "plain")) process.stdout.write(renderTask(task) + "\n");
}
var init_task = __esm({
  "src/commands/task.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_client();
    init_intake();
    init_session();
    init_experiment();
  }
});

// src/transcript/parse.ts
import fs13 from "node:fs";
import path12 from "node:path";
function isKnownFormatVersion(version) {
  if (!version) return false;
  const mm = version.split(".").slice(0, 2).join(".");
  return KNOWN_FORMAT_VERSIONS.includes(mm);
}
function isTestCommand(cmd) {
  return TEST_RE.test(cmd);
}
function isLintCommand(cmd) {
  return LINT_RE.test(cmd);
}
function isShipCommand(cmd) {
  return SHIP_RE.test(cmd);
}
function readTranscriptLines(file) {
  if (!fs13.existsSync(file)) return { lines: [], unparseable: 0, total: 0 };
  const out = [];
  let unparseable = 0;
  let total = 0;
  for (const line of fs13.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    total += 1;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        unparseable += 1;
        continue;
      }
      out.push(parsed);
    } catch {
      unparseable += 1;
    }
  }
  return { lines: out, unparseable, total };
}
function parseTranscriptFile(file, pricing = loadPricing()) {
  const main2 = readTranscriptLines(file);
  const lines = main2.lines;
  let unparseable = main2.unparseable;
  let total = main2.total;
  const dir = file.replace(/\.jsonl$/, "");
  const subDir = path12.join(dir, "subagents");
  if (fs13.existsSync(subDir)) {
    for (const f of fs13.readdirSync(subDir).filter((x) => x.endsWith(".jsonl"))) {
      const agent = f.replace(/\.jsonl$/, "");
      const sub = readTranscriptLines(path12.join(subDir, f));
      unparseable += sub.unparseable;
      total += sub.total;
      for (const l of sub.lines) {
        l.isSidechain = true;
        l.agentId ??= agent;
        lines.push(l);
      }
    }
  }
  lines.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  return parseTranscript(lines, pricing, { unparseable, total });
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && c.type === "text") return String(c.text ?? "");
      return "";
    }).join("");
  }
  return "";
}
function parseTranscript(lines, pricing = loadPricing(), counts = { unparseable: 0, total: lines.length }) {
  const unknownTypes = /* @__PURE__ */ new Set();
  const t = {
    internal: false,
    format: { known: false, total_lines: counts.total, unparseable_lines: counts.unparseable, unknown_types: [] },
    cost_confidence: "full",
    sessionId: "",
    models: [],
    prompts: [],
    messages: [],
    toolCalls: [],
    compactions: [],
    usage: emptyUsage(),
    cost: 0,
    byModel: {},
    byAgent: {},
    byPhase: {
      explore: { usage: emptyUsage(), cost: 0, messages: 0 },
      build: { usage: emptyUsage(), cost: 0, messages: 0 },
      verify: { usage: emptyUsage(), cost: 0, messages: 0 },
      ship: { usage: emptyUsage(), cost: 0, messages: 0 }
    },
    firstTurnContextTokens: 0,
    contextTokensNow: 0,
    finalAssistantText: "",
    skills: [],
    mcpCalls: []
  };
  const seenMsg = /* @__PURE__ */ new Map();
  const callById = /* @__PURE__ */ new Map();
  let turn = 0;
  let phase = "explore";
  let pendingCompaction = false;
  let lastAssistantText = "";
  let lastMainMessage;
  for (const l of lines) {
    if (!t.sessionId && l.sessionId) t.sessionId = l.sessionId;
    if (!t.cwd && l.cwd) t.cwd = l.cwd;
    if (!t.version && l.version) t.version = l.version;
    if (!t.entrypoint && l.entrypoint) t.entrypoint = l.entrypoint;
    if (l.type && !KNOWN_LINE_TYPES.has(l.type)) unknownTypes.add(l.type);
    if (!t.gitBranch && l.gitBranch) t.gitBranch = l.gitBranch;
    if (l.timestamp) {
      if (!t.startedAt || l.timestamp < t.startedAt) t.startedAt = l.timestamp;
      if (!t.endedAt || l.timestamp > t.endedAt) t.endedAt = l.timestamp;
    }
    const agent = l.isSidechain ? l.agentId ?? "subagent" : "main";
    if (l.isCompactSummary || l.type === "system" && l.subtype === "compact_boundary") {
      t.compactions.push({ ts: l.timestamp ?? "", turn });
      pendingCompaction = true;
      continue;
    }
    if (l.type === "user" && l.message) {
      const content = l.message.content;
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      if (results.length) {
        for (const r of results) {
          const call = callById.get(String(r.tool_use_id));
          if (!call) continue;
          const text2 = textOf(r.content);
          call.result = { isError: !!r.is_error, chars: text2.length, text: text2.slice(0, 4e3) };
        }
        continue;
      }
      if (l.isSidechain) continue;
      const text = textOf(content).trim();
      if (!text || text.startsWith("<command-name>") || text.startsWith("<local-command")) continue;
      turn += 1;
      t.prompts.push({ ts: l.timestamp ?? "", text, turn });
      continue;
    }
    if (l.type === "assistant" && l.message) {
      const m = l.message;
      const id = m.id ?? l.uuid ?? String(Math.random());
      const content = Array.isArray(m.content) ? m.content : [];
      const model = m.model ?? "unknown";
      let msg = seenMsg.get(id);
      if (!msg) {
        const u = m.usage ?? {};
        const usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_write: u.cache_creation_input_tokens ?? 0,
          cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0
        };
        msg = {
          id,
          ts: l.timestamp ?? "",
          model,
          usage,
          cost: costOf(usage, model, pricing),
          agent,
          turn,
          phase,
          text: "",
          toolUseIds: [],
          afterCompaction: pendingCompaction && agent === "main"
        };
        if (agent === "main" && pendingCompaction) pendingCompaction = false;
        seenMsg.set(id, msg);
        t.messages.push(msg);
        if (!t.models.includes(model)) t.models.push(model);
        t.usage = addUsage(t.usage, usage);
        t.cost += msg.cost;
        const bm = t.byModel[canonicalModel(model, pricing)] ??= { usage: emptyUsage(), cost: 0, messages: 0 };
        bm.usage = addUsage(bm.usage, usage);
        bm.cost += msg.cost;
        bm.messages += 1;
        const ba = t.byAgent[agent] ??= { usage: emptyUsage(), cost: 0, messages: 0, toolCalls: 0 };
        ba.usage = addUsage(ba.usage, usage);
        ba.cost += msg.cost;
        ba.messages += 1;
        const bp = t.byPhase[phase];
        bp.usage = addUsage(bp.usage, usage);
        bp.cost += msg.cost;
        bp.messages += 1;
        if (agent === "main") {
          const ctx = usage.input + usage.cache_read + usage.cache_write;
          if (!t.firstTurnContextTokens) t.firstTurnContextTokens = ctx;
          lastMainMessage = msg;
        }
      }
      for (const b of content) {
        if (b.type === "text") {
          const txt = String(b.text ?? "");
          msg.text += txt;
          if (agent === "main" && txt.trim()) lastAssistantText = txt;
        } else if (b.type === "tool_use") {
          const name = String(b.name ?? "");
          const input = b.input ?? {};
          const cmd = typeof input.command === "string" ? input.command : "";
          if (agent === "main") {
            if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
              if (phase === "explore") phase = "build";
            } else if (name === "Bash" && cmd) {
              if (isShipCommand(cmd)) phase = "ship";
              else if ((isTestCommand(cmd) || isLintCommand(cmd)) && phase === "build") phase = "verify";
            }
          }
          const call = {
            id: String(b.id ?? ""),
            name,
            input,
            ts: l.timestamp ?? "",
            agent,
            messageId: id,
            turn,
            phase,
            result: void 0
          };
          msg.toolUseIds.push(call.id);
          callById.set(call.id, call);
          t.toolCalls.push(call);
          const ba = t.byAgent[agent] ??= { usage: emptyUsage(), cost: 0, messages: 0, toolCalls: 0 };
          ba.toolCalls += 1;
          if (name === "Skill") {
            t.skills.push({ name: String(input.skill ?? input.name ?? ""), ts: call.ts, turn, messageId: id });
          } else if (name.startsWith("mcp__")) {
            const parts = name.split("__");
            t.mcpCalls.push({ server: parts[1] ?? "", tool: parts.slice(2).join("__"), ts: call.ts, turn, messageId: id, isError: false });
          }
        }
      }
    }
  }
  for (const mc of t.mcpCalls) {
    const call = t.toolCalls.find((c) => c.messageId === mc.messageId && c.name === `mcp__${mc.server}__${mc.tool}`);
    if (call?.result?.isError) mc.isError = true;
  }
  if (lastMainMessage) {
    t.contextTokensNow = lastMainMessage.usage.input + lastMainMessage.usage.cache_read + lastMainMessage.usage.cache_write;
  }
  t.finalAssistantText = lastAssistantText;
  t.internal = isInternalCwd(t.cwd) || t.entrypoint === "tally";
  t.format.version = t.version;
  t.format.known = isKnownFormatVersion(t.version);
  t.format.unknown_types = [...unknownTypes].sort();
  const assistantWithoutUsage = lines.filter((l) => l.type === "assistant" && l.message && !l.message.usage).length;
  t.cost_confidence = counts.unparseable > 0 || !t.format.known || assistantWithoutUsage > 0 ? "partial" : "full";
  return t;
}
var KNOWN_FORMAT_VERSIONS, KNOWN_LINE_TYPES, TEST_RE, LINT_RE, SHIP_RE;
var init_parse = __esm({
  "src/transcript/parse.ts"() {
    "use strict";
    init_pricing();
    init_paths();
    KNOWN_FORMAT_VERSIONS = ["2.1"];
    KNOWN_LINE_TYPES = /* @__PURE__ */ new Set(["assistant", "user", "system", "attachment", "permission-mode", "mode", "summary", "progress", "queue-operation", "file-history-snapshot", "file-history-delta", "atis-latch", "custom-title", "last-prompt", "ai-title", "pr-link", "agent-name"]);
    TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|pytest|py\.test|go test|cargo test|mocha|rspec|phpunit|mvn test|gradle test|dotnet test|make test)\b/;
    LINT_RE = /\b(eslint|ruff|flake8|pylint|tsc\b|prettier --check|golangci-lint|cargo clippy|mypy)\b/;
    SHIP_RE = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bnpm\s+publish\b|\bgit\s+merge\b.*\bmain\b|\bcargo\s+publish\b|\btwine\s+upload\b/;
  }
});

// src/cost/waste.ts
function msgCost(t, messageId) {
  return t.messages.find((m) => m.id === messageId)?.cost ?? 0;
}
function tokensOf(chars) {
  return Math.round(chars / 4);
}
function normalizeCommand(cmd) {
  return cmd.replace(/\s+/g, " ").trim();
}
function findFailedLoops(calls) {
  const out = [];
  const byCmd = /* @__PURE__ */ new Map();
  for (const c of calls) {
    if (c.agent !== "main" || c.name !== "Bash") continue;
    const cmd = typeof c.input.command === "string" ? normalizeCommand(c.input.command) : "";
    if (!cmd || !c.result?.isError) continue;
    const arr = byCmd.get(cmd) ?? [];
    arr.push(c.id);
    byCmd.set(cmd, arr);
  }
  for (const [command, ids] of byCmd) if (ids.length >= 2) out.push({ command, repeats: ids.length, callIds: ids });
  return out.sort((a, b) => b.repeats - a.repeats);
}
function findRepeatedReads(calls, min = 3) {
  const byFile = /* @__PURE__ */ new Map();
  for (const c of calls) {
    if (c.name !== "Read" || c.agent !== "main") continue;
    const f = typeof c.input.file_path === "string" ? c.input.file_path.replace(/\\/g, "/") : "";
    if (!f) continue;
    const arr = byFile.get(f) ?? [];
    arr.push(c.id);
    byFile.set(f, arr);
  }
  const out = [];
  for (const [file, ids] of byFile) if (ids.length >= min) out.push({ file, reads: ids.length, callIds: ids });
  return out.sort((a, b) => b.reads - a.reads);
}
function computeWaste(t, opts) {
  const pricing = opts.pricing ?? loadPricing();
  const mainModel = t.messages.find((m) => m.agent === "main")?.model;
  const price = priceFor(mainModel, pricing);
  const items = [];
  const failed_loops = findFailedLoops(t.toolCalls).map((l) => {
    const usd = l.callIds.slice(1).reduce((s, id) => {
      const call = t.toolCalls.find((c) => c.id === id);
      return s + (call ? msgCost(t, call.messageId) + tokensOf(call.result?.chars ?? 0) * price.input / 1e6 : 0);
    }, 0);
    return { command: l.command, repeats: l.repeats, usd };
  });
  const loopUsd = failed_loops.reduce((s, x) => s + x.usd, 0);
  items.push({ kind: "failed_loop", usd: loopUsd, count: failed_loops.length, detail: failed_loops.map((l) => `${l.command} \xD7${l.repeats}`).join("; ") });
  const repeated_reads = findRepeatedReads(t.toolCalls).map((r) => {
    const usd = r.callIds.slice(1).reduce((s, id) => {
      const call = t.toolCalls.find((c) => c.id === id);
      return s + (call ? msgCost(t, call.messageId) + tokensOf(call.result?.chars ?? 0) * price.input / 1e6 : 0);
    }, 0);
    return { file: r.file, reads: r.reads, usd };
  });
  const readUsd = repeated_reads.reduce((s, x) => s + x.usd, 0);
  items.push({ kind: "repeated_read", usd: readUsd, count: repeated_reads.length, detail: repeated_reads.map((r) => `${r.file} \xD7${r.reads}`).join("; ") });
  const overhead = Math.max(0, t.firstTurnContextTokens - opts.baselineTokens);
  const mainMsgs = t.messages.filter((m) => m.agent === "main").length;
  const deadUsd = (overhead * price.cache_write_1h + overhead * price.cache_read * Math.max(0, mainMsgs - 1)) / 1e6;
  items.push({
    kind: "dead_weight",
    usd: deadUsd,
    count: overhead > 0 ? 1 : 0,
    detail: `first turn loaded ${t.firstTurnContextTokens} tokens (${overhead} above the ${opts.baselineTokens} baseline), re-read on ${mainMsgs} calls`
  });
  const recache = t.messages.filter((m) => m.afterCompaction).reduce((s, m) => s + m.usage.cache_write, 0);
  const churnUsd = recache * price.cache_write_1h / 1e6;
  items.push({ kind: "compaction_churn", usd: churnUsd, count: t.compactions.length, detail: `${t.compactions.length} compaction(s), ${recache} tokens re-cached` });
  return {
    items,
    total_usd: items.reduce((s, i) => s + i.usd, 0),
    failed_loops,
    repeated_reads,
    dead_weight: { first_turn_tokens: t.firstTurnContextTokens, baseline_tokens: opts.baselineTokens, overhead_tokens: overhead, usd: deadUsd },
    compaction_churn: { compactions: t.compactions.length, recache_tokens: recache, usd: churnUsd }
  };
}
var init_waste = __esm({
  "src/cost/waste.ts"() {
    "use strict";
    init_pricing();
  }
});

// src/cost/attribution.ts
function attribute(t) {
  const rows = /* @__PURE__ */ new Map();
  const add = (kind, name, messageId, turn, isError) => {
    const key = `${kind}:${name}`;
    const row = rows.get(key) ?? { kind, name, invocations: 0, errors: 0, tokens: 0, usd: 0, turns: [], touched_met_criteria: null };
    row.invocations += 1;
    if (isError) row.errors += 1;
    const msg = t.messages.find((m) => m.id === messageId);
    const call = t.toolCalls.find((c) => c.messageId === messageId && (kind === "skill" ? c.name === "Skill" : c.name === `mcp__${name.replace(":", "__")}`));
    const resultTokens = Math.round((call?.result?.chars ?? 0) / 4);
    row.tokens += (msg?.usage.output ?? 0) + resultTokens;
    row.usd += msg?.cost ?? 0;
    if (!row.turns.includes(turn)) row.turns.push(turn);
    rows.set(key, row);
  };
  for (const s of t.skills) add("skill", s.name, s.messageId, s.turn, false);
  for (const m of t.mcpCalls) add("mcp", `${m.server}:${m.tool}`, m.messageId, m.turn, m.isError);
  return [...rows.values()].sort((a, b) => b.usd - a.usd);
}
function markTouched(rows, t, metFiles) {
  const norm4 = (f) => f.replace(/\\/g, "/").toLowerCase();
  const met = new Set(metFiles.map(norm4));
  const editTurns = /* @__PURE__ */ new Set();
  for (const c of t.toolCalls) {
    if (!["Edit", "Write", "MultiEdit"].includes(c.name)) continue;
    const f = typeof c.input.file_path === "string" ? norm4(c.input.file_path) : "";
    if ([...met].some((m) => f.endsWith(m) || m.endsWith(f))) editTurns.add(c.turn);
  }
  return rows.map((r) => ({ ...r, touched_met_criteria: met.size === 0 ? null : r.turns.some((turn) => editTurns.has(turn)) }));
}
var init_attribution = __esm({
  "src/cost/attribution.ts"() {
    "use strict";
  }
});

// src/redact.ts
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
var PATTERNS;
var init_redact = __esm({
  "src/redact.ts"() {
    "use strict";
    PATTERNS = [
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
  }
});

// src/judge/reconstruct.ts
function norm2(p) {
  return p.replace(/\\/g, "/");
}
function rel(file, cwd) {
  const f = norm2(file);
  if (!cwd) return f;
  const c = norm2(cwd).replace(/\/+$/, "") + "/";
  return f.toLowerCase().startsWith(c.toLowerCase()) ? f.slice(c.length) : f;
}
function bashTarget(cmd) {
  const m = /(?:>{1,2}|tee(?:\s+-a)?|sed\s+-i(?:\s+'[^']*'|\s+"[^"]*"|\s+\S+)?|touch|mv\s+\S+|cp\s+\S+|rm\s+(?:-\w+\s+)?)\s*([^\s&|;'"]+)/.exec(cmd);
  return m?.[1];
}
function reconstructChanges(t, gitFiles, cwd) {
  const changes = [];
  const bash_edits = [];
  const gitSet = new Set(gitFiles.map((f) => norm2(f).toLowerCase()));
  const verify = (file) => {
    const r = rel(file, cwd).toLowerCase();
    return [...gitSet].some((g) => g === r || g.endsWith("/" + r) || r.endsWith("/" + g)) ? "verified-against-disk" : "reconstructed";
  };
  for (const c of t.toolCalls) {
    if (c.agent !== "main" || c.result?.isError) continue;
    const file = typeof c.input.file_path === "string" ? c.input.file_path : void 0;
    if (c.name === "Write" && file) {
      const content = String(c.input.content ?? "");
      const lines = content.split("\n");
      changes.push({ file: rel(file, cwd), kind: "write", ts: c.ts, detail: `+++ ${rel(file, cwd)} (written, ${lines.length} lines)
${lines.slice(0, 40).map((l) => "+" + l).join("\n")}${lines.length > 40 ? `
+\u2026 ${lines.length - 40} more lines` : ""}`, verification: verify(file) });
    } else if ((c.name === "Edit" || c.name === "MultiEdit") && file) {
      const edits = c.name === "MultiEdit" && Array.isArray(c.input.edits) ? c.input.edits : [{ old_string: c.input.old_string, new_string: c.input.new_string }];
      for (const e of edits) {
        const oldS = String(e.old_string ?? "");
        const newS = String(e.new_string ?? "");
        changes.push({ file: rel(file, cwd), kind: "edit", ts: c.ts, detail: `@@ ${rel(file, cwd)} @@
${oldS.split("\n").slice(0, 20).map((l) => "-" + l).join("\n")}
${newS.split("\n").slice(0, 20).map((l) => "+" + l).join("\n")}`, verification: verify(file) });
      }
    } else if (c.name === "Bash") {
      const cmd = typeof c.input.command === "string" ? c.input.command : "";
      if (cmd && BASH_WRITE_RE.test(cmd) && !/^\s*git\s+(status|diff|log|add|commit|push)/.test(cmd)) {
        const target = bashTarget(cmd);
        bash_edits.push({ ts: c.ts, command: cmd.slice(0, 200), file: target });
        if (target) changes.push({ file: rel(target, cwd), kind: "bash", ts: c.ts, detail: `# shell-made change to ${rel(target, cwd)}: ${cmd.slice(0, 160)}`, verification: verify(target) });
      }
    }
  }
  const verified = [...new Set(changes.filter((c) => c.verification === "verified-against-disk").map((c) => c.file))].sort();
  const reconstructed = [...new Set(changes.filter((c) => c.verification === "reconstructed").map((c) => c.file))].sort();
  const diff_text = changes.map((c) => `${c.detail}   [${c.verification}]`).join("\n\n");
  const source = gitFiles.length && reconstructed.length ? "mixed" : gitFiles.length ? "git" : changes.length ? "reconstructed" : "none";
  return { changes, verified, reconstructed, bash_edits, diff_text: diff_text.length > 6e4 ? diff_text.slice(0, 6e4) + "\n\u2026[reconstruction truncated]" : diff_text, source };
}
var BASH_WRITE_RE;
var init_reconstruct = __esm({
  "src/judge/reconstruct.ts"() {
    "use strict";
    BASH_WRITE_RE = /\b(sed\s+-i|tee\b|>{1,2}\s*[^\s&|;]+|mv\s+|cp\s+|rm\s+(-\w+\s+)?[^\s]+|git\s+apply|patch\s+|touch\s+|printf .*>|echo .*>|cat .*>|npx?\s+prettier\s+--write|eslint\s+--fix|black\b|gofmt\s+-w|rustfmt)/;
  }
});

// src/judge/evidence.ts
import { spawnSync as spawnSync3 } from "node:child_process";
function collectGit(cwd, baseHead, exec = gitExec, maxDiffChars = 6e4) {
  const out = { base_head: baseHead, files_changed: [], diff_stat: "", insertions: 0, deletions: 0, diff_excerpt: "" };
  const head = exec("git", ["rev-parse", "HEAD"], cwd);
  if (!head.ok) {
    out.error = "not a git repository or git unavailable";
    return out;
  }
  out.current_head = head.stdout.trim();
  const br = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (br.ok) out.branch = br.stdout.trim();
  const base = baseHead && exec("git", ["cat-file", "-e", baseHead], cwd).ok ? baseHead : void 0;
  const range = base ? [base] : ["HEAD"];
  const stat = exec("git", ["diff", "--stat", ...range], cwd);
  out.diff_stat = stat.stdout.trim();
  const names = exec("git", ["diff", "--name-only", ...range], cwd);
  const files = new Set(names.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  const untracked = exec("git", ["ls-files", "--others", "--exclude-standard"], cwd);
  for (const f of untracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) files.add(f);
  out.files_changed = [...files].sort();
  const numstat = exec("git", ["diff", "--numstat", ...range], cwd);
  for (const line of numstat.stdout.split("\n")) {
    const [a, d] = line.split("	");
    out.insertions += Number(a) || 0;
    out.deletions += Number(d) || 0;
  }
  const diff = exec("git", ["diff", ...range, "--", ".", ":(exclude)package-lock.json", ":(exclude)*.lock", ":(exclude)dist/"], cwd);
  let text = diff.stdout;
  for (const f of untracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20)) {
    const show = exec("git", ["diff", "--no-index", "--", "/dev/null", f], cwd);
    const body = show.stdout || show.stderr;
    if (body) text += `
${body}`;
  }
  out.diff_excerpt = redact(text.length > maxDiffChars ? text.slice(0, maxDiffChars) + `
\u2026[diff truncated, ${text.length} chars total]` : text);
  if (!base && baseHead) out.error = `session-start HEAD ${baseHead.slice(0, 8)} not found; diff is against current HEAD`;
  return out;
}
function collectEvidence(opts) {
  const { transcript: t, events } = opts;
  const startEv = events.find((e) => e.type === "session_start");
  const baseHead = typeof startEv?.data.git_head === "string" ? startEv.data.git_head : void 0;
  const git3 = opts.skipGit ? { base_head: baseHead, files_changed: [], diff_stat: "", insertions: 0, deletions: 0, diff_excerpt: "", error: "no git tree for this session; changes reconstructed from the transcript" } : collectGit(opts.cwd, baseHead, opts.exec);
  const command_runs = [];
  for (const c of t.toolCalls) {
    if (c.name !== "Bash" || c.agent !== "main") continue;
    const cmd = typeof c.input.command === "string" ? c.input.command : "";
    const kind = isTestCommand(cmd) ? "test" : isLintCommand(cmd) ? "lint" : null;
    if (!kind) continue;
    const tail = c.result?.text ?? "";
    command_runs.push({ command: redact(cmd).slice(0, 200), kind, passed: !c.result?.isError, ts: c.ts, output_tail: redact(tail.length > 600 ? "\u2026" + tail.slice(-600) : tail) });
  }
  const ship_events = events.filter((e) => e.type === "ship").map((e) => ({ kind: String(e.data.kind ?? "push"), command: String(e.data.command ?? ""), url: typeof e.data.url === "string" ? e.data.url : void 0, ts: e.ts }));
  const mainTexts = t.messages.filter((m) => m.agent === "main" && m.text.trim()).map((m) => m.text.trim());
  const final_messages = mainTexts.slice(-3).map((s) => redact(s.length > 2500 ? s.slice(0, 2500) + "\u2026" : s));
  const prompts = t.prompts.map((p) => redact(p.text.length > 1200 ? p.text.slice(0, 1200) + "\u2026" : p.text));
  const edited = /* @__PURE__ */ new Set();
  for (const c of t.toolCalls) {
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(c.name) && typeof c.input.file_path === "string") edited.add(c.input.file_path.replace(/\\/g, "/"));
  }
  const reconstruction = reconstructChanges(t, git3.files_changed, opts.cwd);
  return { git: git3, command_runs, ship_events, final_messages, prompts, tool_call_count: t.toolCalls.length, edited_files: [...edited].sort(), reconstruction };
}
var gitExec;
var init_evidence = __esm({
  "src/judge/evidence.ts"() {
    "use strict";
    init_parse();
    init_redact();
    init_reconstruct();
    gitExec = (bin, args, cwd) => {
      const r = spawnSync3(bin, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 3e4, maxBuffer: 20 * 1024 * 1024 });
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
  }
});

// src/cost/otel.ts
import fs14 from "node:fs";
import http from "node:http";
import path13 from "node:path";
function otelFile() {
  return path13.join(tallyHome(), "otel", "metrics.jsonl");
}
function attrValue(v) {
  if (!v) return "";
  if (v.stringValue !== void 0) return String(v.stringValue);
  if (v.intValue !== void 0) return String(v.intValue);
  if (v.doubleValue !== void 0) return String(v.doubleValue);
  if (v.boolValue !== void 0) return String(v.boolValue);
  return "";
}
function parseOtlpMetrics(body, now = /* @__PURE__ */ new Date()) {
  const out = [];
  const b = body ?? {};
  for (const rm of b.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        if (!m.name || !m.name.startsWith("claude_code.")) continue;
        const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
        for (const p of points) {
          const value = p.asDouble !== void 0 ? Number(p.asDouble) : p.asInt !== void 0 ? Number(p.asInt) : NaN;
          if (!Number.isFinite(value)) continue;
          const attrs = {};
          for (const kv of p.attributes ?? []) attrs[kv.key] = attrValue(kv.value);
          const ts = p.timeUnixNano ? new Date(Number(BigInt(String(p.timeUnixNano)) / 1000000n)).toISOString() : now.toISOString();
          out.push({ ts, name: m.name, value, attrs });
        }
      }
    }
  }
  return out;
}
function recordOtelPoints(points, file = otelFile()) {
  if (!points.length) return;
  ensureDir(path13.dirname(file));
  for (const p of points) appendLine(file, JSON.stringify(p));
}
function readOtelPoints(file = otelFile()) {
  if (!fs14.existsSync(file)) return [];
  const out = [];
  for (const line of fs14.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
function otelCostForSession(sessionId, points = readOtelPoints()) {
  const mine = points.filter((p) => p.attrs["session.id"] === sessionId);
  const r = { available: mine.length > 0, total_usd: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, points: mine.length, by_model: {} };
  for (const p of mine) {
    if (p.name === "claude_code.cost.usage") {
      r.total_usd += p.value;
      const model = p.attrs.model ?? "unknown";
      r.by_model[model] = (r.by_model[model] ?? 0) + p.value;
    } else if (p.name === "claude_code.token.usage") {
      const type = (p.attrs.type ?? "").toLowerCase();
      if (type === "input") r.tokens.input += p.value;
      else if (type === "output") r.tokens.output += p.value;
      else if (type === "cacheread") r.tokens.cache_read += p.value;
      else if (type === "cachecreation") r.tokens.cache_write += p.value;
    }
  }
  r.total_usd = Math.round(r.total_usd * 1e6) / 1e6;
  return r;
}
function otelSetupEnv(port) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
    OTEL_METRIC_EXPORT_INTERVAL: "10000"
  };
}
function startOtelReceiver(opts) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (d) => body += d.toString("utf8"));
      req.on("end", () => {
        if (/\/v1\/metrics/.test(req.url ?? "")) {
          try {
            const points = parseOtlpMetrics(JSON.parse(body));
            recordOtelPoints(points, opts.file);
            opts.onPoints?.(points);
          } catch {
          }
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    server.on("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : opts.port });
    });
  });
}
var init_otel = __esm({
  "src/cost/otel.ts"() {
    "use strict";
    init_paths();
  }
});

// src/judge/tiers.ts
function isCorrectnessCriterion(text) {
  return CORRECTNESS_RE.test(text);
}
function guardedConfidence(text, status, confidence) {
  if ((status === "partial" || status === "unmet") && isCorrectnessCriterion(text)) return Math.min(confidence, 0.5);
  return confidence;
}
function verdictSensitive(input) {
  const cur = input.verdictOf(input.statuses);
  const idx = STEP_ORDER.indexOf(input.statuses[input.id] ?? "unverifiable");
  for (const next of [idx - 1, idx + 1]) {
    if (next < 0 || next >= STEP_ORDER.length) continue;
    const moved = { ...input.statuses, [input.id]: STEP_ORDER[next] };
    if (input.verdictOf(moved) !== cur) return true;
  }
  return false;
}
function selectTiers(input) {
  const { judgmentIds, sessionCostUsd, deep, deepThreshold, confidenceFloor } = input;
  const run_tier1 = judgmentIds.length > 0;
  const reasons = [];
  const escalations = [];
  let tier2Criteria = [];
  if (judgmentIds.length) {
    if (deep) reasons.push("--deep");
    if (sessionCostUsd >= deepThreshold) reasons.push(`session cost $${sessionCostUsd.toFixed(2)} \u2265 deepThreshold $${deepThreshold.toFixed(2)}`);
    for (const t of input.tier1 ?? []) {
      const conf = t.adjusted_confidence ?? t.confidence;
      if (t.verdict_sensitive) escalations.push({ id: t.id, reason: "verdict-sensitive" });
      else if (conf < confidenceFloor && t.adjusted_confidence !== void 0 && t.adjusted_confidence < t.confidence) escalations.push({ id: t.id, reason: "correctness" });
      else if (conf < confidenceFloor) escalations.push({ id: t.id, reason: "low-confidence" });
    }
    const byReason = (r) => escalations.filter((e) => e.reason === r).map((e) => e.id);
    if (byReason("verdict-sensitive").length) reasons.push(`verdict-sensitive: ${byReason("verdict-sensitive").join(", ")}`);
    if (byReason("correctness").length) reasons.push(`partial/unmet on correctness criteria (confidence capped at 0.5): ${byReason("correctness").join(", ")}`);
    if (byReason("low-confidence").length) reasons.push(`tier 1 confidence below ${confidenceFloor} on ${byReason("low-confidence").join(", ")}`);
    if (reasons.length) tier2Criteria = deep || sessionCostUsd >= deepThreshold ? judgmentIds : [...new Set(escalations.map((e) => e.id))];
  }
  const run_tier2 = tier2Criteria.length > 0;
  const explanation = !judgmentIds.length ? "tier 0 only: every criterion resolved mechanically" : run_tier2 ? `tier 2 on ${tier2Criteria.length} criteria: ${reasons.join("; ")}` : `tier 2 skipped: session cost $${sessionCostUsd.toFixed(2)} < $${deepThreshold.toFixed(2)}, no --deep, tier 1 confident (\u2265 ${confidenceFloor}) and no verdict-sensitive criterion`;
  return { run_tier1, run_tier2, tier2_reasons: reasons, tier2_criteria: tier2Criteria, escalations, explanation };
}
function approxTokens(s) {
  return Math.ceil(s.length / 4);
}
function trimDiff(diff, prioritizedFiles, maxChars) {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  const parts = diff.split(/(?=^diff --git )/m);
  const score = (p) => {
    const header = p.split("\n")[0] ?? "";
    return prioritizedFiles.some((f) => f && header.toLowerCase().includes(f.replace(/\\/g, "/").toLowerCase().split("/").pop() ?? "")) ? 0 : 1;
  };
  parts.sort((a, b) => score(a) - score(b));
  let out = "";
  let truncated = false;
  for (const p of parts) {
    if (out.length + p.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 400) out += p.slice(0, room) + "\n\u2026[hunk truncated]\n";
      truncated = true;
      break;
    }
    out += p;
  }
  return { text: out, truncated };
}
function buildTier1Prompt(task, ids, ev, ver, numbers, tokenBudget) {
  const criteria = task.criteria.filter((c) => ids.includes(c.id));
  const prioritized = [.../* @__PURE__ */ new Set([...ev.edited_files, ...criteria.flatMap((c) => c.text.match(/[\w./-]+\.[a-z]{1,5}\b/g) ?? [])])];
  const noConsent = !ver.ran && ver.reason === NO_CONSENT_REASON;
  const verLine = ver.ran ? `\`${ver.command}\` \u2192 ${ver.passed ? "PASSED" : ver.timed_out ? "TIMED OUT" : `FAILED (exit ${ver.exit_code})`}
${(ver.output_tail ?? "").split("\n").slice(-8).join("\n")}` : `not run: ${ver.reason}.${noConsent ? ' The user has not allowed the auditor to run tests in this repo. Any criterion about tests passing or coverage can only be "unverifiable" unless the diff itself proves it; transcript claims of passing tests do not count.' : ""}`;
  const head = [`# TASK: ${task.title}`, `## Criteria to decide`, ...criteria.map((c) => `- ${c.id}: ${c.text}`), "", `# INDEPENDENT VERIFICATION (test run by the auditor, not the assistant)`, verLine, "", `# SHIP EVENTS: ${ev.ship_events.map((s) => s.kind).join(", ") || "none"}`, `# FILES CHANGED (${ev.git.files_changed.length}): ${ev.git.files_changed.join(", ")}`, `# NUMBERS: spend $${numbers.cost.toFixed(2)} of $${numbers.budget.toFixed(2)} budget, waste $${numbers.waste.toFixed(2)}, human value $${numbers.value.toFixed(2)}`, ""].join("\n");
  const final = ev.final_messages.at(-1) ?? "";
  const tail = `
# ASSISTANT'S FINAL MESSAGE (a claim)
> ${final.slice(0, 600).replace(/\n/g, "\n> ")}
# COMMANDS RUN
${ev.command_runs.slice(-6).map((c) => `- ${c.command} \u2192 ${c.passed ? "ok" : "FAILED"}`).join("\n") || "(none)"}
`;
  const budgetChars = tokenBudget * 4 - head.length - tail.length - 200;
  const diffSource = ev.git.diff_excerpt ? ev.git.diff_excerpt : ev.reconstruction.diff_text || "(empty diff)";
  const { text, truncated } = trimDiff(diffSource, prioritized, Math.max(1500, budgetChars));
  const label = ev.git.diff_excerpt ? "# DIFF" : ev.reconstruction.diff_text ? "# CHANGES RECONSTRUCTED FROM THE TRANSCRIPT (not verified against disk)" : "# DIFF";
  const prompt = `${head}${label}${truncated ? " (trimmed to fit; hunks touching the criteria came first)" : ""}
${text}
${tail}`;
  return { prompt, tokens: approxTokens(prompt), truncated };
}
function mechanicalSummary(input) {
  const { ver } = input;
  let score = 5;
  const why = ["mechanical proxy (no model read the code)"];
  if (ver.ran && ver.passed) {
    score += 2;
    why.push("independent tests passed");
  } else if (ver.ran) {
    score -= 3;
    why.push("independent tests failed");
  } else why.push("tests not run");
  if (input.waste.failed_loops.length) {
    score -= 1;
    why.push(`${input.waste.failed_loops.length} failed loop(s)`);
  }
  if (input.counts.unmet > 0) {
    score -= 1;
    why.push(`${input.counts.unmet} criterion(s) unmet`);
  }
  score = Math.max(0, Math.min(10, score));
  const recs = [];
  for (const l of input.waste.failed_loops.slice(0, 1)) recs.push(`\`${l.command}\` failed ${l.repeats} times in a row ($${l.usd.toFixed(2)}); after the second identical failure, read the output and change approach.`);
  for (const r of input.waste.repeated_reads.slice(0, 1)) recs.push(`${r.file} was read ${r.reads} times ($${r.usd.toFixed(2)}); keep notes instead of re-reading.`);
  if (input.waste.dead_weight.usd > 0.05) recs.push(`First-turn context carries ${input.waste.dead_weight.overhead_tokens.toLocaleString()} tokens above baseline ($${input.waste.dead_weight.usd.toFixed(2)} this session); prune unused skills and MCP servers.`);
  if (input.waste.compaction_churn.compactions > 0) recs.push(`${input.waste.compaction_churn.compactions} compaction(s) re-cached ${input.waste.compaction_churn.usd > 0 ? "$" + input.waste.compaction_churn.usd.toFixed(2) : "context"}; write HANDOFF.md before /compact.`);
  if (input.cost > input.budget) recs.push(`Spend $${input.cost.toFixed(2)} exceeded the $${input.budget.toFixed(2)} budget; re-scope earlier next time.`);
  if (!ver.ran) recs.push("Allow test re-runs (tally config consent on) so test criteria stop being unverifiable.");
  while (recs.length < 3) recs.push(["Link the ticket before starting so criteria freeze at intake.", "Run the full test suite once before pushing.", "State what is left undone in the final message."][recs.length]);
  const verdict_reason = `Mechanical receipt: ${input.completion_pct}% of criteria resolved by checks (${input.counts.met} met, ${input.counts.partial} partial, ${input.counts.unmet} unmet, ${input.counts.unverifiable} unverifiable${input.unresolved ? `, ${input.unresolved} needed judgment but no model ran` : ""}). Independent tests ${ver.ran ? ver.passed ? "passed" : "failed" : "were not run"}. Spend $${input.cost.toFixed(2)} against a $${input.budget.toFixed(2)} budget with $${input.waste.total_usd.toFixed(2)} measured waste; ROI ${input.roi === null ? "n/a" : input.roi + "\xD7"}.`;
  return { quality: { score, reason: why.join("; ") }, verdict_reason, recommendations: recs.slice(0, 3) };
}
var CORRECTNESS_RE, STEP_ORDER, TIER1_SYSTEM, ESCALATION_SYSTEM, TIER_SCHEMA;
var init_tiers = __esm({
  "src/judge/tiers.ts"() {
    "use strict";
    init_verify();
    CORRECTNESS_RE = /\b(bug|fix|fixes|fixed|correct|correctly|behav(?:iou?r)|logic|returns?|handles?|reject|accept|validat|when |should|must|error|edge case|off-by-one|regression|works|calculat|comput|respon(?:d|se)|status code|\d{3}\b)/i;
    STEP_ORDER = ["unmet", "unverifiable", "partial", "met"];
    TIER1_SYSTEM = `You are a skeptical auditor deciding a few acceptance criteria of a coding session from a short evidence pack.
Evidence hierarchy: independent test run > git diff > tool outputs > the assistant's own words (claims, not evidence).
For each criterion return status met / partial / unmet / unverifiable, one sentence of cited evidence, the files involved, and a confidence from 0 to 1.
Confidence is your honest probability that the status is right given the evidence you saw; use below 0.6 whenever the diff was truncated around the relevant code, the criterion needs behaviour you cannot see, or the claim rests only on the assistant's words.
Also return quality_score (0-10) for the visible code, one-paragraph verdict_reason using the numbers given, and exactly three short recommendations.
Return only the JSON object.`;
    ESCALATION_SYSTEM = `You are an independent, skeptical auditor re-checking a few acceptance criteria that a first pass was unsure about or that decide the verdict.
Evidence hierarchy: the independent test run, then the diff, then tool outputs; the assistant's own words are claims.
For each listed criterion return status met / partial / unmet / unverifiable, one sentence of cited evidence, the files involved, and a confidence 0-1. Use "partial" when the work is visibly started but a stated requirement is missing. Use "unverifiable" rather than guessing.
Return only the JSON object with the criteria array; leave quality_score, verdict_reason and recommendations empty.`;
    TIER_SCHEMA = {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["met", "partial", "unmet", "unverifiable"] },
              evidence: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              confidence: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["id", "status", "evidence"]
          }
        },
        quality_score: { type: "number" },
        quality_reason: { type: "string" },
        verdict_reason: { type: "string" },
        recommendations: { type: "array", items: { type: "string" } }
      },
      /* only `criteria` is hard-required: a strict schema made some models exhaust the structured-output retries */
      required: ["criteria"]
    };
  }
});

// src/judge/schema.ts
var CriterionStatus, UsageZ, Bucket, JudgeSchema;
var init_schema = __esm({
  "src/judge/schema.ts"() {
    "use strict";
    init_zod();
    CriterionStatus = external_exports.enum(["met", "partial", "unmet", "unverifiable"]);
    UsageZ = external_exports.object({ input: external_exports.number(), output: external_exports.number(), cache_write: external_exports.number(), cache_write_1h: external_exports.number().optional(), cache_read: external_exports.number() });
    Bucket = external_exports.object({ usd: external_exports.number(), messages: external_exports.number(), tokens: external_exports.number() });
    JudgeSchema = external_exports.object({
      version: external_exports.literal(1),
      session: external_exports.string(),
      cwd: external_exports.string().optional(),
      judged_at: external_exports.string(),
      reason: external_exports.enum(["push", "pr", "merge", "publish", "session_end", "manual"]),
      task: external_exports.object({
        title: external_exports.string(),
        source: external_exports.object({ kind: external_exports.string(), url: external_exports.string().optional(), ref: external_exports.string() }),
        spec_quality: external_exports.number(),
        estimate_hours: external_exports.number(),
        budget_usd: external_exports.number(),
        linked: external_exports.boolean(),
        task_source: external_exports.enum(["linked", "inferred", "confirmed"]).default("linked")
      }),
      head: external_exports.string().optional(),
      historical: external_exports.object({ start_head: external_exports.string().optional(), end_head: external_exports.string().optional(), notes: external_exports.array(external_exports.string()) }).optional(),
      criteria: external_exports.array(external_exports.object({ id: external_exports.string(), text: external_exports.string(), status: CriterionStatus, evidence: external_exports.string(), files: external_exports.array(external_exports.string()), resolved_by: external_exports.enum(["tier0", "tier1", "tier2", "rule"]).default("tier2"), confidence: external_exports.number().min(0).max(1).optional() })),
      tiers: external_exports.object({
        ran: external_exports.array(external_exports.enum(["tier0", "tier1", "tier2"])),
        reason: external_exports.string(),
        mechanical: external_exports.number(),
        judgment: external_exports.number(),
        calls: external_exports.array(external_exports.object({ tier: external_exports.enum(["tier1", "tier2"]), model: external_exports.string(), cost_usd: external_exports.number(), criteria: external_exports.array(external_exports.string()), prompt_tokens: external_exports.number() })),
        llm_cost_usd: external_exports.number(),
        tier1_pack: external_exports.object({ tokens: external_exports.number(), truncated: external_exports.boolean() }).optional(),
        escalations: external_exports.array(external_exports.object({ id: external_exports.string(), reason: external_exports.enum(["low-confidence", "verdict-sensitive", "correctness"]) })).optional()
      }).default({ ran: ["tier2"], reason: "legacy receipt", mechanical: 0, judgment: 0, calls: [], llm_cost_usd: 0 }),
      completion_pct: external_exports.number().min(0).max(100),
      counts: external_exports.object({ met: external_exports.number(), partial: external_exports.number(), unmet: external_exports.number(), unverifiable: external_exports.number() }),
      quality: external_exports.object({ score: external_exports.number().min(0).max(10), reason: external_exports.string() }),
      verification: external_exports.object({
        ran: external_exports.boolean(),
        command: external_exports.string().optional(),
        basis: external_exports.string().optional(),
        passed: external_exports.boolean().optional(),
        exit_code: external_exports.number().nullable().optional(),
        timed_out: external_exports.boolean().optional(),
        duration_ms: external_exports.number().optional(),
        output_tail: external_exports.string().optional(),
        reason: external_exports.string().optional(),
        env_scrubbed: external_exports.boolean().optional(),
        consent: external_exports.boolean().optional()
      }),
      evidence: external_exports.object({
        files_changed: external_exports.array(external_exports.string()),
        edited_files: external_exports.array(external_exports.string()),
        diff_stat: external_exports.string(),
        insertions: external_exports.number(),
        deletions: external_exports.number(),
        base_head: external_exports.string().optional(),
        current_head: external_exports.string().optional(),
        branch: external_exports.string().optional(),
        git_error: external_exports.string().optional(),
        command_runs: external_exports.array(external_exports.object({ command: external_exports.string(), kind: external_exports.enum(["test", "lint"]), passed: external_exports.boolean(), ts: external_exports.string() })),
        ship_events: external_exports.array(external_exports.object({ kind: external_exports.string(), command: external_exports.string(), url: external_exports.string().optional(), ts: external_exports.string() })),
        final_message: external_exports.string(),
        tool_calls: external_exports.number(),
        diff_source: external_exports.enum(["git", "reconstructed", "mixed", "none"]).default("git"),
        reconstructed_files: external_exports.array(external_exports.string()).default([]),
        bash_edits: external_exports.number().default(0)
      }),
      cost: external_exports.object({
        label: external_exports.literal("API-equivalent"),
        confidence: external_exports.enum(["full", "partial"]),
        format: external_exports.object({ version: external_exports.string().optional(), known: external_exports.boolean(), total_lines: external_exports.number(), unparseable_lines: external_exports.number(), unknown_types: external_exports.array(external_exports.string()) }),
        tally_share_pct: external_exports.number(),
        otel: external_exports.object({ available: external_exports.boolean(), total_usd: external_exports.number().optional(), delta_usd: external_exports.number().optional(), note: external_exports.string().optional() }).optional(),
        total_usd: external_exports.number(),
        usage: UsageZ,
        by_phase: external_exports.record(Bucket),
        by_subagent: external_exports.record(Bucket),
        by_model: external_exports.record(Bucket),
        per_completed_criterion_usd: external_exports.number().nullable(),
        budget_usd: external_exports.number(),
        budget_used_pct: external_exports.number(),
        tally_own_usd: external_exports.number(),
        models: external_exports.array(external_exports.string())
      }),
      waste: external_exports.object({
        total_usd: external_exports.number(),
        failed_loops: external_exports.array(external_exports.object({ command: external_exports.string(), repeats: external_exports.number(), usd: external_exports.number() })),
        repeated_reads: external_exports.array(external_exports.object({ file: external_exports.string(), reads: external_exports.number(), usd: external_exports.number() })),
        dead_weight: external_exports.object({ first_turn_tokens: external_exports.number(), baseline_tokens: external_exports.number(), overhead_tokens: external_exports.number(), usd: external_exports.number() }),
        compaction_churn: external_exports.object({ compactions: external_exports.number(), recache_tokens: external_exports.number(), usd: external_exports.number() })
      }),
      value: external_exports.object({
        estimate_hours: external_exports.number(),
        hourly_rate: external_exports.number(),
        human_value_usd: external_exports.number(),
        credited_value_usd: external_exports.number(),
        roi_multiple: external_exports.number().nullable()
      }),
      attribution: external_exports.object({
        label: external_exports.literal("correlational"),
        note: external_exports.string(),
        rows: external_exports.array(external_exports.object({ kind: external_exports.enum(["skill", "mcp"]), name: external_exports.string(), invocations: external_exports.number(), errors: external_exports.number(), tokens: external_exports.number(), usd: external_exports.number(), touched_met_criteria: external_exports.boolean().nullable() }))
      }),
      verdict: external_exports.object({ verdict: external_exports.enum(["worth it", "borderline", "not worth it"]), reason: external_exports.string() }),
      recommendations: external_exports.array(external_exports.string()).max(3),
      judge_model: external_exports.string(),
      followup: external_exports.object({
        checked_at: external_exports.string(),
        final_status: external_exports.enum(["held up", "needed rework", "reverted", "unknown"]),
        final_verdict: external_exports.enum(["worth it", "borderline", "not worth it"]),
        original_verdict: external_exports.enum(["worth it", "borderline", "not worth it"]),
        pr_state: external_exports.string().optional(),
        merged: external_exports.boolean().optional(),
        reverted: external_exports.boolean().optional(),
        revert_commit: external_exports.string().optional(),
        issue_reopened: external_exports.boolean().optional(),
        review_comments: external_exports.number().optional(),
        change_requests: external_exports.number().optional(),
        ci_failed_after_merge: external_exports.boolean().optional(),
        gh_skipped: external_exports.boolean().optional(),
        notes: external_exports.array(external_exports.string())
      }).optional()
    });
  }
});

// src/judge/report.ts
function renderReport(j) {
  const L = [];
  L.push(`# Tally receipt: ${j.task.title}`);
  L.push("");
  L.push(`Session \`${j.session}\` \xB7 judged ${j.judged_at} on ${j.reason} \xB7 judge model ${j.judge_model}`);
  if (j.task.source.url) L.push(`Source: ${j.task.source.url}`);
  if (!j.task.linked) L.push("> No task was linked. Criteria were inferred from the first prompt; link a ticket next time with `tally task <url>`.");
  L.push("");
  L.push(`## Verdict: **${j.verdict.verdict.toUpperCase()}**${j.followup ? ` \u2192 after follow-up: **${j.followup.final_verdict.toUpperCase()}** (${j.followup.final_status})` : ""}`);
  L.push("");
  L.push(j.verdict.reason);
  if (j.followup) {
    L.push("");
    L.push(`### Follow-up (${j.followup.checked_at})`);
    for (const n of j.followup.notes) L.push(`- ${n}`);
  }
  L.push("");
  L.push(`## Acceptance criteria \u2014 ${j.completion_pct}% complete (${j.counts.met} met, ${j.counts.partial} partial, ${j.counts.unmet} unmet, ${j.counts.unverifiable} unverifiable)`);
  L.push("");
  L.push("| # | Status | Criterion | Evidence |");
  L.push("|---|---|---|---|");
  for (const c of j.criteria) L.push(`| ${c.id} | ${STATUS_ICON[c.status]} ${c.status} | ${esc(c.text)} | ${esc(c.evidence)}${c.files.length ? ` (${c.files.join(", ")})` : ""} _${c.resolved_by}${c.confidence !== void 0 && c.resolved_by !== "tier0" ? `, conf ${c.confidence.toFixed(2)}` : ""}_ |`);
  L.push("");
  L.push(`## How it was judged`);
  L.push("");
  L.push(`Tiers run: ${j.tiers.ran.map(tierLabel).join(" \u2192 ")}. ${j.tiers.reason}. ${j.tiers.mechanical} criteria mechanical (checks), ${j.tiers.judgment} judgment.${j.tiers.calls.length ? " Model calls: " + j.tiers.calls.map((c) => `${c.tier} ${c.model} on ${c.criteria.join(", ")} (${c.prompt_tokens.toLocaleString()} prompt tokens, ${fmtUsd(c.cost_usd)})`).join("; ") + "." : " No model call."}${j.tiers.escalations?.length ? " Escalated: " + j.tiers.escalations.map((e) => `${e.id} (${e.reason})`).join(", ") + "." : ""}`);
  L.push("");
  L.push(`## Quality: ${j.quality.score}/10`);
  L.push("");
  L.push(j.quality.reason);
  L.push("");
  L.push("## Independent verification");
  L.push("");
  if (j.verification.ran) {
    L.push(`Ran \`${j.verification.command}\` (${j.verification.basis}): **${j.verification.passed ? "PASSED" : j.verification.timed_out ? "TIMED OUT" : "FAILED"}** in ${j.verification.duration_ms} ms.`);
    if (!j.verification.passed && j.verification.output_tail) {
      L.push("");
      L.push("```");
      L.push(j.verification.output_tail.split("\n").slice(-25).join("\n"));
      L.push("```");
    }
  } else {
    L.push(`Not run: ${j.verification.reason}.`);
  }
  L.push("");
  L.push(`## Cost (${j.cost.label}) \u2014 ${fmtUsd(j.cost.total_usd)} of ${fmtUsd(j.cost.budget_usd)} budget (${j.cost.budget_used_pct}%)`);
  L.push("");
  L.push(`Per completed criterion: ${j.cost.per_completed_criterion_usd === null ? "n/a (none met)" : fmtUsd(j.cost.per_completed_criterion_usd)} \xB7 Tally's own spend: ${fmtUsd(j.cost.tally_own_usd)} (${j.cost.tally_share_pct}% of session spend, counted separately) \xB7 models: ${j.cost.models.join(", ")}`);
  if (j.cost.confidence === "partial") L.push(`
> **Cost is partial.** Transcript format ${j.cost.format.version ?? "unknown"}${j.cost.format.known ? "" : " is not a verified layout"}; ${j.cost.format.unparseable_lines} of ${j.cost.format.total_lines} lines could not be parsed${j.cost.format.unknown_types.length ? `; unknown line types: ${j.cost.format.unknown_types.join(", ")}` : ""}. Run \`tally doctor\`.`);
  if (j.cost.otel?.available) L.push(`
OTel cross-check: ${fmtUsd(j.cost.otel.total_usd ?? 0)} reported by Claude Code telemetry (${(j.cost.otel.delta_usd ?? 0) >= 0 ? "+" : ""}${fmtUsd(j.cost.otel.delta_usd ?? 0)} vs transcript).`);
  L.push("");
  L.push("| Phase | Spend | Calls |");
  L.push("|---|---|---|");
  for (const [k, v] of Object.entries(j.cost.by_phase)) L.push(`| ${k} | ${fmtUsd(v.usd)} | ${v.messages} |`);
  L.push("");
  L.push("| Agent | Spend | Calls |");
  L.push("|---|---|---|");
  for (const [k, v] of Object.entries(j.cost.by_subagent)) L.push(`| ${k} | ${fmtUsd(v.usd)} | ${v.messages} |`);
  L.push("");
  L.push(`## Waste \u2014 ${fmtUsd(j.waste.total_usd)}`);
  L.push("");
  L.push(`- Failed loops: ${fmtUsd(j.waste.failed_loops.reduce((s, x) => s + x.usd, 0))}${j.waste.failed_loops.length ? " \u2014 " + j.waste.failed_loops.map((l) => `\`${l.command}\` \xD7${l.repeats}`).join(", ") : ""}`);
  L.push(`- Repeated reads: ${fmtUsd(j.waste.repeated_reads.reduce((s, x) => s + x.usd, 0))}${j.waste.repeated_reads.length ? " \u2014 " + j.waste.repeated_reads.map((r) => `${r.file} \xD7${r.reads}`).join(", ") : ""}`);
  L.push(`- Dead-weight context: ${fmtUsd(j.waste.dead_weight.usd)} \u2014 first turn loaded ${j.waste.dead_weight.first_turn_tokens.toLocaleString()} tokens, ${j.waste.dead_weight.overhead_tokens.toLocaleString()} above the ${j.waste.dead_weight.baseline_tokens.toLocaleString()} baseline`);
  L.push(`- Compaction churn: ${fmtUsd(j.waste.compaction_churn.usd)} \u2014 ${j.waste.compaction_churn.compactions} compaction(s), ${j.waste.compaction_churn.recache_tokens.toLocaleString()} tokens re-cached`);
  L.push("");
  L.push("## Value");
  L.push("");
  L.push(`${j.value.estimate_hours}h human estimate \xD7 $${j.value.hourly_rate}/h = ${fmtUsd(j.value.human_value_usd)}; credited at ${j.completion_pct}% completion = ${fmtUsd(j.value.credited_value_usd)}; spend ${fmtUsd(j.cost.total_usd)} \u2192 **ROI ${j.value.roi_multiple === null ? "n/a" : j.value.roi_multiple + "\xD7"}**`);
  L.push("");
  L.push(`## Skill and MCP attribution (${j.attribution.label})`);
  L.push("");
  L.push(j.attribution.note);
  L.push("");
  if (j.attribution.rows.length) {
    L.push("| Kind | Name | Invocations | Errors | Tokens | Spend | Touched a met criterion |");
    L.push("|---|---|---|---|---|---|---|");
    for (const r of j.attribution.rows) L.push(`| ${r.kind} | ${r.name} | ${r.invocations} | ${r.errors} | ${r.tokens.toLocaleString()} | ${fmtUsd(r.usd)} | ${r.touched_met_criteria === null ? "\u2013" : r.touched_met_criteria ? "yes" : "no"} |`);
  } else {
    L.push("_No skills or MCP tools were invoked._");
  }
  L.push("");
  L.push("## Recommendations");
  L.push("");
  for (const r of j.recommendations) L.push(`1. ${r}`);
  L.push("");
  L.push(`## Evidence`);
  L.push("");
  L.push(`Branch ${j.evidence.branch ?? "?"}, base ${j.evidence.base_head?.slice(0, 8) ?? "?"} \u2192 ${j.evidence.current_head?.slice(0, 8) ?? "?"}; ${j.evidence.files_changed.length} files, +${j.evidence.insertions} \u2212${j.evidence.deletions}; ${j.evidence.tool_calls} tool calls.${j.evidence.git_error ? ` (${j.evidence.git_error})` : ""}`);
  if (j.evidence.files_changed.length) L.push(`Files: ${j.evidence.files_changed.join(", ")}`);
  if (j.evidence.ship_events.length) L.push(`Shipped: ${j.evidence.ship_events.map((s) => `${s.kind}${s.url ? " " + s.url : ""}`).join("; ")}`);
  L.push("");
  return L.join("\n") + "\n";
}
function tierLabel(t) {
  return t === "tier0" ? "tier 0 (mechanical)" : t === "tier1" ? "tier 1 (small model)" : "tier 2 (strong model)";
}
function esc(s) {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function renderSummary(j, color = true) {
  const c = (code, s) => color ? `\x1B[${code}m${s}\x1B[0m` : s;
  const verdictColor = j.verdict.verdict === "worth it" ? "32" : j.verdict.verdict === "borderline" ? "33" : "31";
  const L = [];
  L.push(c("1", `Tally receipt \xB7 ${j.task.title}`));
  L.push(`${c(verdictColor, c("1", j.verdict.verdict.toUpperCase()))}${j.followup ? `  \u2192 after follow-up: ${c("1", j.followup.final_verdict.toUpperCase())} (${j.followup.final_status})` : ""}  \xB7  ${j.completion_pct}% complete  \xB7  quality ${j.quality.score}/10  \xB7  ROI ${j.value.roi_multiple === null ? "n/a" : j.value.roi_multiple + "\xD7"}`);
  for (const cr of j.criteria) {
    const col = cr.status === "met" ? "32" : cr.status === "partial" ? "33" : cr.status === "unmet" ? "31" : "90";
    L.push(`  ${c(col, STATUS_ICON[cr.status])} ${cr.id} ${cr.text} ${c("90", `[${cr.resolved_by === "tier0" ? "check" : cr.resolved_by === "rule" ? "rule" : cr.resolved_by}${cr.confidence !== void 0 && cr.resolved_by !== "tier0" ? ` ${cr.confidence.toFixed(2)}` : ""}]`)}`);
  }
  L.push(`Judged by: ${j.tiers.ran.map((t) => t.replace("tier", "tier ")).join(" \u2192 ")} \xB7 ${j.tiers.reason}${j.tiers.calls.length ? ` \xB7 model spend ${fmtUsd(j.tiers.llm_cost_usd)}` : " \xB7 $0 in model calls"}`);
  L.push(`Verification: ${j.verification.ran ? `${j.verification.command} \u2192 ${j.verification.passed ? c("32", "passed") : c("31", j.verification.timed_out ? "timed out" : "FAILED")}` : c("90", `not run (${j.verification.reason})`)}`);
  L.push(`Cost (API-equivalent${j.cost.confidence === "partial" ? ", PARTIAL: transcript not fully parsed" : ""}): ${fmtUsd(j.cost.total_usd)} / budget ${fmtUsd(j.cost.budget_usd)} (${j.cost.budget_used_pct}%) \xB7 per met criterion ${j.cost.per_completed_criterion_usd === null ? "n/a" : fmtUsd(j.cost.per_completed_criterion_usd)} \xB7 waste ${fmtUsd(j.waste.total_usd)}`);
  L.push(`  Tally's own spend: ${fmtUsd(j.cost.tally_own_usd)} (${j.cost.tally_share_pct}% of session spend, separate)${j.cost.otel?.available ? ` \xB7 OTel cross-check ${fmtUsd(j.cost.otel.total_usd ?? 0)}` : ""}`);
  const phases = Object.entries(j.cost.by_phase).filter(([, v]) => v.usd > 0).map(([k, v]) => `${k} ${fmtUsd(v.usd)}`).join(", ");
  const agents = Object.entries(j.cost.by_subagent).filter(([k]) => k !== "main").map(([k, v]) => `${k} ${fmtUsd(v.usd)}`).join(", ");
  L.push(`  by phase: ${phases}${agents ? `  \xB7 subagents: ${agents}` : ""}`);
  L.push(`Value: ${j.value.estimate_hours}h \xD7 $${j.value.hourly_rate} = ${fmtUsd(j.value.human_value_usd)}, credited ${fmtUsd(j.value.credited_value_usd)}`);
  L.push(`Why: ${j.verdict.reason}`);
  if (j.recommendations.length) {
    L.push("Next time:");
    for (const r of j.recommendations) L.push(`  \u2022 ${r}`);
  }
  return L.join("\n");
}
var STATUS_ICON;
var init_report = __esm({
  "src/judge/report.ts"() {
    "use strict";
    init_pricing();
    STATUS_ICON = { met: "\u2714", partial: "\u25D0", unmet: "\u2718", unverifiable: "?" };
  }
});

// src/judge/judge.ts
import fs15 from "node:fs";
import { spawnSync as spawnSync4 } from "node:child_process";
import path14 from "node:path";
function isTestCriterion(text) {
  return TEST_CRITERION_RE.test(text);
}
function otelCrossCheck(session, transcriptCost) {
  const o = otelCostForSession(session);
  if (o.available) return { available: true, total_usd: round(o.total_usd), delta_usd: round(o.total_usd - transcriptCost), note: `${o.points} metric points` };
  if (process.env.CLAUDE_CODE_ENABLE_TELEMETRY) return { available: false, note: "CLAUDE_CODE_ENABLE_TELEMETRY is set but no metrics reached Tally for this session; run `tally otel` and point OTEL_EXPORTER_OTLP_ENDPOINT at it" };
  return void 0;
}
function judgeFile(session) {
  return path14.join(sessionDir(session), "judge.json");
}
function loadJudge(session) {
  const raw = readJson(judgeFile(session), null);
  if (!raw) return null;
  const p = JudgeSchema.safeParse(raw);
  return p.success ? p.data : null;
}
function computeVerdict(input) {
  const { completion_pct, roi, quality, testsFailed } = input;
  const roiOk = roi === null ? true : roi >= 2;
  const roiBad = roi !== null && roi < 1;
  if (completion_pct < 40 || roiBad || quality < 4) return "not worth it";
  if (completion_pct >= 70 && roiOk && quality >= 6 && !testsFailed) return "worth it";
  return "borderline";
}
function bucket(x) {
  return { usd: round(x.cost), messages: x.messages, tokens: x.usage.input + x.usage.output + x.usage.cache_write + x.usage.cache_read };
}
function round(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function tallyOwnSpend(session) {
  const f = tallySpendFile();
  if (!fs15.existsSync(f)) return 0;
  let sum = 0;
  for (const line of fs15.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.session === session) sum += j.cost_usd ?? 0;
    } catch {
    }
  }
  return sum;
}
function buildPrompt(task, t, ev, ver, numbers) {
  const parts = [];
  parts.push(`# TASK
Title: ${task.title}
Source: ${task.source.kind} ${task.source.url ?? ""}
Spec quality at intake: ${task.spec_quality.score}/10

## Frozen acceptance criteria`);
  for (const c of task.criteria) parts.push(`- ${c.id}: ${c.text} [${c.source}]`);
  parts.push(`
# INDEPENDENT VERIFICATION (run by the auditor, not the assistant)`);
  if (ver.ran) parts.push(`Command: ${ver.command}
Result: ${ver.passed ? "PASSED" : ver.timed_out ? "TIMED OUT" : `FAILED (exit ${ver.exit_code})`} in ${ver.duration_ms} ms
Output tail:
${ver.output_tail}`);
  else parts.push(`Not run: ${ver.reason}.${ver.reason === NO_CONSENT_REASON ? ' The user has not allowed the auditor to run tests in this repo. Any criterion about tests passing or coverage can only be "unverifiable" unless the diff itself proves it; transcript claims of passing tests do not count.' : ""}`);
  parts.push(`
# GIT EVIDENCE
Branch: ${ev.git.branch ?? "?"}  Base: ${ev.git.base_head?.slice(0, 8) ?? "unknown"}  ${ev.git.error ? "NOTE: " + ev.git.error : ""}
Files changed (${ev.git.files_changed.length}): ${ev.git.files_changed.join(", ") || "(none)"}
+${ev.git.insertions} -${ev.git.deletions}

## Diff
${ev.git.diff_excerpt || "(empty diff)"}`);
  if (ev.reconstruction.reconstructed.length) parts.push(`
# CHANGES RECONSTRUCTED FROM THE TRANSCRIPT (not verified against disk; the Edit/Write calls the assistant made)
Files only the transcript saw: ${ev.reconstruction.reconstructed.join(", ")}
${ev.reconstruction.bash_edits.length ? "Shell commands that wrote files: " + ev.reconstruction.bash_edits.map((b) => b.command).join("; ") + "\n" : ""}${ev.reconstruction.changes.filter((c) => c.verification === "reconstructed").map((c) => c.detail).join("\n\n")}`);
  parts.push(`
# COMMANDS THE ASSISTANT RAN (from transcript; outputs are tool results, not claims)`);
  if (ev.command_runs.length === 0) parts.push("(no test or lint commands run)");
  for (const r of ev.command_runs) parts.push(`- [${r.kind}] ${r.command} -> ${r.passed ? "exit 0" : "FAILED"}
  ${r.output_tail.split("\n").slice(-6).join("\n  ")}`);
  parts.push(`
# SHIP EVENTS
${ev.ship_events.map((s) => `- ${s.kind}: ${s.command} ${s.url ?? ""}`).join("\n") || "(none)"}`);
  parts.push(`
# USER PROMPTS
${ev.prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
  parts.push(`
# ASSISTANT'S FINAL MESSAGES (claims, verify against evidence)
${ev.final_messages.map((m) => `> ${m.replace(/\n/g, "\n> ")}`).join("\n\n") || "(none)"}`);
  parts.push(`
# NUMBERS (already computed)
API-equivalent spend: $${numbers.cost.toFixed(2)} (budget $${numbers.budget.toFixed(2)})
Measured waste: $${numbers.waste.toFixed(2)}
Human-equivalent value at full completion: $${numbers.value.toFixed(2)}
Tool calls: ${ev.tool_call_count}; compactions: ${t.compactions.length}; subagents: ${Object.keys(t.byAgent).filter((a) => a !== "main").length}`);
  return parts.join("\n");
}
async function judgeSession(opts) {
  const events = opts.events ?? readEvents(opts.session);
  const t = parseTranscriptFile(opts.transcriptPath);
  if (t.internal) throw new Error("refusing to judge one of Tally's own internal runs");
  let task = opts.task === void 0 ? loadTask(opts.session) : opts.task;
  const linked = !!task;
  if (!task) task = implicitTask(opts.session, opts.cwd, t, opts.cfg);
  const ev = collectEvidence({ cwd: opts.cwd, transcript: t, events, exec: opts.exec, skipGit: opts.skipGit });
  const consent = opts.consent ?? testRerunConsent(opts.cfg, opts.cwd);
  const ver = opts.verification ?? await runVerification(opts.cwd, { timeoutMs: opts.cfg.judge.test_timeout_ms, enabled: opts.cfg.judge.run_tests, consent });
  const waste = computeWaste(t, { baselineTokens: opts.cfg.baseline_context_tokens });
  const humanValue = task.estimate.hours * task.hourly_rate;
  const numbers = { cost: t.cost, waste: waste.total_usd, value: humanValue, budget: task.budget_usd };
  const noConsent = !ver.ran && ver.reason === NO_CONSENT_REASON;
  const resolved = /* @__PURE__ */ new Map();
  for (const c of task.criteria) {
    if (c.kind !== "mechanical" || !c.check) continue;
    const r0 = await resolveCheck(c.check, { cwd: opts.cwd, evidence: ev, verification: ver, consent, timeoutMs: opts.cfg.judge.test_timeout_ms, noTree: opts.skipGit });
    resolved.set(c.id, { id: c.id, text: c.text, status: r0.status, evidence: `[${c.check.kind}] ${r0.evidence}`, files: r0.files, resolved_by: "tier0" });
  }
  const judgmentIds = task.criteria.filter((c) => !resolved.has(c.id)).map((c) => c.id);
  const tierCosts = [];
  let prose = null;
  let tier1 = [];
  let decision = selectTiers({ judgmentIds, sessionCostUsd: t.cost, deep: !!opts.deep, deepThreshold: opts.cfg.judge.deepThreshold, confidenceFloor: opts.cfg.judge.tier1_confidence_floor });
  const applyModel = (data, ids, tier) => {
    const byId = new Map((data.criteria ?? []).map((c) => [c.id, c]));
    for (const id of ids) {
      const c = task.criteria.find((x) => x.id === id);
      const j = byId.get(id);
      const status = j && ["met", "partial", "unmet", "unverifiable"].includes(j.status) ? j.status : "unverifiable";
      const conf = typeof j?.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 1;
      resolved.set(id, { id, text: c.text, status, evidence: j?.evidence ?? "No assessment returned by the model.", files: (j?.files ?? []).map(String), resolved_by: tier, confidence: conf });
    }
    prose = { quality_score: Number(data.quality_score ?? 0), quality_reason: String(data.quality_reason ?? ""), verdict_reason: String(data.verdict_reason ?? ""), recommendations: (data.recommendations ?? []).map(String).filter(Boolean) };
  };
  let tier1Pack;
  if (decision.run_tier1 && !(opts.deep || t.cost >= opts.cfg.judge.deepThreshold)) {
    const pack = buildTier1Prompt(task, judgmentIds, ev, ver, numbers, opts.cfg.judge.tier1_evidence_tokens);
    tier1Pack = { tokens: pack.tokens, truncated: pack.truncated };
    const r1 = await opts.llm.complete({ kind: "judge", tier: 1, model: opts.cfg.models.tier1, system: TIER1_SYSTEM, prompt: pack.prompt, schema: TIER_SCHEMA, timeoutMs: 18e4 });
    const out1 = redactDeep(r1.data);
    applyModel(out1, judgmentIds, "tier1");
    tierCosts.push({ tier: "tier1", model: r1.model, cost_usd: round(r1.cost_usd), criteria: judgmentIds, prompt_tokens: pack.tokens });
    const tier1Quality = Math.max(0, Math.min(10, Number(prose?.quality_score ?? 5)));
    const testsFailedNow = ver.ran && ver.passed === false;
    const statuses = Object.fromEntries(task.criteria.map((c) => [c.id, resolved.get(c.id)?.status ?? "unverifiable"]));
    const verdictOf = (st) => {
      const vals = Object.values(st);
      const met = vals.filter((s) => s === "met").length;
      const partial = vals.filter((s) => s === "partial").length;
      const pct = vals.length ? (met + 0.5 * partial) / vals.length * 100 : 0;
      const creditedNow = humanValue * (pct / 100);
      const roiNow = t.cost > 0 ? creditedNow / t.cost : null;
      return computeVerdict({ completion_pct: pct, roi: roiNow, quality: tier1Quality, testsFailed: testsFailedNow });
    };
    tier1 = judgmentIds.map((id) => {
      const r2 = resolved.get(id);
      const c = task.criteria.find((x) => x.id === id);
      const confidence = r2.confidence ?? 1;
      const adjusted = guardedConfidence(c.text, r2.status, confidence);
      return { id, status: r2.status, confidence, adjusted_confidence: adjusted !== confidence ? adjusted : void 0, verdict_sensitive: verdictSensitive({ statuses, id, verdictOf }) };
    });
    decision = selectTiers({ judgmentIds, sessionCostUsd: t.cost, deep: !!opts.deep, deepThreshold: opts.cfg.judge.deepThreshold, confidenceFloor: opts.cfg.judge.tier1_confidence_floor, tier1 });
  }
  if (decision.run_tier2) {
    const ids = decision.tier2_criteria;
    const fullStrength = !!opts.deep || t.cost >= opts.cfg.judge.deepThreshold;
    const model = fullStrength ? opts.cfg.models.judge : t.cost >= opts.cfg.judge.escalation_model_from_usd ? opts.cfg.models.tier2_escalation : opts.cfg.models.tier1;
    const prompt = fullStrength ? buildPrompt({ ...task, criteria: task.criteria.filter((c) => ids.includes(c.id)) }, t, ev, ver, numbers) : buildTier1Prompt(task, ids, ev, ver, numbers, opts.cfg.judge.tier2_escalation_tokens).prompt;
    const r2 = await opts.llm.complete({ kind: "judge", tier: 2, model, system: fullStrength ? JUDGE_SYSTEM : ESCALATION_SYSTEM, prompt, schema: TIER_SCHEMA, timeoutMs: 3e5 });
    const keepProse = !fullStrength && prose;
    const out2 = redactDeep(r2.data);
    applyModel(out2, ids, "tier2");
    if (keepProse && !(out2.verdict_reason && out2.quality_score)) prose = keepProse;
    tierCosts.push({ tier: "tier2", model: r2.model, cost_usd: round(r2.cost_usd), criteria: ids, prompt_tokens: approxTokens(prompt) });
  }
  const criteria = task.criteria.map((c) => {
    const r2 = resolved.get(c.id) ?? { id: c.id, text: c.text, status: "unverifiable", evidence: "needs judgment; no model ran for this criterion", files: [], resolved_by: "rule" };
    if (noConsent && isTestCriterion(c.text) && r2.status !== "unmet" && r2.resolved_by !== "tier0") {
      return { ...r2, status: "unverifiable", evidence: `unverifiable (${NO_CONSENT_REASON}). ${r2.evidence}` };
    }
    return r2;
  });
  const counts = { met: 0, partial: 0, unmet: 0, unverifiable: 0 };
  for (const c of criteria) counts[c.status] += 1;
  const completion_pct = criteria.length ? round((counts.met + 0.5 * counts.partial) / criteria.length * 100, 1) : 0;
  const credited = round(humanValue * (completion_pct / 100), 2);
  const roi = t.cost > 0 ? round(credited / t.cost, 2) : null;
  const testsFailed = ver.ran && ver.passed === false;
  const mech = mechanicalSummary({ ver, completion_pct, counts, waste: { total_usd: waste.total_usd, failed_loops: waste.failed_loops, repeated_reads: waste.repeated_reads, dead_weight: waste.dead_weight, compaction_churn: waste.compaction_churn }, cost: t.cost, budget: task.budget_usd, roi, unresolved: criteria.filter((c) => c.resolved_by === "rule").length });
  const finalProse = prose;
  const out = finalProse ?? { quality_score: mech.quality.score, quality_reason: mech.quality.reason, verdict_reason: mech.verdict_reason, recommendations: mech.recommendations };
  const quality = Math.max(0, Math.min(10, Number(out.quality_score ?? 0)));
  const verdict = computeVerdict({ completion_pct, roi, quality, testsFailed });
  const tiersRan = ["tier0", ...tierCosts.map((c) => c.tier)];
  const tiers = {
    ran: tiersRan,
    reason: decision.explanation,
    mechanical: task.criteria.length - judgmentIds.length,
    judgment: judgmentIds.length,
    calls: tierCosts,
    llm_cost_usd: round(tierCosts.reduce((s, c) => s + c.cost_usd, 0)),
    tier1_pack: tier1Pack,
    escalations: decision.escalations
  };
  const r = { cost_usd: tiers.llm_cost_usd, model: tierCosts.length ? tierCosts[tierCosts.length - 1].model : "mechanical" };
  const rows = markTouched(
    attribute(t),
    t,
    criteria.filter((c) => c.status === "met").flatMap((c) => c.files)
  );
  const tallyOwn = tallyOwnSpend(opts.session);
  const judge = {
    version: 1,
    session: opts.session,
    cwd: opts.repoCwd ?? opts.cwd,
    judged_at: (/* @__PURE__ */ new Date()).toISOString(),
    historical: opts.historical,
    head: ev.git.current_head,
    tiers,
    reason: opts.reason,
    task: { title: task.title, source: { kind: task.source.kind, url: task.source.url, ref: task.source.ref }, spec_quality: task.spec_quality.score, estimate_hours: task.estimate.hours, budget_usd: task.budget_usd, linked, task_source: taskSourceOf(task, linked) },
    criteria,
    completion_pct,
    counts,
    quality: { score: quality, reason: String(out.quality_reason ?? "") },
    verification: ver,
    evidence: {
      files_changed: ev.git.files_changed,
      edited_files: ev.edited_files,
      diff_stat: ev.git.diff_stat,
      insertions: ev.git.insertions,
      deletions: ev.git.deletions,
      base_head: ev.git.base_head,
      current_head: ev.git.current_head,
      branch: ev.git.branch,
      git_error: ev.git.error,
      command_runs: ev.command_runs.map((c) => ({ command: c.command, kind: c.kind, passed: c.passed, ts: c.ts })),
      ship_events: ev.ship_events,
      final_message: ev.final_messages.at(-1) ?? "",
      tool_calls: ev.tool_call_count,
      diff_source: ev.reconstruction.source,
      reconstructed_files: ev.reconstruction.reconstructed,
      bash_edits: ev.reconstruction.bash_edits.length
    },
    cost: {
      label: "API-equivalent",
      total_usd: round(t.cost),
      usage: t.usage,
      by_phase: Object.fromEntries(Object.entries(t.byPhase).map(([k, v]) => [k, bucket(v)])),
      by_subagent: Object.fromEntries(Object.entries(t.byAgent).map(([k, v]) => [k, bucket(v)])),
      by_model: Object.fromEntries(Object.entries(t.byModel).map(([k, v]) => [k, bucket(v)])),
      per_completed_criterion_usd: counts.met > 0 ? round(t.cost / counts.met, 2) : null,
      budget_usd: task.budget_usd,
      budget_used_pct: task.budget_usd > 0 ? round(t.cost / task.budget_usd * 100, 1) : 0,
      tally_own_usd: round(Math.max(tallyOwn, r.cost_usd)),
      tally_share_pct: t.cost > 0 ? round(Math.max(tallyOwn, r.cost_usd) / t.cost * 100, 1) : 0,
      confidence: t.cost_confidence,
      format: t.format,
      otel: otelCrossCheck(opts.session, t.cost),
      models: t.models
    },
    waste: {
      total_usd: round(waste.total_usd),
      failed_loops: waste.failed_loops.map((l) => ({ ...l, usd: round(l.usd) })),
      repeated_reads: waste.repeated_reads.map((l) => ({ ...l, usd: round(l.usd) })),
      dead_weight: { ...waste.dead_weight, usd: round(waste.dead_weight.usd) },
      compaction_churn: { ...waste.compaction_churn, usd: round(waste.compaction_churn.usd) }
    },
    value: { estimate_hours: task.estimate.hours, hourly_rate: task.hourly_rate, human_value_usd: round(humanValue, 2), credited_value_usd: credited, roi_multiple: roi },
    attribution: { label: "correlational", note: "Whether a skill or MCP call touched a met criterion is a correlation, not a cause. Run `tally experiment start <skill|mcp> <name> --tasks N` for a controlled answer.", rows },
    verdict: { verdict, reason: String(out.verdict_reason ?? "") },
    recommendations: (out.recommendations ?? []).map(String).filter(Boolean).slice(0, 3),
    judge_model: r.model
  };
  const validated = JudgeSchema.parse(judge);
  persistJudge(validated, task);
  return validated;
}
function persistJudge(judge, task) {
  const dir = sessionDir(judge.session);
  ensureDir(dir);
  const file = judgeFile(judge.session);
  if (fs15.existsSync(file)) fs15.copyFileSync(file, path14.join(dir, "judge.prev.json"));
  writeJson(file, judge);
  fs15.writeFileSync(path14.join(dir, "report.md"), renderReport(judge));
  appendEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), type: "judge", session: judge.session, cwd: judge.cwd, data: { verdict: judge.verdict.verdict, completion_pct: judge.completion_pct, cost_usd: judge.cost.total_usd, reason: judge.reason } });
  const entry = {
    ts: judge.judged_at,
    session: judge.session,
    repo: judge.cwd ? repoKey(judge.cwd) : void 0,
    task_title: judge.task.title,
    source: judge.task.source,
    verdict: judge.verdict.verdict,
    completion_pct: judge.completion_pct,
    quality: judge.quality.score,
    cost_usd: judge.cost.total_usd,
    waste_usd: judge.waste.total_usd,
    roi: judge.value.roi_multiple,
    per_criterion_usd: judge.cost.per_completed_criterion_usd,
    recommendations: judge.recommendations,
    skills: judge.attribution.rows.filter((r) => r.kind === "skill").map((r) => r.name),
    mcp: judge.attribution.rows.filter((r) => r.kind === "mcp").map((r) => r.name),
    final_status: judge.followup?.final_status,
    final_verdict: judge.followup?.final_verdict,
    linked: judge.task.linked,
    task_source: judge.task.task_source,
    tally_own_usd: judge.cost.tally_own_usd,
    tally_share_pct: judge.cost.tally_share_pct,
    cost_confidence: judge.cost.confidence,
    internal: false,
    criteria_count: judge.criteria.length,
    met: judge.counts.met,
    spec_quality: task?.spec_quality.score
  };
  appendLine(historyFile(), JSON.stringify(entry));
}
function implicitTask(session, cwd, t, cfg) {
  const first = t.prompts[0]?.text ?? "Untitled session";
  const title = first.split("\n")[0].slice(0, 90);
  return {
    session,
    cwd,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    frozen: true,
    source: { kind: "text", ref: first },
    title,
    body_excerpt: first.slice(0, 1500),
    labels: [],
    criteria: [{ id: "c1", text: `Deliver what the first prompt asked: ${title}`, source: "inferred", kind: "judgment" }],
    spec_quality: { score: 0, missing: ["no linked task; criteria inferred from the first prompt"], questions: [] },
    needs_clarification: true,
    estimate: { hours: 1, basis: "default" },
    budget_usd: Math.max(2, 1 * cfg.hourly_rate * 0.25),
    hourly_rate: cfg.hourly_rate,
    tally_cost_usd: 0,
    model: "none"
  };
}
function taskSourceOf(task, linked) {
  if (!linked || task.inferred) return task.confirmed ? "confirmed" : "inferred";
  return "linked";
}
function currentHead(cwd) {
  const r = spawnSync4("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : void 0;
}
function existingReceiptFor(session, cwd) {
  const j = loadJudge(session);
  if (!j) return null;
  const head = currentHead(cwd);
  if (head && j.head && j.head !== head) return null;
  return j;
}
var TEST_CRITERION_RE, JUDGE_SYSTEM;
var init_judge = __esm({
  "src/judge/judge.ts"() {
    "use strict";
    init_parse();
    init_waste();
    init_attribution();
    init_events();
    init_intake();
    init_evidence();
    init_verify();
    init_redact();
    init_otel();
    init_config();
    init_checks();
    init_tiers();
    init_schema();
    init_report();
    init_paths();
    init_client();
    TEST_CRITERION_RE = /\b(test|tests|tested|testing|spec|specs|coverage|passes|passing|green|ci)\b/i;
    JUDGE_SYSTEM = `You are an independent, skeptical auditor of a coding session. You did NOT do the work and you must not take the working assistant's word for anything.
Evidence hierarchy, strongest first: (1) the INDEPENDENT test run that the auditor executed, (2) the git diff, (3) tool outputs recorded in the transcript, (4) the assistant's own messages, which are claims, not evidence.
For each acceptance criterion return exactly one status:
- "met": the diff or independent run shows it is done.
- "partial": clearly started with a visible gap.
- "unmet": no evidence of the work, or evidence it was skipped.
- "unverifiable": you cannot tell from the evidence given. Use this instead of guessing. A claim like "tests pass" with no independent run and no test output is unverifiable.
Cite concrete evidence: file paths, hunks, command output. Never invent files.
quality_score (0-10) judges the code you can see: correctness, tests, scope discipline, no debris (debug prints, TODOs, unrelated churn).
recommendations: exactly three short, specific, actionable habits for next time, ordered by expected dollars saved. Reference the waste figures when relevant.
verdict_reason: one paragraph weighing completion, quality, cost, waste and ROI numbers provided. Be direct.
confidence: your probability (0-1) that each status is right given the evidence.
Return only the JSON object.`;
  }
});

// src/followup/gh.ts
import { spawnSync as spawnSync5 } from "node:child_process";
function ghInstallHint() {
  if (process.platform === "win32") return "winget install GitHub.cli (then reopen the terminal) and run `gh auth login`";
  if (process.platform === "darwin") return "brew install gh && gh auth login";
  return "see https://github.com/cli/cli#installation, then run `gh auth login`";
}
function ghStatus(force = false) {
  if (cached2 && !force) return cached2;
  const v = spawnSync5("gh", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 1e4 });
  if (v.error || v.status !== 0) {
    cached2 = { ok: false, installed: false, reason: "gh is not installed or not on PATH", fix: ghInstallHint() };
    return cached2;
  }
  const a = spawnSync5("gh", ["auth", "status"], { encoding: "utf8", windowsHide: true, timeout: 15e3 });
  if (a.status === 0) cached2 = { ok: true, installed: true, reason: "", fix: "" };
  else cached2 = { ok: false, installed: true, reason: "gh is installed but not authenticated", fix: "gh auth login" };
  return cached2;
}
var cached2;
var init_gh = __esm({
  "src/followup/gh.ts"() {
    "use strict";
    cached2 = null;
  }
});

// src/judge/writeback.ts
function receiptComment(j) {
  const L = [];
  L.push(`**Tally receipt** \u2014 ${j.verdict.verdict}${j.followup ? ` \u2192 after follow-up: ${j.followup.final_verdict} (${j.followup.final_status})` : ""}`);
  L.push("");
  L.push(`${j.completion_pct}% of acceptance criteria met \xB7 quality ${j.quality.score}/10 \xB7 ${fmtUsd(j.cost.total_usd)} API-equivalent (${j.cost.budget_used_pct}% of budget) \xB7 ROI ${j.value.roi_multiple === null ? "n/a" : j.value.roi_multiple + "\xD7"}`);
  L.push("");
  for (const c of j.criteria) L.push(`- ${ICON[c.status]} ${c.text}`);
  L.push("");
  L.push(`Independent check: ${j.verification.ran ? `\`${j.verification.command}\` ${j.verification.passed ? "passed" : "failed"}` : "not run"} \xB7 waste ${fmtUsd(j.waste.total_usd)}`);
  L.push("");
  L.push("<sub>Generated locally by Tally. Contains no code or prompts.</sub>");
  return redact(L.join("\n"));
}
async function writeBack(j, cfg, deps = realDeps) {
  const body = receiptComment(j);
  const posted = [];
  const targets = /* @__PURE__ */ new Set();
  if (j.task.source.url) targets.add(j.task.source.url);
  for (const s of j.evidence.ship_events) if (s.url && /github\.com\/.+\/pull\/\d+/.test(s.url)) targets.add(s.url);
  for (const url of targets) {
    if (/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/.test(url)) {
      const sub = /\/pull\//.test(url) ? "pr" : "issue";
      if (deps === realDeps) {
        const gh = ghStatus();
        if (!gh.ok) {
          posted.push({ target: url, ok: false, detail: `skipped: ${gh.reason} (${gh.fix})` });
          continue;
        }
      }
      const r = deps.exec("gh", [sub, "comment", url, "--body", body]);
      posted.push({ target: url, ok: r.ok, detail: r.ok ? void 0 : r.stderr.trim().slice(0, 200) });
    } else if (/\/browse\/[A-Z][A-Z0-9]+-\d+/.test(url) || j.task.source.kind === "jira") {
      const key = /([A-Z][A-Z0-9]+-\d+)/.exec(url)?.[1];
      const base = cfg.jira.base_url ?? new URL(url).origin;
      if (!key || !cfg.jira.email || !cfg.jira.api_token) {
        posted.push({ target: url, ok: false, detail: "Jira credentials missing" });
        continue;
      }
      const auth = Buffer.from(`${cfg.jira.email}:${cfg.jira.api_token}`).toString("base64");
      const adf = { type: "doc", version: 1, content: body.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line.replace(/[*`<>]/g, "") }] : [] })) };
      const r = await deps.fetch(`${base.replace(/\/$/, "")}/rest/api/3/issue/${key}/comment`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ body: adf }) });
      posted.push({ target: url, ok: r.ok, detail: r.ok ? void 0 : `Jira ${r.status}` });
    } else if (/linear\.app\//.test(url)) {
      if (!cfg.linear.api_key) {
        posted.push({ target: url, ok: false, detail: "LINEAR_API_KEY missing" });
        continue;
      }
      const ident = /issue\/([A-Z0-9]+-\d+)/.exec(url)?.[1];
      const headers = { Authorization: cfg.linear.api_key, "Content-Type": "application/json" };
      const lookup = await deps.fetch("https://api.linear.app/graphql", { method: "POST", headers, body: JSON.stringify({ query: "query($id: String!) { issue(id: $id) { id } }", variables: { id: ident } }) });
      const id = lookup.ok ? JSON.parse(await lookup.text()).data?.issue?.id : void 0;
      if (!id) {
        posted.push({ target: url, ok: false, detail: "Linear issue lookup failed" });
        continue;
      }
      const r = await deps.fetch("https://api.linear.app/graphql", { method: "POST", headers, body: JSON.stringify({ query: "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", variables: { issueId: id, body } }) });
      posted.push({ target: url, ok: r.ok, detail: r.ok ? void 0 : `Linear ${r.status}` });
    }
  }
  return { posted };
}
var ICON;
var init_writeback = __esm({
  "src/judge/writeback.ts"() {
    "use strict";
    init_fetchers();
    init_pricing();
    init_redact();
    init_gh();
    ICON = { met: "\u2705", partial: "\u{1F7E1}", unmet: "\u274C", unverifiable: "\u2754" };
  }
});

// src/commands/judge.ts
var judge_exports = {};
__export(judge_exports, {
  run: () => run3
});
import fs16 from "node:fs";
import path15 from "node:path";
import readline from "node:readline";
function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
async function run3(args) {
  const cfg = loadConfig();
  const session = resolveSession(args._[0] ?? flag(args, "session"), process.cwd());
  if (!session) {
    process.stderr.write("No session found. Pass a session id or run inside a tracked repo.\n");
    return 1;
  }
  const auto = has(args, "auto");
  const reasonFlag = flag(args, "reason");
  const reason = ["push", "pr", "merge", "publish", "session_end", "manual"].includes(reasonFlag ?? "") ? reasonFlag : auto ? "session_end" : "manual";
  const cwd = sessionCwd(session) ?? process.cwd();
  const existing = existingReceiptFor(session, cwd);
  if (existing && !has(args, "force") && !has(args, "deep")) {
    log(`judge: ${session} already judged at HEAD ${existing.head?.slice(0, 8) ?? "?"} (${existing.reason}); reusing`);
    if (!auto) {
      process.stdout.write(`Receipt already exists for this HEAD (judged on ${existing.reason}); showing it. Use --force to re-judge or --deep for the strong model.
`);
      process.stdout.write(renderSummary(existing, !has(args, "plain")) + "\n");
    }
    return;
  }
  const transcriptPath = flag(args, "transcript") ?? transcriptPathFor(session);
  if (!transcriptPath || !fs16.existsSync(transcriptPath)) {
    if (!auto) process.stderr.write(`No transcript found for session ${session}.
`);
    return 1;
  }
  const lock = path15.join(sessionDir(session), "judge.lock");
  if (fs16.existsSync(lock) && Date.now() - fs16.statSync(lock).mtimeMs < 10 * 60 * 1e3) {
    if (!auto) process.stderr.write("A judge run is already in progress for this session.\n");
    return 1;
  }
  fs16.writeFileSync(lock, String(process.pid));
  try {
    const llm = makeLlm({ session });
    if (!auto) process.stdout.write(`Judging session ${session} (${reason})\u2026
`);
    let consent = testRerunConsent(cfg, cwd);
    if (consent === void 0 && !auto && process.stdin.isTTY && cfg.judge.run_tests) {
      const detected = detectTestCommand(cwd);
      if (detected) {
        consent = await askYesNo(`Tally verifies claims by running \`${detected.command}\` itself in ${cwd} (scrubbed environment, ${Math.round(cfg.judge.test_timeout_ms / 1e3)}s timeout). Allow this for this repo? [y/N] `);
        setTestRerunConsent(cwd, consent);
        process.stdout.write(consent ? "Saved: test re-runs allowed for this repo (tally config consent.test_rerun.<repo> false to revoke).\n" : "Saved: tests will not be run here; test criteria will be marked unverifiable.\n");
      }
    }
    const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason, consent, deep: has(args, "deep") });
    const plain = has(args, "plain");
    process.stdout.write(renderSummary(judge, !plain) + "\n");
    process.stdout.write(`Receipt: ${path15.join(sessionDir(session), "report.md")}
`);
    if (has(args, "post") || cfg.writeback) {
      const r = await writeBack(judge, cfg);
      for (const p of r.posted) process.stdout.write(`${p.ok ? "Posted" : "Failed to post"} receipt to ${p.target}${p.detail ? ` (${p.detail})` : ""}
`);
      if (!r.posted.length) process.stdout.write("Nothing to post to: no issue or PR URL is linked to this session.\n");
    }
  } finally {
    if (fs16.existsSync(lock)) fs16.unlinkSync(lock);
  }
}
var init_judge2 = __esm({
  "src/commands/judge.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_client();
    init_judge();
    init_writeback();
    init_session();
    init_paths();
    init_config();
    init_verify();
  }
});

// src/commands/finalize.ts
var finalize_exports = {};
__export(finalize_exports, {
  run: () => run4
});
import fs17 from "node:fs";
import path16 from "node:path";
async function run4(args) {
  const session = args._[0] ?? flag(args, "session");
  if (!session) return;
  const cfg = loadConfig();
  const cwd = sessionCwd(session) ?? process.cwd();
  const transcriptPath = transcriptPathFor(session);
  const events = readEvents(session);
  const startEv = events.find((e) => e.type === "session_start");
  const loaded = startEv?.data.loaded ?? { mcp: [], skills: [], plugins: [] };
  let usedSkills = [];
  let usedMcp = [];
  let firstTurn = 0;
  let cost = 0;
  let costConfidence = "full";
  if (transcriptPath && fs17.existsSync(transcriptPath)) {
    const t = parseTranscriptFile(transcriptPath);
    if (t.internal || isInternalCwd(cwd)) {
      log(`finalize: ${session} is an internal Tally run; not recorded`);
      return;
    }
    usedSkills = [...new Set(t.skills.map((s) => s.name))];
    usedMcp = [...new Set(t.mcpCalls.map((m) => m.server))];
    firstTurn = t.firstTurnContextTokens;
    cost = t.cost;
    costConfidence = t.cost_confidence;
  } else if (isInternalCwd(cwd)) {
    return;
  }
  const summary = { ts: (/* @__PURE__ */ new Date()).toISOString(), kind: "session", session, repo: repoKey(cwd), loaded, used: { skills: usedSkills, mcp: usedMcp }, first_turn_tokens: firstTurn, cost_usd: cost, cost_confidence: costConfidence, linked: !!loadTask(session), internal: false };
  appendLine(historyFile(), JSON.stringify(summary));
  writeJson(path16.join(sessionDir(session), "summary.json"), summary);
  try {
    restoreExperimentConfig(cwd, session);
    prepareNextArm(cwd);
  } catch (err) {
    log(`finalize: experiment restore failed: ${String(err)}`);
  }
  const existing = loadJudge(session);
  const headNow = currentHead(cwd);
  const alreadyJudged = !!existing && (!headNow || !existing.head || existing.head === headNow);
  if (existing && !alreadyJudged) log(`finalize: ${session} HEAD moved since the last receipt (${existing.head?.slice(0, 8)} \u2192 ${headNow?.slice(0, 8)}); re-judging`);
  if (!alreadyJudged && transcriptPath && fs17.existsSync(transcriptPath) && events.some((e) => e.type === "prompt")) {
    try {
      await judgeSession({ session, cwd, transcriptPath, cfg, llm: makeLlm({ session }), reason: "session_end" });
    } catch (err) {
      log(`finalize: judge failed: ${String(err)}`);
    }
  }
}
var init_finalize = __esm({
  "src/commands/finalize.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_client();
    init_judge();
    init_parse();
    init_intake();
    init_events();
    init_session();
    init_paths();
    init_experiment();
  }
});

// src/followup/followup.ts
import path17 from "node:path";
function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function adjustVerdict(original, status) {
  if (status === "reverted") return "not worth it";
  if (status === "needed rework") return original === "worth it" ? "borderline" : "not worth it";
  return original;
}
function detectRevert(cwd, exec, hints) {
  const args = ["log", "--format=%H%x09%s%x09%b", "-n", "400", "-i", "--grep=revert"];
  if (hints.since) args.push(`--since=${hints.since}`);
  const r = exec("git", args, cwd);
  if (!r.ok) return { reverted: false };
  for (const line of r.stdout.split("\n")) {
    const [sha, subject = "", body = ""] = line.split("	");
    const text = `${subject} ${body}`;
    if (!/revert/i.test(subject)) continue;
    if (hints.prNumber && new RegExp(`#${hints.prNumber}\\b`).test(text)) return { reverted: true, commit: sha };
    if (hints.mergeSha && text.includes(hints.mergeSha.slice(0, 7))) return { reverted: true, commit: sha };
    if (hints.branch && text.includes(hints.branch)) return { reverted: true, commit: sha };
  }
  return { reverted: false };
}
function followupSession(session, deps = realFollowupDeps) {
  const judge = loadJudge(session);
  if (!judge) return null;
  const cwd = judge.cwd ?? process.cwd();
  const now = deps.now?.() ?? /* @__PURE__ */ new Date();
  const notes = [];
  const fu = { checked_at: now.toISOString(), final_status: "unknown", final_verdict: judge.verdict.verdict, original_verdict: judge.verdict.verdict, notes };
  const prUrl = judge.evidence.ship_events.map((s) => s.url).find((u) => u && /\/pull\/\d+/.test(u)) ?? (judge.task.source.url && /\/pull\/\d+/.test(judge.task.source.url) ? judge.task.source.url : void 0);
  const issueUrl = judge.task.source.url && /\/issues\/\d+/.test(judge.task.source.url) ? judge.task.source.url : void 0;
  let prNumber;
  let mergeSha;
  let branch = judge.evidence.branch;
  const needsGh = !!(prUrl || issueUrl);
  const gh = needsGh && deps === realFollowupDeps ? ghStatus() : { ok: true, reason: "", fix: "" };
  if (needsGh && !gh.ok) {
    notes.push(`Follow-up skipped: ${gh.reason}. Fix: ${gh.fix}. Revert detection still ran on the local git log.`);
    fu.gh_skipped = true;
  }
  if (prUrl && gh.ok) {
    const r = deps.exec("gh", ["pr", "view", prUrl, "--json", "state,mergedAt,mergeCommit,reviews,comments,number,headRefName,closed"], cwd);
    const pr = r.ok ? parseJson(r.stdout) : null;
    if (pr) {
      prNumber = pr.number;
      branch = pr.headRefName ?? branch;
      fu.pr_state = pr.state;
      fu.merged = pr.state === "MERGED" || !!pr.mergedAt;
      mergeSha = pr.mergeCommit?.oid ?? void 0;
      const reviews = pr.reviews ?? [];
      fu.review_comments = (pr.comments?.length ?? 0) + reviews.length;
      fu.change_requests = reviews.filter((x) => x.state === "CHANGES_REQUESTED").length;
      notes.push(`PR ${prUrl} is ${pr.state}${fu.merged ? " (merged)" : ""}; ${fu.review_comments} review comments, ${fu.change_requests} change requests.`);
      if (fu.merged && mergeSha) {
        const runs = deps.exec("gh", ["run", "list", "--commit", mergeSha, "--json", "conclusion,status,name", "--limit", "20"], cwd);
        const list = runs.ok ? parseJson(runs.stdout) ?? [] : [];
        const failed = list.filter((x) => x.conclusion === "failure");
        fu.ci_failed_after_merge = failed.length > 0;
        if (list.length) notes.push(`CI on merge commit: ${failed.length ? `${failed.length} failed (${failed.map((f) => f.name).join(", ")})` : "green"}.`);
      }
    } else {
      notes.push(`Could not read PR ${prUrl} (${r.stderr.trim().slice(0, 120) || "gh unavailable"}).`);
    }
  } else if (!prUrl) {
    notes.push("No PR URL recorded for this session.");
  }
  if (issueUrl && gh.ok) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(issueUrl);
    if (m) {
      const r = deps.exec("gh", ["api", `repos/${m[1]}/${m[2]}/issues/${m[3]}/events`, "--jq", "[.[] | {event, created_at}]"], cwd);
      const evs = r.ok ? parseJson(r.stdout) ?? [] : [];
      fu.issue_reopened = evs.some((e) => e.event === "reopened" && e.created_at > judge.judged_at);
      const state = deps.exec("gh", ["issue", "view", issueUrl, "--json", "state"], cwd);
      const st = state.ok ? parseJson(state.stdout)?.state : void 0;
      notes.push(`Issue ${issueUrl} is ${st ?? "unknown"}${fu.issue_reopened ? " and was reopened after the receipt" : ""}.`);
    }
  }
  const sinceIso = new Date(Date.parse(judge.judged_at) - 24 * 3600 * 1e3).toISOString();
  const revert = detectRevert(cwd, deps.exec, { prNumber, mergeSha, branch, since: sinceIso });
  fu.reverted = revert.reverted;
  if (revert.reverted) {
    fu.revert_commit = revert.commit;
    notes.push(`Reverted in ${revert.commit?.slice(0, 8) ?? "a later commit"}.`);
  }
  if (fu.reverted) fu.final_status = "reverted";
  else if ((fu.change_requests ?? 0) > 0 || fu.issue_reopened || fu.ci_failed_after_merge || fu.pr_state === "CLOSED" && !fu.merged) fu.final_status = "needed rework";
  else if (fu.merged) fu.final_status = "held up";
  else fu.final_status = "unknown";
  fu.final_verdict = adjustVerdict(judge.verdict.verdict, fu.final_status);
  if (fu.final_verdict !== fu.original_verdict) notes.push(`Verdict adjusted from "${fu.original_verdict}" to "${fu.final_verdict}".`);
  const updated = JudgeSchema.parse({ ...judge, followup: fu });
  persistJudge(updated, loadTask(session));
  return updated;
}
function followupStateFile() {
  return path17.join(tallyHome(), "followup-state.json");
}
function dueSessions(days, now = /* @__PURE__ */ new Date()) {
  const out = [];
  for (const id of listSessions()) {
    const j = loadJudge(id);
    if (!j) continue;
    const age = (now.getTime() - Date.parse(j.judged_at)) / 864e5;
    if (age < days || age > 90) continue;
    if (j.followup && j.followup.final_status !== "unknown") continue;
    if (j.followup && (now.getTime() - Date.parse(j.followup.checked_at)) / 864e5 < days) continue;
    out.push(id);
  }
  return out;
}
function runDueFollowups(days, deps = realFollowupDeps) {
  const done = [];
  for (const id of dueSessions(days, deps.now?.() ?? /* @__PURE__ */ new Date())) {
    try {
      const j = followupSession(id, deps);
      if (j) done.push(j);
    } catch (err) {
      log(`followup ${id} failed: ${String(err)}`);
    }
  }
  const state = readJson(followupStateFile(), {});
  state.last_run = (/* @__PURE__ */ new Date()).toISOString();
  writeJson(followupStateFile(), state);
  return done;
}
var realFollowupDeps;
var init_followup = __esm({
  "src/followup/followup.ts"() {
    "use strict";
    init_schema();
    init_judge();
    init_intake();
    init_events();
    init_paths();
    init_evidence();
    init_gh();
    realFollowupDeps = { exec: gitExec };
  }
});

// src/commands/followup.ts
var followup_exports = {};
__export(followup_exports, {
  run: () => run5
});
async function run5(args) {
  const cfg = loadConfig();
  const plain = has(args, "plain");
  if (has(args, "auto") || has(args, "all")) {
    const done = runDueFollowups(has(args, "all") ? 0 : cfg.followup_days);
    if (!has(args, "auto")) {
      if (!done.length) process.stdout.write("No receipts due for follow-up.\n");
      for (const j2 of done) process.stdout.write(`${j2.task.title}: ${j2.followup.original_verdict} \u2192 ${j2.followup.final_verdict} (${j2.followup.final_status})
`);
    }
    return;
  }
  const session = resolveSession(args._[0] ?? flag(args, "session"), process.cwd());
  if (!session) {
    process.stderr.write("No session found.\n");
    return 1;
  }
  const j = followupSession(session);
  if (!j) {
    process.stderr.write(`Session ${session} has no receipt yet; run \`tally judge ${session}\` first.
`);
    return 1;
  }
  process.stdout.write(renderSummary(j, !plain) + "\n");
  for (const n of j.followup.notes) process.stdout.write(`  - ${n}
`);
}
var init_followup2 = __esm({
  "src/commands/followup.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_followup();
    init_judge();
    init_session();
  }
});

// src/coach/helpers.ts
function norm3(cmd) {
  return typeof cmd === "string" ? cmd.replace(/\s+/g, " ").trim() : "";
}
function normPath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "";
}
function postTools(ctx) {
  return ctx.events.filter((e) => e.type === "post_tool" && !e.data.agent);
}
function toolName(e) {
  return String(e.data.tool_name ?? "");
}
function toolInput(e) {
  return e.data.tool_input ?? {};
}
function minutesAgo(ctx, minutes) {
  return new Date(ctx.now.getTime() - minutes * 6e4).toISOString();
}
function countBy(items, key) {
  const m = /* @__PURE__ */ new Map();
  for (const i of items) {
    const k = key(i);
    if (!k) continue;
    const arr = m.get(k) ?? [];
    arr.push(i);
    m.set(k, arr);
  }
  return m;
}
function shortPath(p, cwd) {
  const n = p.replace(/\\/g, "/");
  if (cwd) {
    const c = cwd.replace(/\\/g, "/").replace(/\/$/, "") + "/";
    if (n.toLowerCase().startsWith(c.toLowerCase())) return n.slice(c.length);
  }
  return n.length > 60 ? "\u2026" + n.slice(-57) : n;
}
var init_helpers = __esm({
  "src/coach/helpers.ts"() {
    "use strict";
  }
});

// src/coach/rules/loop-detect.ts
var LOOP_THRESHOLD, loopDetect;
var init_loop_detect = __esm({
  "src/coach/rules/loop-detect.ts"() {
    "use strict";
    init_helpers();
    LOOP_THRESHOLD = 3;
    loopDetect = {
      id: "loop-detect",
      describe: "The same failing command or edit repeats 3+ times",
      evaluate(ctx) {
        const out = [];
        const failing = postTools(ctx).filter((e) => e.data.is_error === true);
        const cmds = countBy(
          failing.filter((e) => toolName(e) === "Bash"),
          (e) => norm3(toolInput(e).command)
        );
        for (const [cmd, evs] of cmds) {
          if (evs.length < LOOP_THRESHOLD) continue;
          const cost = ctx.avgTurnCostUsd * evs.length;
          out.push({
            rule: this.id,
            key: `loop:${cmd}:${evs.length}`,
            severity: "critical",
            title: `Same command failed ${evs.length}\xD7`,
            message: `\`${cmd.slice(0, 80)}\` has failed ${evs.length} times in a row. Each retry costs about $${ctx.avgTurnCostUsd.toFixed(2)}. Stop, read the full error, and change the approach.`,
            usd_saved: cost,
            action: {
              kind: "inject",
              label: "Tell Claude to stop and diagnose",
              note: `Tally observed \`${cmd.slice(0, 120)}\` fail ${evs.length} times with the same result this session; each retry cost about $${ctx.avgTurnCostUsd.toFixed(2)} and produced no new information.`
            }
          });
        }
        const edits = countBy(
          failing.filter((e) => toolName(e) === "Edit" || toolName(e) === "MultiEdit"),
          (e) => `${normPath(toolInput(e).file_path)}::${String(toolInput(e).old_string ?? "").slice(0, 60)}`
        );
        for (const [key, evs] of edits) {
          if (evs.length < LOOP_THRESHOLD) continue;
          const file = key.split("::")[0];
          out.push({
            rule: this.id,
            key: `loop-edit:${key}:${evs.length}`,
            severity: "critical",
            title: `Same edit failed ${evs.length}\xD7`,
            message: `The same edit to ${file} has failed ${evs.length} times (old_string not found?). Re-read the file before editing again.`,
            usd_saved: ctx.avgTurnCostUsd * evs.length,
            action: { kind: "inject", label: "Tell Claude to re-read before editing", note: `Tally observed ${evs.length} failed edits to ${file} with the same old_string; the file's current contents differ from what the edits expect.` }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/reread.ts
var REREAD_THRESHOLD, reread;
var init_reread = __esm({
  "src/coach/rules/reread.ts"() {
    "use strict";
    init_helpers();
    REREAD_THRESHOLD = 3;
    reread = {
      id: "reread",
      describe: "The same file is read 3 or more times",
      evaluate(ctx) {
        const out = [];
        const reads = countBy(
          postTools(ctx).filter((e) => toolName(e) === "Read"),
          (e) => normPath(toolInput(e).file_path)
        );
        for (const [key, evs] of reads) {
          if (evs.length < REREAD_THRESHOLD) continue;
          const file = String(toolInput(evs[0]).file_path ?? key);
          const chars = evs.reduce((s, e) => s + Number(e.data.response_chars ?? 0), 0);
          const extra = evs.length - 1;
          const tokens = Math.round(chars / 4 / evs.length);
          out.push({
            rule: this.id,
            key: `reread:${key}:${evs.length}`,
            severity: "warn",
            title: `${shortPath(file, ctx.cwd)} read ${evs.length}\xD7`,
            message: `${shortPath(file, ctx.cwd)} has been read ${evs.length} times (~${tokens.toLocaleString()} tokens each). Every re-read is billed again and sits in context. Pin the parts that matter instead.`,
            usd_saved: ctx.avgTurnCostUsd * extra,
            action: {
              kind: "inject",
              label: "Ask Claude to keep notes instead of re-reading",
              note: `Tally observed ${shortPath(file, ctx.cwd)} being read ${evs.length} times this session (~${tokens.toLocaleString()} tokens each time); the file has not changed between reads.`
            }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/context-pressure.ts
import path18 from "node:path";
function buildHandoff(ctx) {
  const task = ctx.task;
  const edits = [...new Set(postTools(ctx).filter((e) => ["Edit", "Write", "MultiEdit"].includes(toolName(e))).map((e) => shortPath(String(toolInput(e).file_path ?? ""), ctx.cwd)))];
  const lastStop = [...ctx.events].reverse().find((e) => e.type === "stop");
  const lastPrompt = [...ctx.events].reverse().find((e) => e.type === "prompt");
  const tests = postTools(ctx).filter((e) => toolName(e) === "Bash" && /test|vitest|pytest|jest/.test(String(toolInput(e).command ?? ""))).slice(-1)[0];
  const L = [];
  L.push(`# HANDOFF (written by Tally at ${ctx.now.toISOString()})`);
  L.push("");
  L.push("## Goal");
  L.push(task ? `${task.title}${task.source.url ? ` (${task.source.url})` : ""}` : lastPrompt ? String(lastPrompt.data.prompt ?? "").slice(0, 400) : "(no linked task)");
  if (task?.criteria.length) {
    L.push("");
    L.push("Acceptance criteria:");
    for (const c of task.criteria) L.push(`- [ ] ${c.text}`);
  }
  L.push("");
  L.push("## State");
  L.push(edits.length ? `Files touched this session: ${edits.join(", ")}` : "No files edited yet.");
  if (tests) L.push(`Last test run: \`${String(toolInput(tests).command)}\` \u2192 ${tests.data.is_error ? "failing" : "passing"}`);
  if (lastStop) L.push(`Last assistant summary: ${String(lastStop.data.last_assistant_message ?? "").slice(0, 600)}`);
  L.push("");
  L.push("## Next steps");
  L.push("- Re-read this file after /compact, then continue from the unchecked criteria above.");
  if (tests?.data.is_error) L.push("- Fix the failing test before adding anything new.");
  L.push("");
  return L.join("\n");
}
var contextPressure;
var init_context_pressure = __esm({
  "src/coach/rules/context-pressure.ts"() {
    "use strict";
    init_helpers();
    init_pricing();
    contextPressure = {
      id: "context-pressure",
      describe: "Context passes 70% (warn) or 85% (critical)",
      evaluate(ctx) {
        if (!ctx.contextTokensNow || !ctx.contextWindow) return [];
        const pct = ctx.contextTokensNow / ctx.contextWindow * 100;
        const warn = ctx.cfg.coach.context_warn_pct;
        const crit = ctx.cfg.coach.context_critical_pct;
        if (pct < warn) return [];
        const level = pct >= crit ? crit : warn;
        const model = ctx.transcript?.messages.find((m) => m.agent === "main")?.model;
        const price = priceFor(model);
        const recacheUsd = ctx.contextTokensNow * price.cache_write_1h / 1e6;
        const s = {
          rule: this.id,
          key: `context:${level}`,
          severity: pct >= crit ? "critical" : "warn",
          title: `Context at ${pct.toFixed(0)}%`,
          message: `Context is ${ctx.contextTokensNow.toLocaleString()} of ${ctx.contextWindow.toLocaleString()} tokens (${pct.toFixed(0)}%). Auto-compact will lose working state. Write HANDOFF.md now, then run /compact on your terms. Re-caching after compaction costs about $${recacheUsd.toFixed(2)}.`,
          usd_saved: recacheUsd + ctx.avgTurnCostUsd * 2,
          action: { kind: "write_md", label: "Write HANDOFF.md, then suggest /compact", file: path18.join(ctx.cwd, "HANDOFF.md"), content: buildHandoff(ctx), mode: "replace" },
          inject_note: `Tally observed the context at ${pct.toFixed(0)}% of the window; HANDOFF.md in the repo root now holds the goal, current state, and next steps as of ${ctx.now.toISOString().slice(11, 16)} UTC.`
        };
        return [s];
      }
    };
  }
});

// src/coach/rules/claude-md.ts
import fs18 from "node:fs";
import path19 from "node:path";
function instructionSentences(text) {
  const out = [];
  for (const raw of text.split(/(?<=[.!\n])\s+|;\s+/)) {
    const s = raw.trim().replace(/[.!]+$/, "");
    const m = IMPERATIVE.exec(s);
    if (!m) continue;
    const from = s.slice(m.index).trim();
    if (from.length >= 12 && from.length <= 140) out.push(from);
  }
  return out;
}
function fingerprint(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
function repeatedInstructions(prompts, historyPrompts = []) {
  const seen = /* @__PURE__ */ new Map();
  const all = [...prompts.map((p) => ({ p, weight: 1 })), ...historyPrompts.map((p) => ({ p, weight: 1 }))];
  for (const { p } of all) {
    const uniq = new Set(instructionSentences(p).map(fingerprint));
    for (const fp of uniq) {
      const first = instructionSentences(p).find((s) => fingerprint(s) === fp);
      const cur = seen.get(fp) ?? { text: first, count: 0 };
      cur.count += 1;
      seen.set(fp, cur);
    }
  }
  return [...seen.values()].filter((x) => x.count >= 2).sort((a, b) => b.count - a.count);
}
function detectStack(cwd) {
  const has2 = (f) => fs18.existsSync(path19.join(cwd, f));
  const lines = [];
  if (has2("package.json")) {
    try {
      const pkg = JSON.parse(fs18.readFileSync(path19.join(cwd, "package.json"), "utf8"));
      const s = pkg.scripts ?? {};
      if (s.test) lines.push(`- Test: \`npm test\` (${s.test})`);
      if (s.build) lines.push(`- Build: \`npm run build\``);
      if (s.lint) lines.push(`- Lint: \`npm run lint\``);
      if (s.dev) lines.push(`- Dev server: \`npm run dev\``);
    } catch {
    }
  }
  if (has2("pyproject.toml") || has2("requirements.txt")) lines.push("- Python project: run tests with `python -m pytest -q`");
  if (has2("go.mod")) lines.push("- Go: `go test ./...`");
  if (has2("Cargo.toml")) lines.push("- Rust: `cargo test`");
  return lines;
}
function repoKeyOf(cwd) {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
var IMPERATIVE, claudeMd;
var init_claude_md = __esm({
  "src/coach/rules/claude-md.ts"() {
    "use strict";
    init_helpers();
    IMPERATIVE = /\b(always|never|don'?t|do not|prefer|avoid|make sure|remember to|stop using|only use|use)\b/i;
    claudeMd = {
      id: "claude-md",
      describe: "CLAUDE.md is missing, or the user keeps repeating the same instruction",
      evaluate(ctx) {
        const out = [];
        const prompts = ctx.events.filter((e) => e.type === "prompt").map((e) => String(e.data.prompt ?? ""));
        const historyPrompts = ctx.history.filter((h) => h.repo === repoKeyOf(ctx.cwd) && Array.isArray(h.prompts)).flatMap((h) => h.prompts ?? []);
        const repeated = repeatedInstructions(prompts, historyPrompts);
        const claudeMdPath = path19.join(ctx.cwd, "CLAUDE.md");
        const existing = ctx.claudeMd ?? "";
        for (const r of repeated.slice(0, 2)) {
          if (existing.toLowerCase().includes(r.text.toLowerCase().slice(0, 40))) continue;
          out.push({
            rule: this.id,
            key: `repeated:${fingerprint(r.text)}`,
            severity: "info",
            title: "Instruction repeated",
            message: `You've told Claude "${r.text}" ${r.count} times. Put it in CLAUDE.md once and it sticks. (/insights shows the 30-day version of this.)`,
            usd_saved: ctx.avgTurnCostUsd * 0.5 * r.count,
            action: { kind: "write_md", label: "Append to CLAUDE.md", file: claudeMdPath, content: `
- ${r.text}
`, mode: "append" }
          });
        }
        if (ctx.claudeMd === null && postTools(ctx).length >= 5) {
          const stack = detectStack(ctx.cwd);
          out.push({
            rule: this.id,
            key: "missing-claude-md",
            severity: "info",
            title: "No CLAUDE.md in this repo",
            message: `This repo has no CLAUDE.md, so Claude rediscovers the stack and commands every session. A 10-line file saves the exploration turns. /init can draft one too.`,
            usd_saved: ctx.avgTurnCostUsd * 3,
            action: {
              kind: "write_md",
              label: "Create a starter CLAUDE.md",
              file: claudeMdPath,
              mode: "create",
              content: `# ${path19.basename(ctx.cwd)}

## Commands
${stack.length ? stack.join("\n") : "- (fill in test/build/lint commands)"}

## Conventions
- Run the tests before declaring a task done.
- Keep changes scoped to the task; no drive-by refactors.
`
            }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/mcp-opportunity.ts
var OPPORTUNITIES, MCP_OPPORTUNITY_THRESHOLD, mcpOpportunity;
var init_mcp_opportunity = __esm({
  "src/coach/rules/mcp-opportunity.ts"() {
    "use strict";
    init_helpers();
    OPPORTUNITIES = [
      {
        server: "github",
        test: (cmd, tool) => tool === "Bash" && /\bgh\s+(issue|pr|api|repo|run)\b/.test(cmd),
        why: "structured issue/PR data without parsing gh output",
        snippet: "claude mcp add github -- npx -y @modelcontextprotocol/server-github"
      },
      {
        server: "atlassian",
        test: (cmd, tool) => tool === "Bash" && /atlassian\.net|\/rest\/api\/(2|3)\//.test(cmd),
        why: "Jira reads and comments as tools instead of curl",
        snippet: "claude mcp add atlassian -- npx -y mcp-remote https://mcp.atlassian.com/v1/sse"
      },
      {
        server: "linear",
        test: (cmd, tool) => tool === "Bash" && /api\.linear\.app/.test(cmd),
        why: "Linear issues as tools",
        snippet: "claude mcp add linear -- npx -y mcp-remote https://mcp.linear.app/sse"
      },
      {
        server: "postgres",
        test: (cmd, tool) => tool === "Bash" && /\bpsql\b|\bpg_dump\b/.test(cmd),
        why: "schema and query access with result shaping",
        snippet: 'claude mcp add postgres -- npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"'
      },
      {
        server: "playwright",
        test: (cmd, tool) => tool === "Bash" && /\b(playwright|puppeteer|chromium|headless)\b/.test(cmd) || tool === "WebFetch" && /localhost|127\.0\.0\.1/.test(cmd),
        why: "drive a real browser instead of shelling out",
        snippet: "claude mcp add playwright -- npx -y @playwright/mcp@latest"
      },
      {
        server: "context7",
        test: (cmd, tool) => tool === "WebFetch" && /docs\.|\/docs\/|readthedocs|developer\.mozilla|npmjs\.com/.test(cmd),
        why: "versioned library docs on demand without repeated fetches",
        snippet: "claude mcp add context7 -- npx -y @upstash/context7-mcp"
      }
    ];
    MCP_OPPORTUNITY_THRESHOLD = 3;
    mcpOpportunity = {
      id: "mcp-opportunity",
      describe: "Repeated shell or web fetches that an MCP server would handle better",
      evaluate(ctx) {
        const out = [];
        const calls = postTools(ctx).map((e) => ({ tool: toolName(e), cmd: String(toolInput(e).command ?? toolInput(e).url ?? "") }));
        for (const op of OPPORTUNITIES) {
          if (ctx.loaded.mcp.some((m) => m.toLowerCase().includes(op.server))) continue;
          const n = calls.filter((c) => op.test(c.cmd, c.tool)).length;
          if (n < MCP_OPPORTUNITY_THRESHOLD) continue;
          out.push({
            rule: this.id,
            key: `mcp-op:${op.server}`,
            severity: "info",
            title: `${n} shell/web calls the ${op.server} MCP would handle`,
            message: `${n} calls this session went through the shell or web fetch for ${op.server}: ${op.why}. An MCP server returns structured results and fewer retries.`,
            usd_saved: ctx.avgTurnCostUsd * Math.max(1, n / 3),
            action: { kind: "snippet", label: "Show the config command", snippet: op.snippet, where: "run once in this repo (or add --scope user)" }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/dead-weight.ts
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function loads(h, kind, name) {
  const arr = kind === "mcp" ? h.loaded?.mcp : h.loaded?.skills;
  return (arr ?? []).some((x) => x.toLowerCase() === name.toLowerCase());
}
function uses(h, kind, name) {
  const arr = kind === "mcp" ? h.used?.mcp : h.used?.skills;
  return (arr ?? []).some((x) => kind === "mcp" ? x.toLowerCase() === name.toLowerCase() : x.toLowerCase().includes(name.toLowerCase()));
}
function findDeadWeight(ctx, minSessions = 3) {
  const repo = ctx.cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const all = ctx.history.filter((h) => h.kind === "session" && !h.internal && h.repo === repo && h.loaded && typeof h.first_turn_tokens === "number");
  const recent = all.slice(-ctx.cfg.dead_weight_sessions);
  if (recent.length < minSessions) return { items: [], sessions: recent.length, avg_first_turn: 0, overhead: 0 };
  const avgFirst = mean(recent.map((h) => h.first_turn_tokens ?? 0));
  const overhead = Math.max(0, avgFirst - ctx.cfg.baseline_context_tokens);
  const model = ctx.transcript?.messages.find((m) => m.agent === "main")?.model;
  const price = priceFor(model);
  const avgMsgs = ctx.transcript ? ctx.transcript.messages.filter((m) => m.agent === "main").length || 20 : 20;
  const candidates = [];
  for (const h of recent) {
    for (const m of h.loaded?.mcp ?? []) if (!candidates.some((c) => c.kind === "mcp" && c.name === m)) candidates.push({ kind: "mcp", name: m });
    for (const s of h.loaded?.skills ?? []) if (!candidates.some((c) => c.kind === "skill" && c.name === s)) candidates.push({ kind: "skill", name: s });
  }
  const totalItems = candidates.length || 1;
  const items = [];
  for (const c of candidates) {
    const loadedRecent = recent.filter((h) => loads(h, c.kind, c.name));
    if (loadedRecent.length < minSessions) continue;
    if (loadedRecent.some((h) => uses(h, c.kind, c.name))) continue;
    let streak = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i];
      if (!loads(h, c.kind, c.name)) continue;
      if (uses(h, c.kind, c.name)) break;
      streak += 1;
    }
    const withIt = all.filter((h) => loads(h, c.kind, c.name)).map((h) => h.first_turn_tokens ?? 0);
    const withoutIt = all.filter((h) => !loads(h, c.kind, c.name)).map((h) => h.first_turn_tokens ?? 0);
    let basis;
    let tokens;
    if (withIt.length && withoutIt.length) {
      basis = "measured";
      tokens = Math.max(0, Math.round(mean(withIt) - mean(withoutIt)));
    } else {
      basis = "estimated";
      tokens = Math.round(overhead / totalItems);
    }
    const usd = (tokens * price.cache_write_1h + tokens * price.cache_read * avgMsgs) / 1e6;
    items.push({
      kind: c.kind,
      name: c.name,
      loaded_in: loadedRecent.length,
      unused_streak: streak,
      overhead_tokens: tokens,
      basis,
      compared: { with: withIt.length, without: withoutIt.length },
      usd_per_session: usd,
      recommendation: basis === "measured" || streak >= REMOVE_AFTER_UNUSED_SESSIONS ? "remove" : "watch"
    });
  }
  items.sort((a, b) => a.recommendation === b.recommendation ? b.usd_per_session - a.usd_per_session : a.recommendation === "remove" ? -1 : 1);
  return { items, sessions: recent.length, avg_first_turn: Math.round(avgFirst), overhead: Math.round(overhead) };
}
var REMOVE_AFTER_UNUSED_SESSIONS, deadWeight;
var init_dead_weight = __esm({
  "src/coach/rules/dead-weight.ts"() {
    "use strict";
    init_pricing();
    REMOVE_AFTER_UNUSED_SESSIONS = 10;
    deadWeight = {
      id: "dead-weight",
      describe: "A skill or MCP server is loaded but unused across recent sessions",
      evaluate(ctx) {
        const dw = findDeadWeight(ctx);
        if (!dw.items.length) return [];
        const out = [];
        for (const item of dw.items.slice(0, 3)) {
          const measure = item.basis === "measured" ? `Measured: first turns in this repo run ${item.overhead_tokens.toLocaleString()} tokens higher with "${item.name}" loaded than without it (${item.compared.with} vs ${item.compared.without} sessions), about $${item.usd_per_session.toFixed(2)} per session.` : `Estimated: the first turn loads ${dw.avg_first_turn.toLocaleString()} tokens on average, ${dw.overhead.toLocaleString()} above baseline, shared evenly by everything loaded; "${item.name}"'s even share is ~${item.overhead_tokens.toLocaleString()} tokens (~$${item.usd_per_session.toFixed(2)} per session). No session without it exists yet to measure the real delta.`;
          const remove = item.recommendation === "remove";
          const removal = item.kind === "mcp" ? `claude mcp remove ${item.name}` : `claude plugin disable <plugin providing ${item.name}>   # or delete .claude/skills/${item.name}`;
          out.push({
            rule: this.id,
            key: `dead:${item.kind}:${item.name}:${item.recommendation}`,
            severity: "info",
            title: `${item.kind} "${item.name}" unused for ${item.unused_streak} session${item.unused_streak === 1 ? "" : "s"} (${item.basis}${remove ? ", remove" : ", watch"})`,
            message: `${measure} ${remove ? "Recommendation: remove it, or run `tally experiment start " + item.kind + " " + item.name + " --tasks 6` to measure its effect on outcomes." : `Recommendation: watch. Removal is suggested once the overhead is measured or after ${REMOVE_AFTER_UNUSED_SESSIONS} unused sessions (${item.unused_streak} so far).`} Claude Code's /plugin Stats tab and its "Not used recently" view show the same usage; Tally adds the per-task dollar impact.`,
            usd_saved: item.usd_per_session,
            action: remove ? { kind: "snippet", label: "Show the removal command", snippet: removal, where: "settings change: run it yourself; Tally never edits MCP or plugin config automatically" } : { kind: "none", label: `Watching; ${REMOVE_AFTER_UNUSED_SESSIONS - item.unused_streak} more unused session(s) or one session without it will settle this` }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/mcp-errors.ts
var MCP_ERROR_THRESHOLD, mcpErrors;
var init_mcp_errors = __esm({
  "src/coach/rules/mcp-errors.ts"() {
    "use strict";
    init_helpers();
    MCP_ERROR_THRESHOLD = 3;
    mcpErrors = {
      id: "mcp-errors",
      describe: "An MCP tool keeps erroring",
      evaluate(ctx) {
        const out = [];
        const errs = countBy(
          postTools(ctx).filter((e) => e.data.is_error === true && toolName(e).startsWith("mcp__")),
          (e) => toolName(e)
        );
        for (const [tool, evs] of errs) {
          if (evs.length < MCP_ERROR_THRESHOLD) continue;
          const parts = tool.split("__");
          const server = parts[1] ?? tool;
          const head = String(evs[evs.length - 1].data.response_head ?? "").slice(0, 120);
          out.push({
            rule: this.id,
            key: `mcp-err:${tool}:${evs.length}`,
            severity: "warn",
            title: `${server} MCP failed ${evs.length}\xD7`,
            message: `${tool} has errored ${evs.length} times (${head || "no detail"}). Retrying an MCP tool that returns the same error burns turns. Check auth or the server with /mcp, or tell Claude to stop using it.`,
            usd_saved: ctx.avgTurnCostUsd * evs.length,
            action: { kind: "inject", label: "Tell Claude to stop calling it", note: `Tally observed the MCP tool ${tool} fail ${evs.length} times this session with: ${head || "the same error"}.` }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/permission-friction.ts
import path20 from "node:path";
function commandPrefix(message) {
  const m = /Bash\(([^)]+)\)/.exec(message) ?? /`([^`]+)`/.exec(message) ?? /(?:run|execute|use)\s+(?:the\s+)?(?:command\s+)?[`"']?([^`"'\n]+)/i.exec(message);
  const cmd = (m?.[1] ?? "").trim();
  if (!cmd) return null;
  for (const p of SAFE_PREFIXES) if (cmd.startsWith(p)) return p.trim();
  return cmd.split(/\s+/).slice(0, 2).join(" ");
}
var PERMISSION_THRESHOLD, SAFE_PREFIXES, permissionFriction;
var init_permission_friction = __esm({
  "src/coach/rules/permission-friction.ts"() {
    "use strict";
    init_helpers();
    PERMISSION_THRESHOLD = 2;
    SAFE_PREFIXES = ["git status", "git diff", "git log", "npm test", "npm run", "npx vitest", "npx tsc", "pytest", "python -m pytest", "go test", "cargo test", "ls", "cat", "grep", "rg", "find", "node ", "bun test", "pnpm test", "yarn test", "make test", "gh pr view", "gh issue view"];
    permissionFriction = {
      id: "permission-friction",
      describe: "Repeated permission prompts for the same safe command",
      evaluate(ctx) {
        const out = [];
        const perms = ctx.events.filter((e) => e.type === "permission");
        const byPrefix = countBy(perms, (e) => commandPrefix(String(e.data.message ?? "")) ?? "");
        for (const [prefix, evs] of byPrefix) {
          if (evs.length < PERMISSION_THRESHOLD) continue;
          const safe = SAFE_PREFIXES.some((p) => p.trim() === prefix);
          const rule = `Bash(${prefix}:*)`;
          out.push({
            rule: this.id,
            key: `perm:${prefix}`,
            severity: "info",
            title: `${evs.length} prompts for \`${prefix}\``,
            message: `You've approved \`${prefix}\` ${evs.length} times this session${safe ? " and it is read-only or a test runner" : ""}. Add \`${rule}\` to the allowlist, or run /fewer-permission-prompts to do this for everything at once.`,
            usd_saved: 0,
            action: {
              kind: "settings",
              label: `Add ${rule} to .claude/settings.local.json`,
              file: path20.join(ctx.cwd, ".claude", "settings.local.json"),
              patch: { permissions: { allow: [rule] } },
              snippet: JSON.stringify({ permissions: { allow: [rule] } }, null, 2)
            }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/burn-rate.ts
var BURN_WINDOW_MIN, BURN_MIN_USD, burnRate;
var init_burn_rate = __esm({
  "src/coach/rules/burn-rate.ts"() {
    "use strict";
    init_helpers();
    BURN_WINDOW_MIN = 10;
    BURN_MIN_USD = 1.5;
    burnRate = {
      id: "burn-rate",
      describe: "Spend is high while no files change, or spend passed 80% / 100% of the task budget",
      evaluate(ctx) {
        const out = [];
        const t = ctx.transcript;
        if (t) {
          const since = minutesAgo(ctx, BURN_WINDOW_MIN);
          const recent = t.messages.filter((m) => m.agent === "main" && m.ts >= since);
          const spent = recent.reduce((s, m) => s + m.cost, 0);
          const edits = postTools(ctx).filter((e) => e.ts >= since && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName(e))).length;
          const calls = postTools(ctx).filter((e) => e.ts >= since).length;
          if (spent >= BURN_MIN_USD && edits === 0 && calls >= 5) {
            out.push({
              rule: this.id,
              key: `burn:${Math.floor(ctx.now.getTime() / (BURN_WINDOW_MIN * 6e4))}`,
              severity: "warn",
              title: `$${spent.toFixed(2)} in ${BURN_WINDOW_MIN} min, no file changed`,
              message: `The last ${BURN_WINDOW_MIN} minutes cost $${spent.toFixed(2)} across ${calls} tool calls without a single edit. That is exploration or thrashing. Narrow the question or give Claude the file names.`,
              usd_saved: spent / 2,
              action: { kind: "inject", label: "Ask Claude to commit to a plan", note: `Tally observed ${calls} tool calls and $${spent.toFixed(2)} of spend in the last ${BURN_WINDOW_MIN} minutes with no file edited.` }
            });
          }
        }
        const task = ctx.task;
        if (task && task.budget_usd > 0 && ctx.spendUsd > 0) {
          const pct = ctx.spendUsd / task.budget_usd * 100;
          if (pct >= 100) {
            out.push({
              rule: this.id,
              key: "budget:100",
              severity: "critical",
              title: `Over budget: $${ctx.spendUsd.toFixed(2)} of $${task.budget_usd.toFixed(2)}`,
              message: `Spend has passed the intake budget for "${task.title}" (${pct.toFixed(0)}%). The budget was 25% of the human-equivalent value; beyond it the ROI verdict turns borderline. Wrap up or re-scope.`,
              usd_saved: ctx.avgTurnCostUsd * 5,
              action: { kind: "inject", label: "Tell Claude to wrap up", note: `Tally observed session spend of $${ctx.spendUsd.toFixed(2)} against the task's $${task.budget_usd.toFixed(2)} budget set at intake (${pct.toFixed(0)}%).` }
            });
          } else if (pct >= 80) {
            out.push({
              rule: this.id,
              key: "budget:80",
              severity: "warn",
              title: `${pct.toFixed(0)}% of budget used`,
              message: `$${ctx.spendUsd.toFixed(2)} of the $${task.budget_usd.toFixed(2)} budget is spent. ${task.criteria.length} criteria were frozen at intake; check which are done before spending more.`,
              usd_saved: ctx.avgTurnCostUsd * 3,
              action: { kind: "inject", label: "Ask for a criteria checkpoint", note: `Tally observed session spend at ${pct.toFixed(0)}% of the $${task.budget_usd.toFixed(2)} budget; the ${task.criteria.length} acceptance criteria frozen at intake are: ${task.criteria.map((c) => c.text).join("; ")}.` }
            });
          }
        }
        return out;
      }
    };
  }
});

// src/coach/rules/task-quality.ts
var taskQuality;
var init_task_quality = __esm({
  "src/coach/rules/task-quality.ts"() {
    "use strict";
    init_helpers();
    taskQuality = {
      id: "task-quality",
      describe: "The session has no linked task, or the spec-quality score is low",
      evaluate(ctx) {
        const out = [];
        const prompts = ctx.events.filter((e) => e.type === "prompt");
        if (!ctx.task) {
          if (prompts.length >= 1 && postTools(ctx).length >= 3) {
            out.push({
              rule: this.id,
              key: "no-task",
              severity: "info",
              title: "No task linked",
              message: "Nothing is linked to this session, so the receipt will judge against the first prompt only. Link the ticket: `tally task <url|path|text>` (a URL in the first prompt is picked up automatically).",
              usd_saved: 0,
              action: { kind: "none", label: "Run tally task <ref> in another terminal" }
            });
          }
          return out;
        }
        if (ctx.task.needs_clarification) {
          const qs = ctx.task.spec_quality.questions.slice(0, 4);
          out.push({
            rule: this.id,
            key: `vague:${ctx.task.spec_quality.score}`,
            severity: "warn",
            title: `Clarify the ticket first (spec quality ${ctx.task.spec_quality.score}/10)`,
            message: `"${ctx.task.title}" scored ${ctx.task.spec_quality.score}/10 at intake. Missing: ${ctx.task.spec_quality.missing.join("; ") || "details"}. Building on a vague spec is the most expensive kind of rework.${qs.length ? "\n  Ask: " + qs.map((q) => `
   - ${q}`).join("") : ""}`,
            usd_saved: ctx.task.budget_usd * 0.3,
            action: { kind: "inject", label: "Have Claude ask the questions before building", note: `Tally scored this task's spec ${ctx.task.spec_quality.score}/10 at intake; the open questions it recorded are: ${qs.join(" | ")}` }
          });
        }
        return out;
      }
    };
  }
});

// src/coach/rules/history-lesson.ts
var historyLesson;
var init_history_lesson = __esm({
  "src/coach/rules/history-lesson.ts"() {
    "use strict";
    historyLesson = {
      id: "history-lesson",
      describe: "Past Judge recommendations and follow-up outcomes relevant to this repo, at session start",
      evaluate(ctx) {
        const repo = ctx.cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const receipts = ctx.history.filter((h) => h.repo === repo && (h.recommendations?.length || h.final_status));
        if (!receipts.length) return [];
        const prompts = ctx.events.filter((e) => e.type === "prompt").length;
        if (prompts > 1) return [];
        const recent = receipts.slice(-5).reverse();
        const lessons = [];
        for (const r of recent) {
          if (r.final_status && r.final_status !== "held up") lessons.push(`"${r.task_title ?? "a task"}" was judged ${r.verdict} but later ${r.final_status}.`);
          for (const rec of r.recommendations ?? []) if (lessons.length < 3 && !lessons.includes(rec)) lessons.push(rec);
          if (lessons.length >= 3) break;
        }
        if (!lessons.length) return [];
        const reworkRate = receipts.filter((r) => r.final_status && r.final_status !== "held up").length / receipts.length;
        return [
          {
            rule: this.id,
            key: `history:${receipts.length}`,
            severity: "info",
            title: `${receipts.length} past receipt${receipts.length === 1 ? "" : "s"} for this repo`,
            message: `Lessons from earlier tasks here${reworkRate > 0 ? ` (${Math.round(reworkRate * 100)}% needed rework or were reverted)` : ""}:
${lessons.map((l) => `   - ${l}`).join("\n")}`,
            usd_saved: (recent[0]?.waste_usd ?? 0) * 0.5,
            action: { kind: "inject", label: "Share these lessons with Claude", note: `Tally's past receipts in this repo recorded: ${lessons.join(" ")}` }
          }
        ];
      }
    };
  }
});

// src/coach/rules/verification-consent.ts
var verificationConsent;
var init_verification_consent = __esm({
  "src/coach/rules/verification-consent.ts"() {
    "use strict";
    init_config();
    init_verify();
    verificationConsent = {
      id: "verification-consent",
      describe: "Ask once per repo whether the Judge may re-run the test suite",
      evaluate(ctx) {
        if (!ctx.cfg.judge.run_tests) return [];
        if (testRerunConsent(ctx.cfg, ctx.cwd) !== void 0) return [];
        const detected = detectTestCommand(ctx.cwd);
        if (!detected) return [];
        if (!ctx.events.some((e) => e.type === "prompt")) return [];
        return [
          {
            rule: this.id,
            key: "consent:test-rerun",
            severity: "info",
            title: "May the Judge run your tests?",
            message: `To verify claims independently, the receipt re-runs \`${detected.command}\` (${detected.basis}) in this repo with a scrubbed environment and a ${Math.round(ctx.cfg.judge.test_timeout_ms / 1e3)}s timeout. Without it, test-related criteria are marked "unverifiable (tests not run: no consent)". Asked once per repo.`,
            usd_saved: 0,
            action: { kind: "consent", label: "Allow test re-runs in this repo (skip = no)", command: detected.command }
          }
        ];
      }
    };
  }
});

// src/coach/rules/task-confirm.ts
var taskConfirm;
var init_task_confirm = __esm({
  "src/coach/rules/task-confirm.ts"() {
    "use strict";
    taskConfirm = {
      id: "task-confirm",
      describe: "Ask the user to confirm, edit, or link an inferred task",
      evaluate(ctx) {
        const t = ctx.task;
        if (!t || !t.inferred || t.confirmed) return [];
        return [
          {
            rule: this.id,
            key: `confirm:${t.cache_key ?? t.title}`,
            severity: "info",
            title: `Inferred task (unconfirmed): ${t.title}`,
            message: `No ticket was linked, so Tally inferred the task from your prompts${t.context?.branch ? `, branch "${t.context.branch}"` : ""}${t.context?.commits?.length ? ` and ${t.context.commits.length} commit(s)` : ""}:
${t.criteria.map((c) => `   - ${c.id} ${c.text}`).join("\n")}
   [c]onfirm keeps them \xB7 [e]dit rewrites the task in your words \xB7 [l]ink attaches a ticket URL (or: tally task --confirm | --edit "<text>" | --link <url>)`,
            usd_saved: t.budget_usd * 0.1,
            action: { kind: "confirm", label: "Confirm these criteria" }
          }
        ];
      }
    };
  }
});

// src/coach/rules/index.ts
var RULES;
var init_rules = __esm({
  "src/coach/rules/index.ts"() {
    "use strict";
    init_loop_detect();
    init_reread();
    init_context_pressure();
    init_claude_md();
    init_mcp_opportunity();
    init_dead_weight();
    init_mcp_errors();
    init_permission_friction();
    init_burn_rate();
    init_task_quality();
    init_history_lesson();
    init_verification_consent();
    init_task_confirm();
    RULES = [loopDetect, reread, contextPressure, claudeMd, mcpOpportunity, deadWeight, mcpErrors, permissionFriction, burnRate, taskQuality, historyLesson, verificationConsent, taskConfirm];
  }
});

// src/coach/engine.ts
import fs19 from "node:fs";
import path21 from "node:path";
function stateFile(session) {
  return path21.join(sessionDir(session), "coach-state.json");
}
function loadState(session) {
  return readJson(stateFile(session), { shown: 0, shown_keys: [], skips: {}, llm_events_seen: 0 });
}
function saveState(session, s) {
  ensureDir(sessionDir(session));
  writeJson(stateFile(session), s);
}
function loadMutes() {
  return readJson(mutesFile(), {});
}
function muteRule(cwd, rule, reason) {
  const m = loadMutes();
  const k = repoKey(cwd);
  m[k] ??= {};
  m[k][rule] = { at: (/* @__PURE__ */ new Date()).toISOString(), reason };
  writeJson(mutesFile(), m);
}
function unmuteRule(cwd, rule) {
  const m = loadMutes();
  const k = repoKey(cwd);
  if (m[k]) delete m[k][rule];
  writeJson(mutesFile(), m);
}
function isMuted(cwd, rule, mutes = loadMutes()) {
  return !!mutes[repoKey(cwd)]?.[rule];
}
function rank(suggestions) {
  return [...suggestions].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.usd_saved - a.usd_saved);
}
function readClaudeMd(cwd) {
  const p = path21.join(cwd, "CLAUDE.md");
  return fs19.existsSync(p) ? fs19.readFileSync(p, "utf8") : null;
}
var SEV_RANK, CoachEngine;
var init_engine = __esm({
  "src/coach/engine.ts"() {
    "use strict";
    init_paths();
    init_rules();
    SEV_RANK = { critical: 2, warn: 1, info: 0 };
    CoachEngine = class {
      constructor(state, cfg, rules = RULES, mutes = loadMutes()) {
        this.state = state;
        this.cfg = cfg;
        this.rules = rules;
        this.mutes = mutes;
      }
      evaluate(ctx) {
        const all = [];
        for (const r of this.rules) {
          try {
            all.push(...r.evaluate(ctx));
          } catch (err) {
            all.push({ rule: r.id, key: `rule-error:${r.id}`, severity: "info", title: `rule ${r.id} failed`, message: String(err), usd_saved: -1, action: { kind: "none", label: "" } });
          }
        }
        return all.filter((s) => s.usd_saved >= 0);
      }
      /* Noise control: at most 1 non-critical suggestion per min_interval_s and max_per_session per session;
         critical ones (loops, 85% context, over budget) always pass. Duplicate keys and muted rules never show. */
      tick(ctx, candidates = this.evaluate(ctx)) {
        const result = { show: [], held: [], suppressed: [] };
        const now = ctx.now.getTime();
        const sinceLast = this.state.last_shown_at ? (now - Date.parse(this.state.last_shown_at)) / 1e3 : Infinity;
        let quotaLeft = this.state.shown < this.cfg.coach.max_per_session;
        let intervalOk = sinceLast >= this.cfg.coach.min_interval_s;
        for (const s of rank(candidates)) {
          if (isMuted(ctx.cwd, s.rule, this.mutes)) {
            result.suppressed.push({ suggestion: s, why: "muted" });
            continue;
          }
          if (this.state.shown_keys.includes(s.key)) {
            result.suppressed.push({ suggestion: s, why: "already shown" });
            continue;
          }
          const critical = s.severity === "critical";
          if (!critical && (!quotaLeft || !intervalOk || result.show.some((x) => x.severity !== "critical"))) {
            result.held.push(s);
            continue;
          }
          result.show.push({ ...s, ts: ctx.now.toISOString() });
          this.state.shown_keys.push(s.key);
          if (!critical) {
            this.state.shown += 1;
            this.state.last_shown_at = ctx.now.toISOString();
            quotaLeft = this.state.shown < this.cfg.coach.max_per_session;
            intervalOk = false;
          }
        }
        return result;
      }
      recordSkip(cwd, rule) {
        const n = (this.state.skips[rule] ?? 0) + 1;
        this.state.skips[rule] = n;
        if (n >= this.cfg.coach.auto_mute_after_skips) {
          muteRule(cwd, rule, `skipped ${n} times`);
          this.mutes[repoKey(cwd)] ??= {};
          this.mutes[repoKey(cwd)][rule] = { at: (/* @__PURE__ */ new Date()).toISOString(), reason: `skipped ${n} times` };
          return { muted: true, skips: n };
        }
        return { muted: false, skips: n };
      }
      llmAllowed(now, eventsCount, minNewEvents = 5) {
        const since = this.state.llm_last_at ? (now.getTime() - Date.parse(this.state.llm_last_at)) / 1e3 : Infinity;
        return since >= this.cfg.coach.llm_interval_s && eventsCount - this.state.llm_events_seen >= minNewEvents;
      }
      markLlm(now, eventsCount) {
        this.state.llm_last_at = now.toISOString();
        this.state.llm_events_seen = eventsCount;
      }
    };
  }
});

// src/coach/context.ts
import fs20 from "node:fs";
function loadHistory() {
  const f = historyFile();
  if (!fs20.existsSync(f)) return [];
  const out = [];
  for (const line of fs20.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.internal || isInternalCwd(e.repo)) continue;
      out.push(e);
    } catch {
    }
  }
  return out;
}
function buildContext(opts) {
  const events = opts.events ?? readEvents(opts.session);
  let transcript = opts.transcript;
  if (!transcript && opts.transcriptPath && fs20.existsSync(opts.transcriptPath)) {
    try {
      transcript = parseTranscriptFile(opts.transcriptPath);
    } catch {
      transcript = void 0;
    }
  }
  const startEv = events.find((e) => e.type === "session_start");
  const loaded = startEv?.data.loaded ?? { mcp: [], skills: [], plugins: [] };
  const mainMsgs = transcript?.messages.filter((m) => m.agent === "main") ?? [];
  const avgTurnCostUsd = mainMsgs.length ? mainMsgs.reduce((s, m) => s + m.cost, 0) / mainMsgs.length : 0.15;
  const model = String(startEv?.data.model ?? mainMsgs[0]?.model ?? "");
  const contextWindow = isModel1M(model) || (transcript?.contextTokensNow ?? 0) > opts.cfg.context_window ? 1e6 : opts.cfg.context_window;
  const lastTs = events.at(-1)?.ts ?? transcript?.endedAt;
  return {
    session: opts.session,
    cwd: opts.cwd,
    now: opts.now ?? (lastTs ? new Date(Math.max(Date.parse(lastTs), Date.now() - 365 * 24 * 3600 * 1e3)) : /* @__PURE__ */ new Date()),
    cfg: opts.cfg,
    events,
    transcript,
    task: loadTask(opts.session),
    history: opts.history ?? loadHistory(),
    claudeMd: readClaudeMd(opts.cwd),
    avgTurnCostUsd,
    contextTokensNow: transcript?.contextTokensNow ?? 0,
    contextWindow,
    spendUsd: transcript?.cost ?? 0,
    loaded
  };
}
var init_context = __esm({
  "src/coach/context.ts"() {
    "use strict";
    init_paths();
    init_events();
    init_parse();
    init_intake();
    init_pricing();
    init_engine();
  }
});

// src/coach/inject.ts
import fs21 from "node:fs";
import path22 from "node:path";
function injectFile(session) {
  return path22.join(sessionDir(session), "inject.jsonl");
}
function enqueueInject(session, note, source, cwd) {
  ensureDir(sessionDir(session));
  const item = { ts: (/* @__PURE__ */ new Date()).toISOString(), note: note.trim(), source };
  appendLine(injectFile(session), JSON.stringify(item));
  appendEvent({ ts: item.ts, type: "inject", session, cwd, data: { source, note: item.note.slice(0, 300) } });
  return item;
}
function readInjects(session) {
  const f = injectFile(session);
  if (!fs21.existsSync(f)) return [];
  return fs21.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((x) => !!x);
}
function pendingInjects(session) {
  return readInjects(session).filter((i) => !i.delivered);
}
var init_inject = __esm({
  "src/coach/inject.ts"() {
    "use strict";
    init_paths();
    init_events();
  }
});

// src/coach/undo.ts
import fs22 from "node:fs";
import path23 from "node:path";
function recordChange(entry) {
  const e = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry };
  appendLine(undoLog(), JSON.stringify(e));
  return e;
}
function readUndoLog() {
  const f = undoLog();
  if (!fs22.existsSync(f)) return [];
  const byId = /* @__PURE__ */ new Map();
  for (const line of fs22.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.undone_marker) {
        const t = byId.get(e.undone_marker);
        if (t) t.undone = true;
      } else byId.set(e.id, e);
    } catch {
    }
  }
  return [...byId.values()];
}
function undoLast(n = 1) {
  const entries = readUndoLog().filter((e) => !e.undone).reverse().slice(0, n);
  const done = [];
  for (const e of entries) {
    const current = fs22.existsSync(e.file) ? fs22.readFileSync(e.file, "utf8") : null;
    if (current !== e.after) {
      if (current !== null) fs22.writeFileSync(e.file + `.tally-undo-${e.id}.bak`, current);
    }
    if (e.before === null) {
      if (fs22.existsSync(e.file)) fs22.unlinkSync(e.file);
    } else {
      ensureDir(path23.dirname(e.file));
      fs22.writeFileSync(e.file, e.before);
    }
    appendLine(undoLog(), JSON.stringify({ undone_marker: e.id, ts: (/* @__PURE__ */ new Date()).toISOString() }));
    done.push({ ...e, undone: true });
  }
  return done;
}
var init_undo = __esm({
  "src/coach/undo.ts"() {
    "use strict";
    init_paths();
  }
});

// src/coach/actions.ts
import fs23 from "node:fs";
import path24 from "node:path";
function isAutoApplicable(s) {
  if (s.action.kind === "inject") return true;
  if (s.action.kind === "confirm") return false;
  if (s.action.kind === "write_md") return /\.md$/i.test(s.action.file);
  return false;
}
function applySuggestion(s, opts) {
  const a = s.action;
  if (opts.mode === "auto" && !isAutoApplicable(s)) return { ok: false, detail: "settings and MCP changes require ask mode" };
  let result;
  switch (a.kind) {
    case "write_md": {
      if (!/\.md$/i.test(a.file)) return { ok: false, detail: "only .md files can be written by Coach" };
      const before = fs23.existsSync(a.file) ? fs23.readFileSync(a.file, "utf8") : null;
      if (a.mode === "create" && before !== null) return { ok: false, detail: `${path24.basename(a.file)} already exists` };
      const after = a.mode === "append" ? (before ?? "") + (before && !before.endsWith("\n") ? "\n" : "") + a.content : a.content;
      ensureDir(path24.dirname(a.file));
      fs23.writeFileSync(a.file, after);
      recordChange({ session: opts.session, rule: s.rule, label: a.label, file: a.file, before, after });
      result = { ok: true, detail: `${a.mode === "append" ? "appended to" : before === null ? "created" : "rewrote"} ${path24.relative(opts.cwd, a.file) || a.file}`, file: a.file };
      break;
    }
    case "inject": {
      enqueueInject(opts.session, a.note, s.rule, opts.cwd);
      result = { ok: true, detail: "note queued; Claude sees it on the next turn", injected: true };
      break;
    }
    case "snippet": {
      const dir = path24.join(tallyHome(), "snippets");
      ensureDir(dir);
      const f = path24.join(dir, `${s.key.replace(/[^a-z0-9]+/gi, "-")}.txt`);
      fs23.writeFileSync(f, `${a.snippet}
# ${a.where}
`);
      result = { ok: true, detail: `snippet saved to ${f}
    ${a.snippet}
    (${a.where})`, file: f };
      break;
    }
    case "settings": {
      const before = fs23.existsSync(a.file) ? fs23.readFileSync(a.file, "utf8") : null;
      let current = {};
      if (before) {
        try {
          current = JSON.parse(before);
        } catch {
          return { ok: false, detail: `${a.file} is not valid JSON; not touching it` };
        }
      }
      const merged = mergePatch(current, a.patch);
      const after = JSON.stringify(merged, null, 2) + "\n";
      ensureDir(path24.dirname(a.file));
      fs23.writeFileSync(a.file, after);
      recordChange({ session: opts.session, rule: s.rule, label: a.label, file: a.file, before, after });
      result = { ok: true, detail: `updated ${path24.relative(opts.cwd, a.file) || a.file} (undo with \`tally undo\`)`, file: a.file };
      break;
    }
    case "confirm": {
      const t = confirmTask(opts.session);
      result = t ? { ok: true, detail: `task confirmed: "${t.title}" (${t.criteria.length} criteria)` } : { ok: false, detail: "no task to confirm" };
      break;
    }
    case "consent": {
      setTestRerunConsent(opts.cwd, true);
      result = { ok: true, detail: `test re-runs allowed in this repo (\`${a.command}\`); revoke with: tally config consent off` };
      break;
    }
    default:
      result = { ok: false, detail: "nothing to apply for this suggestion" };
  }
  if (result.ok && s.inject_note && a.kind !== "inject") {
    enqueueInject(opts.session, s.inject_note, s.rule, opts.cwd);
    result.injected = true;
  }
  appendEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), type: "apply", session: opts.session, cwd: opts.cwd, data: { rule: s.rule, key: s.key, action: a.kind, label: a.label, ok: result.ok, detail: result.detail.slice(0, 200), mode: opts.mode } });
  return result;
}
function injectSuggestion(s, opts) {
  const note = s.action.kind === "inject" ? s.action.note : s.inject_note ?? `Tally observed: ${s.title}. ${s.message.split("\n")[0]}`;
  enqueueInject(opts.session, note, s.rule, opts.cwd);
  return { ok: true, detail: "note queued; Claude sees it on the next turn", injected: true };
}
function skipSuggestion(s, opts) {
  appendEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), type: "skip", session: opts.session, cwd: opts.cwd, data: { rule: s.rule, key: s.key } });
  if (s.action.kind === "consent") setTestRerunConsent(opts.cwd, false);
}
function mergePatch(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (Array.isArray(v)) {
      const arr = Array.isArray(prev) ? [...prev] : [];
      for (const item of v) if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(item))) arr.push(item);
      out[k] = arr;
    } else if (v && typeof v === "object") {
      out[k] = mergePatch(prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {}, v);
    } else out[k] = v;
  }
  return out;
}
var init_actions = __esm({
  "src/coach/actions.ts"() {
    "use strict";
    init_config();
    init_events();
    init_paths();
    init_inject();
    init_intake();
    init_undo();
  }
});

// src/coach/llm-coach.ts
var llm_coach_exports = {};
__export(llm_coach_exports, {
  COACH_SCHEMA: () => COACH_SCHEMA,
  COACH_SYSTEM: () => COACH_SYSTEM,
  llmCoach: () => llmCoach,
  summarizeRecent: () => summarizeRecent
});
function summarizeRecent(ctx, n = 15) {
  const recent = ctx.events.filter((e) => e.type === "post_tool" || e.type === "prompt" || e.type === "stop").slice(-n);
  return recent.map((e) => {
    if (e.type === "prompt") return `USER: ${String(e.data.prompt ?? "").slice(0, 200)}`;
    if (e.type === "stop") return `CLAUDE: ${String(e.data.last_assistant_message ?? "").slice(0, 200)}`;
    const inp = toolInput(e);
    const what = inp.command ?? inp.file_path ?? inp.pattern ?? inp.url ?? "";
    return `${toolName(e)} ${String(what).slice(0, 120)}${e.data.is_error ? " -> ERROR" : ""}`;
  }).join("\n");
}
async function llmCoach(ctx, llm) {
  const criteria = ctx.task?.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n") ?? "(no linked task)";
  const prompt = `TASK: ${ctx.task?.title ?? "(none)"}
CRITERIA:
${criteria}

SPEND SO FAR: $${ctx.spendUsd.toFixed(2)} of $${ctx.task?.budget_usd.toFixed(2) ?? "?"}

RECENT ACTIVITY (oldest first):
${summarizeRecent(ctx)}`;
  const r = await llm.complete({ kind: "coach", model: ctx.cfg.models.coach, system: COACH_SYSTEM, prompt, schema: COACH_SCHEMA, timeoutMs: 6e4 });
  const o = r.data;
  if (!o?.has_suggestion || !o.message) return null;
  return {
    rule: "llm-coach",
    key: `llm:${(o.title ?? o.message).slice(0, 40)}`,
    severity: o.severity === "warn" ? "warn" : "info",
    title: o.title ?? "Coach",
    message: o.message,
    usd_saved: Math.max(0, Number(o.usd_saved ?? 0)),
    action: { kind: "inject", label: "Share with Claude", note: /^Tally observed/i.test(o.inject_note ?? "") ? o.inject_note : `Tally observed: ${o.inject_note ?? o.message}` }
  };
}
var COACH_SYSTEM, COACH_SCHEMA;
var init_llm_coach = __esm({
  "src/coach/llm-coach.ts"() {
    "use strict";
    init_helpers();
    COACH_SYSTEM = `You are a terse pair-programming coach watching a Claude Code session from the outside. You see the task's acceptance criteria and the last few tool calls.
Return at most ONE suggestion, and only if it would clearly save money or prevent rework right now. Otherwise return has_suggestion=false. Never restate what the deterministic rules already cover: loops, re-reads, context size, budget, MCP errors, missing CLAUDE.md.
Good suggestions: a criterion is being ignored, the approach contradicts the ticket, tests are being skipped, scope is creeping, a simpler path exists.
usd_saved is your honest estimate in dollars. Keep message under 40 words. inject_note is a factual observation for Claude's context, starting with "Tally observed", never an instruction or a command, under 60 words.`;
    COACH_SCHEMA = {
      type: "object",
      properties: {
        has_suggestion: { type: "boolean" },
        title: { type: "string" },
        message: { type: "string" },
        inject_note: { type: "string" },
        severity: { type: "string", enum: ["info", "warn"] },
        usd_saved: { type: "number" }
      },
      required: ["has_suggestion"]
    };
  }
});

// src/coach/ui.ts
import fs24 from "node:fs";
import readline2 from "node:readline";
function paint(color, code, s) {
  return color ? `${code}${s}${C.reset}` : s;
}
function renderHeader(ctx, color = true) {
  const task = ctx.task;
  const pct = ctx.contextWindow ? Math.round(ctx.contextTokensNow / ctx.contextWindow * 100) : 0;
  const budget = task?.budget_usd ?? 0;
  const spendStr = budget ? `${fmtUsd(ctx.spendUsd)} / ${fmtUsd(budget)} (${Math.round(ctx.spendUsd / budget * 100)}%)` : fmtUsd(ctx.spendUsd);
  const lines = [
    paint(color, C.bold, `Tally Coach`) + paint(color, C.gray, `  session ${ctx.session.slice(0, 8)}  ${ctx.cwd}`),
    `${paint(color, C.cyan, "task")}  ${task ? `${task.title}  ${paint(color, C.gray, `spec ${task.spec_quality.score}/10, ${task.criteria.length} criteria`)}` : paint(color, C.yellow, "none linked (tally task <url|path|text>)")}`,
    `${paint(color, C.cyan, "spend")} ${spendStr} API-equivalent   ${paint(color, C.cyan, "context")} ${pct}%   ${paint(color, C.cyan, "tools")} ${ctx.events.filter((e) => e.type === "post_tool").length}`
  ];
  return lines.join("\n");
}
function renderSuggestion(s, color = true, index) {
  const sev = s.severity === "critical" ? paint(color, C.red, "!! ") : s.severity === "warn" ? paint(color, C.yellow, " ! ") : paint(color, C.blue, " \xB7 ");
  const saved = s.usd_saved > 0 ? paint(color, C.gray, `  ~${fmtUsd(s.usd_saved)} at stake`) : "";
  const head = `${sev}${paint(color, C.bold, s.title)}${saved}${index !== void 0 ? paint(color, C.gray, `  #${index}`) : ""}`;
  const body = s.message.split("\n").map((l) => `    ${l}`).join("\n");
  const act = s.action.kind === "none" ? "" : `
    ${paint(color, C.gray, `[a]pply: ${s.action.label}`)}`;
  const keys = s.action.kind === "confirm" ? "[c]onfirm  [e]dit  [l]ink  [s]kip" : "[a]pply  [i]nject  [s]kip  [m]ute rule";
  return `${head}
${body}${act}
    ${paint(color, C.gray, keys)}`;
}
async function watch(opts) {
  const out = opts.output ?? process.stdout;
  const color = opts.color ?? !!out.isTTY;
  const w = (s) => out.write(s + "\n");
  const engine = new CoachEngine(loadState(opts.session), opts.cfg);
  const tail = new EventTail(eventsFile(opts.session));
  let events = readEvents(opts.session);
  tail.poll();
  let transcript;
  let transcriptSize = -1;
  let transcriptPath = transcriptPathFor(opts.session);
  let pending = [];
  let ticks = 0;
  const mode = opts.cfg.auto_apply;
  const refreshTranscript = () => {
    transcriptPath ??= transcriptPathFor(opts.session);
    if (!transcriptPath || !fs24.existsSync(transcriptPath)) return;
    const size = fs24.statSync(transcriptPath).size;
    if (size === transcriptSize) return;
    transcriptSize = size;
    try {
      transcript = parseTranscriptFile(transcriptPath);
    } catch {
    }
  };
  const makeCtx = () => buildContext({ session: opts.session, cwd: opts.cwd, cfg: opts.cfg, events, transcript, now: opts.now?.() });
  const readLine = (question) => new Promise((resolve) => {
    const inp = opts.input ?? process.stdin;
    if (!inp.isTTY) return resolve("");
    const rl = readline2.createInterface({ input: inp, output: out });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  const handle = async (s, key, ctx2) => {
    if (s.action.kind === "confirm" && (key === "c" || key === "a")) {
      const r = applySuggestion(s, { session: opts.session, cwd: opts.cwd, cfg: opts.cfg, mode: "ask" });
      w(paint(color, r.ok ? C.green : C.red, `    \u2192 ${r.detail}`));
      saveState(opts.session, engine.state);
      return;
    }
    if (s.action.kind === "confirm" && (key === "e" || key === "l")) {
      const answer = await readLine(key === "e" ? "    Describe the task in your words: " : "    Ticket URL: ");
      if (!answer) {
        w(paint(color, C.gray, "    \u2192 nothing entered; task left unconfirmed"));
        return;
      }
      const r = await intake({ session: opts.session, cwd: opts.cwd, ref: key === "l" ? answer : void 0, text: key === "e" ? answer : void 0, cfg: opts.cfg, llm: opts.llm ?? makeLlm({ session: opts.session }), force: true });
      if (key === "e") confirmTask(opts.session);
      w(paint(color, C.green, `    \u2192 task ${key === "l" ? "linked" : "rewritten and confirmed"}: "${r.task.title}" (${r.task.criteria.length} criteria)`));
      saveState(opts.session, engine.state);
      return;
    }
    if (key === "a") {
      const r = applySuggestion(s, { session: opts.session, cwd: opts.cwd, cfg: opts.cfg, mode: "ask" });
      w(paint(color, r.ok ? C.green : C.red, `    \u2192 ${r.ok ? "applied" : "not applied"}: ${r.detail}`));
    } else if (key === "i") {
      const r = injectSuggestion(s, { session: opts.session, cwd: opts.cwd });
      w(paint(color, C.green, `    \u2192 ${r.detail}`));
    } else if (key === "s") {
      skipSuggestion(s, { session: opts.session, cwd: opts.cwd });
      const r = engine.recordSkip(opts.cwd, s.rule);
      w(paint(color, C.gray, `    \u2192 skipped${r.muted ? ` (rule ${s.rule} muted for this repo after ${r.skips} skips)` : ""}`));
    } else if (key === "m") {
      if (s.action.kind === "consent") setTestRerunConsent(opts.cwd, false);
      muteRule(opts.cwd, s.rule, "muted by user");
      w(paint(color, C.gray, `    \u2192 rule ${s.rule} muted for this repo (tally config unmute ${s.rule})`));
    }
    saveState(opts.session, engine.state);
  };
  const readKey = () => new Promise((resolve) => {
    const inp = opts.input ?? process.stdin;
    if (!inp.isTTY) {
      resolve("");
      return;
    }
    inp.setRawMode?.(true);
    inp.resume();
    const onData = (d) => {
      inp.off("data", onData);
      inp.setRawMode?.(false);
      inp.pause();
      const k = d.toString("utf8");
      if (k === "" || k === "q") {
        w("");
        process.exit(0);
      }
      resolve(k.toLowerCase());
    };
    inp.on("data", onData);
  });
  refreshTranscript();
  let ctx = makeCtx();
  w(renderHeader(ctx, color));
  w(paint(color, C.gray, `mode: ${mode} \xB7 rules: deterministic first, LLM (${opts.cfg.models.coach}) at most every ${opts.cfg.coach.llm_interval_s}s once the session passes $${opts.cfg.coach.llm_min_session_usd} \xB7 q to quit`));
  w("");
  for (; ; ) {
    ticks += 1;
    const fresh = tail.poll();
    if (fresh.length) events = events.concat(fresh);
    refreshTranscript();
    ctx = makeCtx();
    const result = engine.tick(ctx);
    let shown = result.show;
    if (opts.llm && ctx.spendUsd >= opts.cfg.coach.llm_min_session_usd && engine.llmAllowed(ctx.now, events.length) && !shown.length && events.some((e) => e.type === "post_tool")) {
      engine.markLlm(ctx.now, events.length);
      try {
        const s = await llmCoach(ctx, opts.llm);
        if (s) shown = engine.tick(ctx, [s]).show;
      } catch (err) {
        w(paint(color, C.gray, `    (coach llm unavailable: ${String(err).slice(0, 80)})`));
      }
    }
    for (const s of shown) {
      pending.push(s);
      w(renderSuggestion(s, color));
      if (mode === "auto" && (s.action.kind === "write_md" || s.action.kind === "inject")) {
        const r = applySuggestion(s, { session: opts.session, cwd: opts.cwd, cfg: opts.cfg, mode: "auto" });
        w(paint(color, r.ok ? C.green : C.red, `    \u2192 auto-applied: ${r.detail}`));
        pending = pending.filter((p) => p !== s);
        continue;
      }
      if (mode === "off") {
        pending = pending.filter((p) => p !== s);
        continue;
      }
      if (opts.once) continue;
      const key = await readKey();
      if (key) await handle(s, key, ctx);
      pending = pending.filter((p) => p !== s);
      w("");
    }
    saveState(opts.session, engine.state);
    if (events.some((e) => e.type === "session_end") && ticks > 1) {
      w(paint(color, C.gray, "session ended; the receipt will appear via `tally judge` shortly."));
      return;
    }
    if (opts.once || opts.maxTicks && ticks >= opts.maxTicks) return;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
  }
}
function statusLine(session, cwd, cfg, color = false) {
  const ctx = buildContext({ session, cwd, cfg, transcriptPath: transcriptPathFor(session) });
  const task = loadTask(session);
  return renderHeader({ ...ctx, task }, color);
}
var C;
var init_ui = __esm({
  "src/coach/ui.ts"() {
    "use strict";
    init_config();
    init_events();
    init_parse();
    init_pricing();
    init_context();
    init_engine();
    init_actions();
    init_llm_coach();
    init_session();
    init_intake();
    init_client();
    C = {
      reset: "\x1B[0m",
      bold: "\x1B[1m",
      dim: "\x1B[2m",
      red: "\x1B[31m",
      green: "\x1B[32m",
      yellow: "\x1B[33m",
      blue: "\x1B[34m",
      cyan: "\x1B[36m",
      gray: "\x1B[90m"
    };
  }
});

// src/commands/watch.ts
var watch_exports = {};
__export(watch_exports, {
  run: () => run6
});
async function run6(args) {
  const cfg = loadConfig();
  const session = resolveSession(args._[0] ?? flag(args, "session"), process.cwd());
  if (!session) {
    process.stderr.write("No active session. Start Claude Code in a repo with Tally hooks installed, then run `tally watch` again.\n");
    return 1;
  }
  const cwd = sessionCwd(session) ?? process.cwd();
  const active = activeSessions().find((s) => s.id === session);
  if (!active && !has(args, "force")) process.stdout.write(`(session ${session.slice(0, 8)} is not marked active; watching anyway)
`);
  await watch({ session, cwd, cfg, llm: has(args, "no-llm") ? void 0 : makeLlm({ session }), color: !has(args, "plain") });
}
var init_watch = __esm({
  "src/commands/watch.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_client();
    init_session();
    init_ui();
  }
});

// src/commands/start.ts
var start_exports = {};
__export(start_exports, {
  run: () => run7,
  startPlan: () => startPlan
});
import { spawnSync as spawnSync6 } from "node:child_process";
function binExists(bin) {
  const r = spawnSync6(process.platform === "win32" ? "where.exe" : "which", [bin], { stdio: "ignore", windowsHide: true });
  return r.status === 0;
}
function startPlan(env = process.env, platform = process.platform, plain = false, exists = binExists) {
  const cmd = `tally watch${plain ? " --plain" : ""}`;
  if (env.TMUX && exists("tmux")) return { kind: "tmux-split", argv: ["tmux", "split-window", "-h", "-l", "45%", cmd], message: "Opened the Coach pane in tmux. Start or continue your Claude Code session in the left pane.", cmd };
  if (platform !== "win32" && exists("tmux")) return { kind: "tmux-new", argv: ["tmux", "new-session", "-d", "-s", "tally", "claude", ";", "split-window", "-h", "-l", "45%", cmd, ";", "select-pane", "-L"], message: 'Created tmux session "tally" with Claude Code on the left and the Coach on the right. Attach with: tmux attach -t tally', cmd };
  if (platform === "win32" && env.WT_SESSION && exists("wt")) return { kind: "wt-split", argv: ["wt", "-w", "0", "split-pane", "-V", "--size", "0.45", "cmd", "/k", cmd], message: "Opened the Coach pane in Windows Terminal next to this one.", cmd };
  return { kind: "print", message: `No tmux${platform === "win32" ? " or Windows Terminal split" : ""} available. Open a second terminal next to Claude Code and run:

    ${cmd}

It attaches to the latest active session automatically.`, cmd };
}
async function run7(args) {
  const plan = startPlan(process.env, process.platform, has(args, "plain"));
  if (plan.argv) {
    const [bin, ...rest] = plan.argv;
    const r = spawnSync6(bin, rest, { stdio: "inherit", windowsHide: false });
    if (r.status === 0) {
      process.stdout.write(plan.message + "\n");
      return;
    }
    process.stdout.write(`Could not open a split (${bin} exited ${r.status}). Run this in a second terminal:

    ${plan.cmd}
`);
    return;
  }
  process.stdout.write(plan.message + "\n");
}
var init_start = __esm({
  "src/commands/start.ts"() {
    "use strict";
    init_cli();
  }
});

// src/commands/statusline.ts
var statusline_exports = {};
__export(statusline_exports, {
  flagsFile: () => flagsFile,
  readFlags: () => readFlags,
  renderStatusLine: () => renderStatusLine,
  run: () => run8
});
import fs25 from "node:fs";
import path25 from "node:path";
function flagsFile(session) {
  return path25.join(sessionDir(session), "coach-flags.json");
}
function readFlags(session) {
  const f = flagsFile(session);
  if (!fs25.existsSync(f)) return { pending: [] };
  try {
    return JSON.parse(fs25.readFileSync(f, "utf8"));
  } catch {
    return { pending: [] };
  }
}
function renderStatusLine(input, color = true) {
  const paint2 = (code, s) => color ? `${code}${s}${C2.reset}` : s;
  const session = input.session_id;
  const task = session ? loadTask(session) : null;
  const judge = session ? loadJudge(session) : null;
  const flags = session ? readFlags(session).pending.length : 0;
  const spend = input.cost?.total_cost_usd ?? 0;
  const parts = [paint2(C2.dim, "Tally")];
  if (task) {
    const title = task.title.length > 34 ? task.title.slice(0, 33) + "\u2026" : task.title;
    parts.push(`${title}${task.inferred && !task.confirmed ? paint2(C2.dim, " (unconfirmed)") : ""}`);
    const pct = task.budget_usd ? Math.round(spend / task.budget_usd * 100) : null;
    const budgetStr = pct === null ? fmtUsd(spend) : `${fmtUsd(spend)}/${fmtUsd(task.budget_usd)} (${pct}%)`;
    parts.push(pct !== null && pct >= 100 ? paint2(C2.red, budgetStr) : pct !== null && pct >= 80 ? paint2(C2.yellow, budgetStr) : budgetStr);
  } else {
    parts.push(paint2(C2.dim, `no task linked \xB7 ${fmtUsd(spend)}`));
  }
  const ctx = input.context_window?.used_percentage;
  if (typeof ctx === "number") parts.push(ctx >= 85 ? paint2(C2.red, `ctx ${Math.round(ctx)}%`) : ctx >= 70 ? paint2(C2.yellow, `ctx ${Math.round(ctx)}%`) : `ctx ${Math.round(ctx)}%`);
  if (flags) parts.push(paint2(C2.cyan, `${flags} coach flag${flags === 1 ? "" : "s"} (/tally:coach)`));
  if (judge) parts.push(paint2(judge.verdict.verdict === "worth it" ? C2.green : judge.verdict.verdict === "not worth it" ? C2.red : C2.yellow, `receipt: ${judge.completion_pct}% \xB7 ${judge.verdict.verdict}`));
  return parts.join(paint2(C2.dim, " \xB7 "));
}
async function run8(args) {
  if (has(args, "install")) {
    const r = installStatusLine({ force: has(args, "force") });
    process.stdout.write(r.installed ? `Status line installed in ${r.file}: ${r.command}
Restart Claude Code (or start a new session) to see it.
` : `${r.reason}
`);
    return r.installed ? 0 : 1;
  }
  if (has(args, "uninstall")) {
    const r = uninstallStatusLine();
    process.stdout.write(r.removed ? `Status line removed from ${settingsPath("user")}
` : "No Tally status line configured.\n");
    return;
  }
  let raw = "";
  try {
    raw = fs25.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  if (!raw.trim()) {
    process.stdout.write(`tally statusline reads Claude Code's status-line JSON on stdin. Install it with: tally statusline --install
(settings.json \u2192 "statusLine": { "type": "command", "command": "node \\"${builtCliPath().replace(/\\/g, "/")}\\" statusline" })
`);
    return;
  }
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  process.stdout.write(renderStatusLine(input, !has(args, "plain")) + "\n");
}
var C2;
var init_statusline = __esm({
  "src/commands/statusline.ts"() {
    "use strict";
    init_cli();
    init_intake();
    init_judge();
    init_paths();
    init_install();
    init_pricing();
    C2 = { reset: "\x1B[0m", dim: "\x1B[2m", red: "\x1B[31m", yellow: "\x1B[33m", cyan: "\x1B[36m", green: "\x1B[32m" };
  }
});

// src/commands/coach.ts
var coach_exports = {};
__export(coach_exports, {
  run: () => run9
});
async function run9(args) {
  const cfg = loadConfig();
  const session = resolveSession(flag(args, "session"), process.cwd());
  if (!session) {
    process.stderr.write("No session found.\n");
    return 1;
  }
  const cwd = flag(args, "cwd") || sessionCwd(session) || process.cwd();
  const color = !has(args, "plain");
  const ctx = buildContext({ session, cwd, cfg, transcriptPath: transcriptPathFor(session) });
  const engine = new CoachEngine(loadState(session), cfg);
  if (has(args, "tick")) {
    const result2 = engine.tick(ctx);
    let shown = result2.show;
    if (!shown.length && ctx.spendUsd >= cfg.coach.llm_min_session_usd && engine.llmAllowed(ctx.now, ctx.events.length) && ctx.events.some((e) => e.type === "post_tool")) {
      engine.markLlm(ctx.now, ctx.events.length);
      try {
        const s = await llmCoach(ctx, makeLlm({ session }));
        if (s) shown = engine.tick(ctx, [s]).show;
      } catch {
      }
    }
    const flags = readFlags(session);
    for (const s of result2.held) if ((s.action.kind === "confirm" || s.action.kind === "consent") && !flags.pending.some((f) => f.key === s.key)) flags.pending.push({ rule: s.rule, key: s.key, title: s.title, usd_saved: s.usd_saved, label: s.action.label });
    let injected = 0;
    for (const s of shown) {
      if (s.action.kind === "inject") {
        injectSuggestion(s, { session, cwd });
        injected += 1;
      } else if (!flags.pending.some((f) => f.key === s.key)) flags.pending.push({ rule: s.rule, key: s.key, title: s.title, usd_saved: s.usd_saved, ts: s.ts, label: s.action.label });
    }
    writeJson(flagsFile(session), { pending: flags.pending, updated: (/* @__PURE__ */ new Date()).toISOString() });
    saveState(session, engine.state);
    if (!has(args, "auto")) process.stdout.write(`autopilot: ${shown.length} suggestion(s), ${injected} queued for Claude's next turn, ${flags.pending.length} flag(s) on the status line
`);
    return;
  }
  const all = engine.evaluate(ctx);
  const applyIdx = flag(args, "apply");
  const injectIdx = flag(args, "inject");
  if (applyIdx !== void 0 || injectIdx !== void 0) {
    const idx = Number(applyIdx ?? injectIdx) - 1;
    const s = all[idx];
    if (!s) {
      process.stderr.write(`No suggestion #${idx + 1}. Run \`tally coach --once\` to list them.
`);
      return 1;
    }
    const r = applyIdx !== void 0 ? applySuggestion(s, { session, cwd, cfg, mode: "ask" }) : injectSuggestion(s, { session, cwd });
    if (r.ok) {
      const flags = readFlags(session);
      writeJson(flagsFile(session), { pending: flags.pending.filter((f) => f.key !== s.key), updated: (/* @__PURE__ */ new Date()).toISOString() });
    }
    process.stdout.write(`${r.ok ? "ok" : "failed"}: ${r.detail}
`);
    return r.ok ? 0 : 1;
  }
  process.stdout.write(renderHeader(ctx, color) + "\n\n");
  if (!all.length) {
    process.stdout.write("No suggestions right now.\n");
    return;
  }
  const result = engine.tick(ctx, all);
  const list = has(args, "all") ? all : [...result.show, ...result.held];
  list.forEach((s, i) => process.stdout.write(renderSuggestion(s, color, i + 1) + "\n\n"));
  if (!has(args, "all")) saveState(session, engine.state);
  process.stdout.write(`Act on one: tally coach --apply <#> | --inject <#>   (or run \`tally watch\` for the live pane)
`);
}
var init_coach = __esm({
  "src/commands/coach.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_session();
    init_context();
    init_engine();
    init_ui();
    init_actions();
    init_llm_coach();
    init_client();
    init_statusline();
    init_paths();
  }
});

// src/commands/undo.ts
var undo_exports = {};
__export(undo_exports, {
  run: () => run10
});
async function run10(args) {
  if (has(args, "list")) {
    const entries = readUndoLog().reverse().slice(0, 20);
    if (!entries.length) {
      process.stdout.write("Nothing to undo.\n");
      return;
    }
    for (const e of entries) process.stdout.write(`${e.undone ? "(undone) " : ""}${e.ts}  ${e.rule}  ${e.label}  ${e.file}
`);
    return;
  }
  const n = Math.max(1, Number(args._[0] ?? 1) || 1);
  const done = undoLast(n);
  if (!done.length) {
    process.stdout.write("Nothing to undo.\n");
    return;
  }
  for (const e of done) process.stdout.write(`Reverted ${e.label} (${e.file})${e.before === null ? " \u2014 file removed" : ""}
`);
}
var init_undo2 = __esm({
  "src/commands/undo.ts"() {
    "use strict";
    init_cli();
    init_undo();
  }
});

// src/experiment/report.ts
function mean2(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function armStats(exp, arm) {
  const sessions = exp.assignments.filter((a) => a.arm === arm);
  const judged = sessions.map((a) => loadJudge(a.session)).filter((j) => !!j);
  const completion = judged.map((j) => j.completion_pct);
  const cpc = judged.map((j) => j.cost.per_completed_criterion_usd).filter((x) => x !== null);
  const followed = judged.filter((j) => j.followup && j.followup.final_status !== "unknown");
  const rework = followed.map((j) => j.followup.final_status === "held up" ? 0 : 1);
  return {
    arm,
    sessions: sessions.length,
    judged: judged.length,
    completion_pct: mean2(completion),
    cost_per_criterion_usd: mean2(cpc),
    rework_rate: mean2(rework),
    followed_up: followed.length
  };
}
function buildReport(exp) {
  const on = armStats(exp, "on");
  const off = armStats(exp, "off");
  const enough = on.judged >= MIN_PER_ARM && off.judged >= MIN_PER_ARM;
  let verdict;
  if (!enough) {
    verdict = `not enough data: ${on.judged} judged task(s) with ${exp.name} on, ${off.judged} off; need at least ${MIN_PER_ARM} each. ${Math.max(0, exp.tasks_total - exp.assignments.length)} task(s) still to run.`;
  } else {
    const dComp = (on.completion_pct ?? 0) - (off.completion_pct ?? 0);
    const dCost = on.cost_per_criterion_usd !== null && off.cost_per_criterion_usd !== null ? on.cost_per_criterion_usd - off.cost_per_criterion_usd : null;
    const parts = [`completion ${dComp >= 0 ? "+" : ""}${dComp.toFixed(1)} pts with it on`];
    if (dCost !== null) parts.push(`cost per criterion ${dCost >= 0 ? "+" : ""}$${dCost.toFixed(2)}`);
    if (on.rework_rate !== null && off.rework_rate !== null) parts.push(`rework ${((on.rework_rate - off.rework_rate) * 100).toFixed(0)} pts`);
    const helps = dComp > 5 || dCost !== null && dCost < -0.5 && dComp >= -2;
    const hurts = dComp < -5 || dCost !== null && dCost > 0.5 && dComp <= 2;
    verdict = `${helps ? `${exp.name} appears to help` : hurts ? `${exp.name} appears to hurt` : `no clear difference from ${exp.name}`} (${parts.join(", ")}; n=${on.judged}+${off.judged}, small samples are noisy).`;
  }
  return { experiment: exp, arms: { on, off }, enough_data: enough, verdict, min_per_arm: MIN_PER_ARM };
}
function renderExperimentReport(r) {
  const f = (x, suffix = "", digits = 1) => x === null ? "n/a" : `${x.toFixed(digits)}${suffix}`;
  const L = [];
  L.push(`Experiment: ${r.experiment.kind} "${r.experiment.name}" \xB7 ${r.experiment.assignments.length}/${r.experiment.tasks_total} tasks assigned${r.experiment.stopped_at ? " (stopped)" : ""}`);
  L.push("");
  L.push(`arm   sessions  judged  completion  cost/criterion  rework`);
  for (const a of [r.arms.on, r.arms.off]) L.push(`${a.arm.padEnd(5)} ${String(a.sessions).padStart(8)}  ${String(a.judged).padStart(6)}  ${f(a.completion_pct, "%").padStart(10)}  ${(a.cost_per_criterion_usd === null ? "n/a" : "$" + a.cost_per_criterion_usd.toFixed(2)).padStart(14)}  ${a.rework_rate === null ? "n/a" : `${(a.rework_rate * 100).toFixed(0)}% (${a.followed_up} followed up)`}`);
  L.push("");
  L.push(r.verdict);
  return L.join("\n");
}
var MIN_PER_ARM;
var init_report2 = __esm({
  "src/experiment/report.ts"() {
    "use strict";
    init_judge();
    MIN_PER_ARM = 3;
  }
});

// src/commands/experiment.ts
var experiment_exports = {};
__export(experiment_exports, {
  run: () => run11
});
async function run11(args) {
  const sub = args._[0];
  const cwd = process.cwd();
  if (sub === "start") {
    const kind = args._[1];
    const name = args._[2];
    const tasks = Number(flag(args, "tasks") ?? 6);
    if (kind !== "skill" && kind !== "mcp" || !name || !Number.isFinite(tasks) || tasks < 2) {
      process.stderr.write("Usage: tally experiment start <skill|mcp> <name> --tasks N\n");
      return 1;
    }
    const exp = startExperiment(cwd, kind, name, tasks);
    process.stdout.write(`Started experiment ${exp.id}: ${kind} "${name}" alternates off/on across the next ${tasks} tasks in this repo.
The next session starts with it ${exp.next_arm.toUpperCase()} (.claude/settings.local.json is patched now and restored byte-identically at each session end).
Run \`tally experiment report\` after a few judged tasks.
`);
    return;
  }
  if (sub === "stop") {
    const exp = stopExperiment(cwd);
    process.stdout.write(exp ? `Stopped ${exp.id}; settings restored.
` : "No active experiment in this repo.\n");
    return;
  }
  if (sub === "report" || sub === "status" || !sub) {
    const key = repoKey(cwd);
    const all = loadExperiments().experiments.filter((e) => e.repo === key);
    const target = flag(args, "id") ? all.find((e) => e.id === flag(args, "id")) : activeExperiment(cwd) ?? all.at(-1);
    if (!target) {
      process.stdout.write("No experiments in this repo. Start one: tally experiment start <skill|mcp> <name> --tasks 6\n");
      return;
    }
    process.stdout.write(renderExperimentReport(buildReport(target)) + "\n");
    if (all.length > 1) process.stdout.write(`
(${all.length} experiments in this repo; pass --id <id> for another)
`);
    return;
  }
  process.stderr.write("Usage: tally experiment start|report|stop\n");
  return 1;
}
var init_experiment2 = __esm({
  "src/commands/experiment.ts"() {
    "use strict";
    init_cli();
    init_experiment();
    init_report2();
    init_paths();
  }
});

// src/report/report.ts
function mean3(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function latestReceipts(entries) {
  const bySession = /* @__PURE__ */ new Map();
  for (const e of entries) if (e.verdict && e.session) bySession.set(e.session, e);
  return [...bySession.values()].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
}
function computeTrend(opts = {}) {
  const all = opts.history ?? loadHistory();
  const cutoff = opts.days ? Date.now() - opts.days * 864e5 : 0;
  const inScope = all.filter((e) => !e.internal && (!opts.repo || e.repo === opts.repo) && (!cutoff || Date.parse(e.ts ?? "") >= cutoff));
  const receipts = latestReceipts(inScope);
  const sessions = inScope.filter((e) => e.kind === "session");
  const followed = receipts.filter((r) => r.final_status && r.final_status !== "unknown");
  const verdicts = {};
  for (const r of receipts) verdicts[r.final_verdict ?? r.verdict ?? "?"] = (verdicts[r.final_verdict ?? r.verdict ?? "?"] ?? 0) + 1;
  const half = Math.floor(receipts.length / 2);
  const prior = receipts.slice(0, half);
  const recent = receipts.slice(half);
  const names = /* @__PURE__ */ new Map();
  for (const r of receipts) {
    const used = /* @__PURE__ */ new Set([...(r.skills ?? []).map((s) => `skill:${s}`), ...(r.mcp ?? []).map((m) => `mcp:${m.split(":")[0]}`)]);
    for (const k of used) names.set(k, names.get(k) ?? { kind: k.startsWith("skill") ? "skill" : "mcp", with: [], without: [] });
  }
  for (const [k, v] of names) {
    for (const r of receipts) {
      const used = /* @__PURE__ */ new Set([...(r.skills ?? []).map((s) => `skill:${s}`), ...(r.mcp ?? []).map((m) => `mcp:${m.split(":")[0]}`)]);
      (used.has(k) ? v.with : v.without).push(r);
    }
  }
  const payoff = [...names.entries()].map(([k, v]) => ({
    kind: v.kind,
    name: k.split(":").slice(1).join(":"),
    used_in: v.with.length,
    completion_with: mean3(v.with.map((r) => r.completion_pct ?? 0)),
    completion_without: mean3(v.without.map((r) => r.completion_pct ?? 0)),
    cpc_with: mean3(v.with.map((r) => r.per_criterion_usd).filter((x) => typeof x === "number")),
    cpc_without: mean3(v.without.map((r) => r.per_criterion_usd).filter((x) => typeof x === "number"))
  })).sort((a, b) => b.used_in - a.used_in);
  const recCount = /* @__PURE__ */ new Map();
  for (const r of receipts) for (const rec of r.recommendations ?? []) recCount.set(rec, (recCount.get(rec) ?? 0) + 1);
  return {
    tasks: receipts.length,
    sessions: sessions.length,
    cost_per_task_usd: mean3(receipts.map((r) => r.cost_usd ?? 0)),
    cost_per_criterion_usd: mean3(receipts.map((r) => r.per_criterion_usd).filter((x) => typeof x === "number")),
    completion_pct: mean3(receipts.map((r) => r.completion_pct ?? 0)),
    rework_rate: followed.length ? followed.filter((r) => r.final_status !== "held up").length / followed.length : null,
    followed_up: followed.length,
    waste_usd: mean3(receipts.map((r) => r.waste_usd ?? 0)),
    linked_rate: receipts.length ? receipts.filter((r) => r.linked).length / receipts.length : null,
    verdicts,
    recent_vs_prior: half > 0 ? { recent_cost: mean3(recent.map((r) => r.cost_usd ?? 0)), prior_cost: mean3(prior.map((r) => r.cost_usd ?? 0)), recent_completion: mean3(recent.map((r) => r.completion_pct ?? 0)), prior_completion: mean3(prior.map((r) => r.completion_pct ?? 0)) } : null,
    payoff,
    top_recommendations: [...recCount.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    by_task_source: ["linked", "confirmed", "inferred"].map((source) => {
      const rs = receipts.filter((r) => (r.task_source ?? (r.linked ? "linked" : "inferred")) === source);
      const fu = rs.filter((r) => r.final_status && r.final_status !== "unknown");
      return { source, tasks: rs.length, completion_pct: mean3(rs.map((r) => r.completion_pct ?? 0)), cost_per_task_usd: mean3(rs.map((r) => r.cost_usd ?? 0)), rework_rate: fu.length ? fu.filter((r) => r.final_status !== "held up").length / fu.length : null };
    }).filter((x) => x.tasks > 0)
  };
}
function renderTrend(t, opts = {}) {
  const L = [];
  const f = (x, fn) => x === null ? "n/a" : fn(x);
  L.push(`Tally report${opts.repo ? ` \xB7 ${opts.repo}` : " \xB7 all repos"}${opts.days ? ` \xB7 last ${opts.days} days` : ""}`);
  L.push(`${t.tasks} judged task(s) across ${t.sessions} session(s)`);
  if (!t.tasks) {
    L.push("No receipts yet. Link a task with `tally task <url>` and ship; the receipt appears on push.");
    return L.join("\n");
  }
  L.push("");
  L.push(`cost per task        ${f(t.cost_per_task_usd, fmtUsd)} API-equivalent`);
  L.push(`cost per criterion   ${f(t.cost_per_criterion_usd, fmtUsd)}`);
  L.push(`completion           ${f(t.completion_pct, (n) => n.toFixed(0) + "%")}`);
  L.push(`waste per task       ${f(t.waste_usd, fmtUsd)}`);
  L.push(`rework rate          ${t.rework_rate === null ? `n/a (${t.followed_up} followed up)` : `${(t.rework_rate * 100).toFixed(0)}% of ${t.followed_up} followed up`}`);
  L.push(`tasks linked         ${f(t.linked_rate, (n) => (n * 100).toFixed(0) + "%")}`);
  L.push(`verdicts             ${Object.entries(t.verdicts).map(([k, v]) => `${k} ${v}`).join(" \xB7 ")}`);
  if (t.recent_vs_prior) {
    const r = t.recent_vs_prior;
    L.push(`trend                cost ${f(r.prior_cost, fmtUsd)} \u2192 ${f(r.recent_cost, fmtUsd)}, completion ${f(r.prior_completion, (n) => n.toFixed(0) + "%")} \u2192 ${f(r.recent_completion, (n) => n.toFixed(0) + "%")} (older half \u2192 newer half)`);
  }
  if (t.by_task_source.length > 1) {
    L.push("");
    L.push("By task source (linked ticket vs inferred from prompts)");
    for (const s of t.by_task_source) L.push(`  ${s.source.padEnd(10)} ${String(s.tasks).padStart(3)} task(s)  completion ${f(s.completion_pct, (n) => n.toFixed(0) + "%")}  cost/task ${f(s.cost_per_task_usd, fmtUsd)}  rework ${f(s.rework_rate, (n) => (n * 100).toFixed(0) + "%")}`);
  }
  if (t.payoff.length) {
    L.push("");
    L.push("Skill / MCP payoff (correlational; run `tally experiment` for a controlled answer)");
    L.push("kind   name                        used  completion with/without   cost per criterion with/without");
    for (const p of t.payoff.slice(0, 12)) {
      L.push(`${p.kind.padEnd(6)} ${p.name.slice(0, 27).padEnd(27)} ${String(p.used_in).padStart(4)}  ${f(p.completion_with, (n) => n.toFixed(0) + "%").padStart(6)} / ${f(p.completion_without, (n) => n.toFixed(0) + "%").padEnd(6)}          ${f(p.cpc_with, fmtUsd).padStart(7)} / ${f(p.cpc_without, fmtUsd)}`);
    }
  }
  if (t.top_recommendations.length) {
    L.push("");
    L.push("Most repeated recommendations");
    for (const r of t.top_recommendations) L.push(`  ${r.count}\xD7 ${r.text}`);
  }
  const exps = loadExperiments().experiments.filter((e) => !opts.repo || e.repo === opts.repo);
  if (exps.length) {
    L.push("");
    L.push("Experiments");
    for (const e of exps.slice(-3)) L.push("  " + renderExperimentReport(buildReport(e)).split("\n").join("\n  "));
  }
  return L.join("\n");
}
var init_report3 = __esm({
  "src/report/report.ts"() {
    "use strict";
    init_context();
    init_pricing();
    init_experiment();
    init_report2();
  }
});

// src/commands/report.ts
var report_exports = {};
__export(report_exports, {
  run: () => run12
});
async function run12(args) {
  const repo = has(args, "all") ? void 0 : flag(args, "repo") ?? (has(args, "here") ? repoKey(process.cwd()) : void 0);
  const days = flag(args, "days") ? Number(flag(args, "days")) : void 0;
  const t = computeTrend({ repo, days });
  if (has(args, "json")) {
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderTrend(t, { repo, days }) + "\n");
}
var init_report4 = __esm({
  "src/commands/report.ts"() {
    "use strict";
    init_cli();
    init_report3();
    init_paths();
  }
});

// src/commands/doctor.ts
var doctor_exports = {};
__export(doctor_exports, {
  run: () => run13,
  runChecks: () => runChecks,
  transcriptFormatCheck: () => transcriptFormatCheck
});
import fs26 from "node:fs";
import path26 from "node:path";
import { spawnSync as spawnSync7 } from "node:child_process";
function sh(bin, args) {
  const r = process.platform === "win32" ? spawnSync7(`${bin} ${args.join(" ")}`, { encoding: "utf8", shell: true, windowsHide: true, timeout: 15e3 }) : spawnSync7(bin, args, { encoding: "utf8", windowsHide: true, timeout: 15e3 });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}
function runChecks() {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: major >= 18, detail: `v${process.versions.node}${major >= 18 ? "" : " (need >= 18)"}` });
  const claude = sh("claude", ["--version"]);
  checks.push({ name: "claude", ok: claude.ok, detail: claude.ok ? claude.out.split("\n")[0] : "not found on PATH; Tally needs the Claude Code CLI for judge/intake calls" });
  if (claude.ok) {
    const r = resolveClaudeBin();
    checks.push({ name: "claude -p launcher", ok: true, detail: r.prefix.length ? `resolved shim \u2192 ${r.prefix[0]}` : r.bin });
  }
  const gh = ghStatus();
  checks.push({ name: "gh", ok: gh.ok ? true : "warn", detail: gh.ok ? "authenticated" : `${gh.reason}. Fix: ${gh.fix}. Until then GitHub intake falls back to the prompt text, write-back and follow-up are skipped and say so.` });
  const user = isInstalled("user");
  const project = isInstalled("project", process.cwd());
  const settings = readJson(path26.join(claudeHome(), "settings.json"), {});
  const plugin = Object.entries(settings.enabledPlugins ?? {}).some(([k, v]) => v && k.startsWith("tally"));
  const ways = [user && "user settings", project && "project settings", plugin && "plugin"].filter(Boolean);
  checks.push({ name: "hooks", ok: ways.length === 1 ? true : ways.length === 0 ? false : "warn", detail: ways.length === 0 ? `not installed; run \`tally install\` or /plugin install tally@tally (${settingsPath("user")})` : ways.length === 1 ? `installed via ${ways[0]}` : `installed ${ways.length} ways (${ways.join(", ")}); tool events are de-duplicated by tool_use_id but prompts and stops are recorded twice. Keep one: \`tally uninstall\` removes the settings hooks, /plugin uninstall tally removes the plugin` });
  const referenced = [];
  for (const f of [settingsPath("user"), settingsPath("project", process.cwd())]) {
    const st = readJson(f, {});
    for (const groups of Object.values(st.hooks ?? {})) for (const g of groups) for (const h of g.hooks ?? []) if (isTallyHook(h)) referenced.push((h.args?.[0] ?? /"([^"]+hook\.js)"/.exec(h.command ?? "")?.[1] ?? "").replace(/^\$\{CLAUDE_PLUGIN_ROOT\}.*/, ""));
  }
  const missing = [...new Set(referenced.filter((p) => p && !fs26.existsSync(p)))];
  if (referenced.length) checks.push({ name: "hook script", ok: missing.length ? false : true, detail: missing.length ? `${missing.join(", ")} does not exist; every hook event is failing (non-blocking). Run \`tally install\` to repoint the hooks at ${builtHookPath()}` : `${[...new Set(referenced)].join(", ")} exists` });
  const hook = builtHookPath();
  fs26.mkdirSync(tallyHome(), { recursive: true });
  if (fs26.existsSync(hook)) {
    const t0 = Date.now();
    const r = spawnSync7(process.execPath, [hook, "Stop"], { input: "{}", encoding: "utf8", env: { ...process.env, TALLY_HOME: fs26.mkdtempSync(path26.join(tallyHome(), "doctor-")) } });
    const ms = Date.now() - t0;
    checks.push({ name: "hook runtime", ok: r.status === 0 && ms < 150 ? true : r.status === 0 ? "warn" : false, detail: `exit ${r.status}, ${ms} ms (limit 150)` });
    for (const d of fs26.readdirSync(tallyHome()).filter((x) => x.startsWith("doctor-"))) fs26.rmSync(path26.join(tallyHome(), d), { recursive: true, force: true });
  } else {
    checks.push({ name: "hook runtime", ok: false, detail: "dist/hook.js missing; run npm run build" });
  }
  try {
    fs26.mkdirSync(tallyHome(), { recursive: true });
    fs26.accessSync(tallyHome(), fs26.constants.W_OK);
    checks.push({ name: "data dir", ok: true, detail: tallyHome() });
  } catch {
    checks.push({ name: "data dir", ok: false, detail: `${tallyHome()} not writable` });
  }
  const cfgRaw = readJson(configFile(), null);
  const cfgOk = cfgRaw === null || ConfigSchema.safeParse(cfgRaw).success;
  const cfg = loadConfig();
  checks.push({ name: "config", ok: cfgOk, detail: cfgOk ? `hourly_rate $${cfg.hourly_rate}, judge ${cfg.models.judge}, coach ${cfg.models.coach}, auto_apply ${cfg.auto_apply}, writeback ${cfg.writeback}` : `${configFile()} is invalid; defaults in use` });
  const pricing = loadPricing();
  const age = (Date.now() - Date.parse(pricing.last_verified)) / 864e5;
  checks.push({ name: "pricing", ok: age < 60 ? true : "warn", detail: `${fs26.existsSync(pricingFile()) ? pricingFile() : bundledPricingPath()} verified ${pricing.last_verified} (${Math.round(age)} days ago${age >= 60 ? "; re-check against the pricing page" : ""})` });
  const jira = !!(cfg.jira.base_url && cfg.jira.email && cfg.jira.api_token);
  checks.push({ name: "jira", ok: jira ? true : "warn", detail: jira ? cfg.jira.base_url : "JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set (optional)" });
  checks.push({ name: "linear", ok: cfg.linear.api_key ? true : "warn", detail: cfg.linear.api_key ? "LINEAR_API_KEY set" : "LINEAR_API_KEY not set (optional)" });
  const tmux = sh(process.platform === "win32" ? "where" : "which", ["tmux"]);
  checks.push({ name: "tmux", ok: tmux.ok ? true : "warn", detail: tmux.ok ? "available; `tally start` opens a split" : "not found; `tally start` prints the command to run in a second terminal" });
  const transcripts = path26.join(claudeHome(), "projects");
  checks.push({ name: "transcripts", ok: fs26.existsSync(transcripts) ? true : "warn", detail: fs26.existsSync(transcripts) ? transcripts : `${transcripts} not found yet (created by Claude Code on first session)` });
  const active = activeSessions();
  checks.push({ name: "sessions", ok: true, detail: `${active.length} active` });
  const receipts = loadHistory().filter((h) => typeof h.tally_share_pct === "number");
  if (receipts.length) {
    const avg = receipts.reduce((s, h) => s + (h.tally_share_pct ?? 0), 0) / receipts.length;
    checks.push({ name: "tally overhead", ok: avg <= 5 ? true : "warn", detail: `Tally's own LLM spend averages ${avg.toFixed(1)}% of session spend over ${receipts.length} receipt(s)${avg > 5 ? "; above the 5% target \u2014 use a smaller judge model (tally config models.judge sonnet) or judge less often" : ""}` });
  } else {
    checks.push({ name: "tally overhead", ok: true, detail: "no receipts yet; the share of session spend is reported on each receipt" });
  }
  checks.push(transcriptFormatCheck(process.cwd()));
  const internalDirs = fs26.existsSync(transcripts) ? fs26.readdirSync(transcripts).filter((d) => isInternalCwd(d)).length : 0;
  if (internalDirs) checks.push({ name: "internal runs", ok: true, detail: `${internalDirs} empty project dir(s) from Tally's own headless runs under ~/.claude/projects (no transcripts; safe to delete)` });
  return checks;
}
function transcriptFormatCheck(cwd) {
  const dirs = [projectTranscriptsDir(cwd), path26.join(claudeHome(), "projects")];
  const files = [];
  for (const d of dirs) {
    if (!fs26.existsSync(d)) continue;
    const entries = fs26.readdirSync(d).map((f) => path26.join(d, f));
    for (const e of entries) {
      if (e.endsWith(".jsonl")) files.push(e);
      else if (fs26.statSync(e).isDirectory() && !isInternalCwd(e)) {
        for (const f of fs26.readdirSync(e)) if (f.endsWith(".jsonl")) files.push(path26.join(e, f));
      }
    }
    if (files.length) break;
  }
  const recent = files.map((f) => ({ f, m: fs26.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 5);
  if (!recent.length) return { name: "transcript format", ok: "warn", detail: "no transcripts found to check" };
  let unparseable = 0;
  let total = 0;
  const versions = /* @__PURE__ */ new Set();
  const unknownTypes = /* @__PURE__ */ new Set();
  let unknownVersion = false;
  for (const { f } of recent) {
    try {
      const t = parseTranscriptFile(f);
      unparseable += t.format.unparseable_lines;
      total += t.format.total_lines;
      if (t.format.version) versions.add(t.format.version);
      if (!t.format.known) unknownVersion = true;
      for (const u of t.format.unknown_types) unknownTypes.add(u);
    } catch {
      unparseable += 1;
    }
  }
  const ok = unparseable === 0 && !unknownVersion ? true : "warn";
  return {
    name: "transcript format",
    ok,
    detail: `${recent.length} recent transcript(s), Claude Code ${[...versions].join(", ") || "unknown"}${unknownVersion ? " (not a verified layout; costs will be marked partial)" : ""}, ${unparseable}/${total} unparseable lines${unknownTypes.size ? `, unknown line types: ${[...unknownTypes].join(", ")}` : ""}`
  };
}
async function run13(args) {
  const checks = runChecks();
  const color = !has(args, "plain");
  const mark = (ok) => ok === true ? color ? "\x1B[32m\u2714\x1B[0m" : "ok  " : ok === "warn" ? color ? "\x1B[33m!\x1B[0m" : "warn" : color ? "\x1B[31m\u2718\x1B[0m" : "FAIL";
  for (const c of checks) process.stdout.write(`${mark(c.ok)} ${c.name.padEnd(18)} ${c.detail}
`);
  const failed = checks.filter((c) => c.ok === false).length;
  process.stdout.write(failed ? `
${failed} problem(s).
` : "\nAll good.\n");
  return failed ? 1 : 0;
}
var init_doctor = __esm({
  "src/commands/doctor.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_paths();
    init_pricing();
    init_install();
    init_session();
    init_client();
    init_context();
    init_parse();
    init_paths();
    init_gh();
  }
});

// src/demo/demo.ts
import fs27 from "node:fs";
import os3 from "node:os";
import path27 from "node:path";
import { spawnSync as spawnSync8 } from "node:child_process";
import { fileURLToPath as fileURLToPath3 } from "node:url";
function fixturesDir() {
  for (const c of [path27.join(here2, "fixtures", "session-basic"), path27.join(here2, "..", "..", "test", "fixtures", "session-basic"), path27.join(here2, "..", "fixtures", "session-basic")]) if (fs27.existsSync(c)) return c;
  throw new Error("fixtures not found; run from a source checkout");
}
function git(cwd, ...args) {
  const r = spawnSync8("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeRepo(root) {
  const cwd = path27.join(root, "acme-app");
  fs27.mkdirSync(path27.join(cwd, "src"), { recursive: true });
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "demo@tally.local");
  git(cwd, "config", "user.name", "tally demo");
  fs27.writeFileSync(path27.join(cwd, "package.json"), JSON.stringify({ name: "acme-app", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2));
  fs27.writeFileSync(path27.join(cwd, "test.js"), `const login = require('./src/login');
if (login(6) !== 429) { console.error('expected 429 after 5 attempts'); process.exit(1); }
console.log('ok: 429 after 5 attempts');
`);
  fs27.writeFileSync(path27.join(cwd, "src", "login.js"), `module.exports = function login(attempts) { return 200; };
`);
  fs27.writeFileSync(path27.join(cwd, "README.md"), "# acme-app\n\nExpress API.\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  return { cwd, base };
}
function applyWork(cwd) {
  fs27.writeFileSync(path27.join(cwd, "src", "rateLimit.js"), `const MAX = 5;
module.exports = function rateLimit(attempts) { return attempts > MAX; };
`);
  fs27.writeFileSync(path27.join(cwd, "src", "login.js"), `const rateLimit = require('./rateLimit');
module.exports = function login(attempts) { return rateLimit(attempts) ? 429 : 200; };
`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "add rate limiting to login (#57)");
}
function hookPayload(e, session, cwd, transcriptPath) {
  const base = { session_id: session, cwd, transcript_path: transcriptPath };
  switch (e.type) {
    case "session_start":
      return { event: "SessionStart", input: { ...base, hook_event_name: "SessionStart", source: "startup", model: e.data.model } };
    case "prompt":
      return { event: "UserPromptSubmit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: e.data.prompt } };
    case "pre_tool":
      return { event: "PreToolUse", input: { ...base, hook_event_name: "PreToolUse", tool_name: e.data.tool_name, tool_input: e.data.tool_input, tool_use_id: e.data.tool_use_id, ...e.data.agent ? { agent_id: e.data.agent } : {} } };
    case "post_tool": {
      const head = String(e.data.response_head ?? "");
      const resp = e.data.is_error && !/^Error/.test(head) ? `Error: ${head}` : head;
      return { event: e.data.is_error ? "PostToolUseFailure" : "PostToolUse", input: { ...base, hook_event_name: "PostToolUse", tool_name: e.data.tool_name, tool_input: e.data.tool_input, tool_use_id: e.data.tool_use_id, tool_response: resp, ...e.data.agent ? { agent_id: e.data.agent } : {} } };
    }
    case "stop":
      return { event: "Stop", input: { ...base, hook_event_name: "Stop", last_assistant_message: e.data.last_assistant_message } };
    case "pre_compact":
      return { event: "PreCompact", input: { ...base, hook_event_name: "PreCompact", trigger: e.data.trigger } };
    case "session_end":
      return { event: "SessionEnd", input: { ...base, hook_event_name: "SessionEnd", reason: e.data.reason } };
    default:
      return null;
  }
}
async function runDemo(opts = {}) {
  const out = opts.out ?? ((s) => process.stdout.write(s + "\n"));
  const color = opts.color ?? !!process.stdout.isTTY;
  const bold = (s) => paint(color, "\x1B[1m", s);
  const dim = (s) => paint(color, "\x1B[90m", s);
  const green = (s) => paint(color, "\x1B[32m", s);
  const yellow = (s) => paint(color, "\x1B[33m", s);
  const cyan = (s) => paint(color, "\x1B[36m", s);
  const step = (n, s) => out(`
${bold(cyan(`[${n}] ${s}`))}`);
  const home = opts.home ?? fs27.mkdtempSync(path27.join(os3.tmpdir(), "tally-demo-"));
  const prev = { TALLY_HOME: process.env.TALLY_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TALLY_NO_SPAWN: process.env.TALLY_NO_SPAWN, TALLY_LLM: process.env.TALLY_LLM };
  process.env.TALLY_HOME = path27.join(home, "tally");
  process.env.CLAUDE_CONFIG_DIR = path27.join(home, "claude");
  process.env.TALLY_NO_SPAWN = "1";
  process.env.TALLY_LLM = "stub";
  fs27.mkdirSync(process.env.TALLY_HOME, { recursive: true });
  fs27.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  try {
    const fx = fixturesDir();
    const session = "demo-" + Date.now().toString(36);
    const { cwd, base } = makeRepo(home);
    const cfg = loadConfig();
    cfg.coach.min_interval_s = 180;
    const hook = builtHookPath();
    ensureDir(sessionDir(session));
    const transcriptPath = path27.join(sessionDir(session), "transcript.jsonl");
    fs27.copyFileSync(path27.join(fx, "transcript.jsonl"), transcriptPath);
    out(bold("Tally demo") + dim(`  isolated data dir: ${process.env.TALLY_HOME}`));
    out(dim(`  fake repo: ${cwd}  \xB7  real ~/.claude and ~/.tally are not touched  \xB7  LLM calls are stubbed`));
    const repo = repoKey(cwd);
    const priorHistory = [
      ...[1, 2, 3].map((i) => ({ ts: `2026-09-0${i}T10:00:00Z`, kind: "session", session: `prior-${i}`, repo, loaded: { mcp: ["github", "jira", "postgres"], skills: ["superpowers:test-driven-development", "deploy-checklist"], plugins: ["superpowers"] }, used: { skills: ["superpowers:test-driven-development"], mcp: ["github"] }, first_turn_tokens: 41e3, cost_usd: 2.1 })),
      { ts: "2026-09-03T12:00:00Z", session: "prior-3", repo, task_title: "Add password reset", verdict: "worth it", final_status: "needed rework", final_verdict: "borderline", completion_pct: 75, cost_usd: 3.2, waste_usd: 0.9, recommendations: ["Run the full test suite once before pushing instead of after each edit.", "Read the ticket checklist before declaring done."], linked: true }
    ];
    for (const h of priorHistory) appendLine(historyFile(), JSON.stringify(h));
    step(1, "Task intake (stubbed intake model)");
    const llm = new StubLlm(
      {
        intake: () => ({
          title: "Rate limit the login endpoint",
          criteria: [
            { text: "POST /api/login returns 429 after 5 failed attempts from one IP within 15 minutes", source: "explicit" },
            { text: "A test covers the 429 path", source: "explicit" },
            { text: "README documents the limit", source: "explicit" },
            { text: "Existing login behaviour is unchanged below the limit", source: "inferred" }
          ],
          spec_quality: { score: 4, missing: ["what counts as a failed attempt", "whether a successful login resets the counter", "per-IP vs per-account"], questions: ["Does a successful login reset the counter?", "Should the limit be per IP, per account, or both?", "Is 429 the agreed status code?"] },
          estimate_hours: 3,
          rationale: "middleware plus test plus docs"
        }),
        judge: () => ({
          criteria: [
            { id: "c1", status: "met", evidence: "src/rateLimit.js returns true above 5 attempts and src/login.js maps it to 429; independent `npm test` passed.", files: ["src/login.js", "src/rateLimit.js"] },
            { id: "c2", status: "met", evidence: "test.js asserts 429 after 6 attempts; the auditor ran it and it passed.", files: ["test.js"] },
            { id: "c3", status: "unmet", evidence: 'README.md is unchanged in the diff; the assistant said "I did not update the README".', files: [] },
            { id: "c4", status: "unverifiable", evidence: "No test exercises attempts below the limit; nothing in the diff contradicts it.", files: [] }
          ],
          quality_score: 7,
          quality_reason: 'Small, focused change with a test. The limiter has no window expiry, so the "15 minutes" part is not enforced.',
          verdict_reason: "Two of four criteria are met with an independent green test run, one is unmet and one unverifiable, so 50% completion. Spend is well inside the budget and the ROI is comfortably above 2\xD7, but the README criterion was skipped and stated as skipped, and $0.60 of the $1.33 went into three identical failing test runs.",
          recommendations: ["When `npm test` fails twice with the same assertion, read the test before editing the implementation again; the third run cost $0.20 for no new information.", "Read the ticket checklist before saying done: the README item was explicit and skipped.", "Stop calling the Jira MCP after the first 401; three retries burned three turns."]
        }),
        coach: () => ({ has_suggestion: true, title: "Window expiry missing", message: "The limiter never expires old attempts; the ticket says 15 minutes.", inject_note: "The ticket says the 5-attempt limit applies within a 15-minute window; the current limiter never expires attempts. Add the window before finishing.", severity: "warn", usd_saved: 3 })
      },
      session
    );
    const { task } = await intake({ session, cwd, ref: path27.join(fx, "task.md"), cfg, llm });
    out(renderTask(task));
    if (task.needs_clarification) out(yellow('  \u26A0 Spec quality below 5: Coach will say "Clarify the ticket first" and list the questions.'));
    step(2, "Replaying the session through the real hooks, with the Coach watching");
    out(dim("  each fixture event is fed to dist/hook.js on stdin; the Coach ticks on simulated time"));
    const events = readEventsFile(path27.join(fx, "events.jsonl")).filter((e) => e.type !== "ship");
    const engine = new CoachEngine(loadState(session), cfg, void 0, {});
    let shown = 0;
    const applied = [];
    const injected = [];
    let shipDetected = false;
    let lastPromptDelivery = "";
    let llmCalls = 0;
    let transcriptCut = 0;
    const transcriptLines = fs27.readFileSync(path27.join(fx, "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
    const permissionEvents = [];
    const handle = (s, now) => {
      shown += 1;
      out(renderSuggestion(s, color));
      const canApply = s.action.kind === "write_md" || s.action.kind === "settings";
      if (canApply && applied.length === 0) {
        const r = applySuggestion(s, { session, cwd, cfg, mode: "ask" });
        out(green(`    \u2192 [a] applied: ${r.detail}`));
        applied.push(s.rule);
      } else if ((s.action.kind === "inject" || s.inject_note) && injected.length === 0) {
        const r = injectSuggestion(s, { session, cwd });
        out(green(`    \u2192 [i] injected: ${r.detail}`));
        injected.push(s.rule);
      } else {
        out(dim("    \u2192 [s] skipped"));
      }
    };
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const now = new Date(e.ts);
      const payload = hookPayload(e, session, cwd, transcriptPath);
      if (!payload) continue;
      if (e.type === "session_start") {
        const fakeSettings = path27.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
        fs27.writeFileSync(fakeSettings, JSON.stringify({ enabledPlugins: { "superpowers@official": true } }));
      }
      const r = spawnSync8(process.execPath, [hook, payload.event], { input: JSON.stringify(payload.input), encoding: "utf8", env: { ...process.env }, windowsHide: true });
      if (r.status !== 0) out(yellow(`  hook ${payload.event} exited ${r.status}`));
      if (e.type === "prompt") {
        out(`  ${dim(now.toISOString().slice(11, 19))} ${bold("user>")} ${String(e.data.prompt).slice(0, 90)}`);
        if (r.stdout.includes("Tally:")) {
          lastPromptDelivery = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
          out(green(`  \u21B3 hook delivered to Claude: ${lastPromptDelivery.split("\n")[0].slice(0, 110)}`));
        }
      } else if (e.type === "session_start" && r.stdout.includes("Tally:")) {
        out(green(`  \u21B3 SessionStart hook injected history lessons: ${JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split("\n")[1]?.slice(0, 100)}`));
      } else if (e.type === "post_tool") {
        const inp = e.data.tool_input;
        const what = String(inp.command ?? inp.file_path ?? inp.pattern ?? inp.skill ?? "").replace(/\\/g, "/").slice(-60);
        out(`  ${dim(now.toISOString().slice(11, 19))} ${dim(String(e.data.tool_name))} ${dim(what)}${e.data.is_error ? yellow(" \u2718") : ""}`);
        if (String(e.data.tool_name) === "Bash" && /git push/.test(String(inp.command)) && !e.data.is_error) {
          shipDetected = readEvents(session).some((x) => x.type === "ship");
          if (shipDetected) out(green("  \u21B3 ship detected (git push): judge scheduled in the background"));
        }
        if (/npm test/.test(String(inp.command)) && e.data.is_error && permissionEvents.length < 2) {
          const pe = { ts: e.ts, type: "permission", session, cwd, data: { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash(npm test)" } };
          spawnSync8(process.execPath, [hook, "Notification"], { input: JSON.stringify({ session_id: session, cwd, hook_event_name: "Notification", notification_type: "permission_prompt", message: pe.data.message }), encoding: "utf8", env: { ...process.env }, windowsHide: true });
          permissionEvents.push(pe);
        }
      }
      while (transcriptCut < transcriptLines.length) {
        const ts = JSON.parse(transcriptLines[transcriptCut]).timestamp ?? "";
        if (ts && ts > e.ts) break;
        transcriptCut += 1;
      }
      fs27.writeFileSync(transcriptPath, transcriptLines.slice(0, Math.max(transcriptCut, 1)).join("\n") + "\n");
      const ctx = buildContext({ session, cwd, cfg, now, transcriptPath });
      const tick = engine.tick(ctx);
      for (const s of tick.show) handle(s, now);
      if (!tick.show.length && engine.llmAllowed(now, ctx.events.length) && ctx.events.filter((x) => x.type === "post_tool").length > 8 && llmCalls < 1) {
        engine.markLlm(now, ctx.events.length);
        llmCalls += 1;
        const { llmCoach: llmCoach2 } = await Promise.resolve().then(() => (init_llm_coach(), llm_coach_exports));
        const s = await llmCoach2(ctx, llm);
        if (s) for (const x of engine.tick(ctx, [s]).show) handle(x, now);
      }
      saveState(session, engine.state);
      if (!opts.fast) await new Promise((res) => setTimeout(res, 15));
    }
    fs27.copyFileSync(path27.join(fx, "transcript.jsonl"), transcriptPath);
    out(dim(`  ${shown} suggestions shown (noise limits: 1 non-critical per ${cfg.coach.min_interval_s}s, ${cfg.coach.max_per_session} per session; critical always)`));
    step(3, "Judge (stubbed judge model, real git diff, real independent test run)");
    applyWork(cwd);
    const events2 = readEvents(session).map((e) => e.type === "session_start" ? { ...e, data: { ...e.data, git_head: base } } : e);
    setTestRerunConsent(cwd, true);
    out(dim("  consent: test re-runs allowed for the demo repo (in real use the Coach asks once per repo)"));
    const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason: "push", events: events2, consent: true });
    out(renderSummary(judge, color));
    const t = parseTranscriptFile(transcriptPath);
    out(dim(`  models in session: ${t.models.join(", ")} \xB7 subagent spend: ${Object.entries(judge.cost.by_subagent).filter(([k]) => k !== "main").map(([k, v]) => `${k} $${v.usd.toFixed(3)}`).join(", ") || "none"}`));
    out(dim(`  full receipt: ${path27.join(sessionDir(session), "report.md")}`));
    step(4, "Follow-up 8 days later: the PR was merged, then reverted");
    const mergeSha = git(cwd, "rev-parse", "HEAD");
    fs27.writeFileSync(path27.join(cwd, "src", "login.js"), `module.exports = function login(attempts) { return 200; };
`);
    fs27.unlinkSync(path27.join(cwd, "src", "rateLimit.js"));
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", `Revert "add rate limiting to login (#57)"

This reverts commit ${mergeSha}. Locked out the QA team.`);
    const fakeGh = (bin, args, c) => {
      if (bin === "git") {
        const r = spawnSync8("git", args, { cwd: c, encoding: "utf8", windowsHide: true });
        return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }
      if (args[0] === "pr") return { ok: true, stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-09-11T09:00:00Z", mergeCommit: { oid: mergeSha }, reviews: [{ state: "APPROVED" }], comments: [{}, {}], number: 57, headRefName: "feature/rate-limit" }), stderr: "" };
      if (args[0] === "run") return { ok: true, stdout: JSON.stringify([{ conclusion: "success", name: "ci" }]), stderr: "" };
      if (args[0] === "api") return { ok: true, stdout: "[]", stderr: "" };
      if (args[0] === "issue") return { ok: true, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    };
    const after = followupSession(session, { exec: fakeGh, now: () => /* @__PURE__ */ new Date("2026-09-18T10:00:00Z") });
    out(`  original verdict: ${bold(after.followup.original_verdict)}  \u2192  final: ${bold(after.followup.final_verdict)}  (${after.followup.final_status})`);
    for (const n of after.followup.notes) out(dim(`  - ${n}`));
    out("");
    out(bold("Done.") + ` ${shown} coach suggestions, ${applied.length} applied (${applied.join(", ")}), ${injected.length} injected (${injected.join(", ")}), ship detected: ${shipDetected ? "yes" : "no"}, verdict ${judge.verdict.verdict} \u2192 ${after.followup.final_verdict}.`);
    out(dim(`Demo data: ${home}${opts.keep ? " (kept)" : " (delete it whenever you like)"}`));
    return { home, repo: cwd, session, suggestionsShown: shown, applied, injected, shipDetected, verdict: judge.verdict.verdict, finalVerdict: after.followup.final_verdict, reportPath: path27.join(sessionDir(session), "report.md") };
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === void 0) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
var here2;
var init_demo = __esm({
  "src/demo/demo.ts"() {
    "use strict";
    init_config();
    init_client();
    init_intake();
    init_events();
    init_context();
    init_engine();
    init_ui();
    init_actions();
    init_judge();
    init_followup();
    init_paths();
    init_parse();
    here2 = path27.dirname(fileURLToPath3(import.meta.url));
  }
});

// src/commands/demo.ts
var demo_exports = {};
__export(demo_exports, {
  run: () => run14
});
async function run14(args) {
  await runDemo({ color: !has(args, "plain"), keep: has(args, "keep"), fast: has(args, "fast") });
}
var init_demo2 = __esm({
  "src/commands/demo.ts"() {
    "use strict";
    init_cli();
    init_demo();
  }
});

// src/commands/status.ts
var status_exports = {};
__export(status_exports, {
  run: () => run15
});
import fs28 from "node:fs";
import path28 from "node:path";
async function run15(args) {
  const cfg = loadConfig();
  const session = resolveSession(flag(args, "session"), process.cwd());
  const color = !has(args, "plain");
  if (!session) {
    process.stdout.write("No tracked sessions yet. Install with `tally install`, then start Claude Code.\n");
    return;
  }
  const cwd = sessionCwd(session) ?? process.cwd();
  process.stdout.write(statusLine(session, cwd, cfg, color) + "\n");
  const active = activeSessions().find((s) => s.id === session);
  process.stdout.write(`state: ${active ? "active" : "ended"} \xB7 dir: ${sessionDir(session)}

`);
  const task = loadTask(session);
  if (task) process.stdout.write(renderTask(task) + "\n\n");
  if (fs28.existsSync(path28.join(sessionDir(session), "task.pending")) && !task) process.stdout.write("task intake is running in the background\u2026\n\n");
  const judge = loadJudge(session);
  if (judge) process.stdout.write(renderSummary(judge, color) + "\n\n");
  const inj = pendingInjects(session);
  if (inj.length) process.stdout.write(`${inj.length} coach note(s) queued for the next turn.
`);
}
var init_status = __esm({
  "src/commands/status.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_session();
    init_ui();
    init_intake();
    init_judge();
    init_inject();
    init_paths();
  }
});

// src/commands/config.ts
var config_exports = {};
__export(config_exports, {
  run: () => run16
});
async function run16(args) {
  const [key, value] = args._;
  if (key === "unmute" && value) {
    unmuteRule(process.cwd(), value);
    process.stdout.write(`Unmuted ${value} for this repo.
`);
    return;
  }
  if (key === "consent") {
    if (value === "on" || value === "off") {
      setTestRerunConsent(process.cwd(), value === "on");
      process.stdout.write(`Test re-runs ${value === "on" ? "allowed" : "disallowed"} for ${process.cwd()}
`);
      return;
    }
    const c = testRerunConsent(loadConfig(), process.cwd());
    process.stdout.write(`Test re-runs in ${process.cwd()}: ${c === void 0 ? "not asked yet" : c ? "allowed" : "disallowed"}  (tally config consent on|off)
`);
    return;
  }
  if (key === "mutes") {
    process.stdout.write(JSON.stringify(loadMutes(), null, 2) + "\n");
    return;
  }
  if (!key) {
    const cfg = loadConfig();
    process.stdout.write(`${configFile()}
${JSON.stringify(cfg, null, 2)}
`);
    return;
  }
  if (value === void 0) {
    process.stderr.write("Usage: tally config <key> <value>   e.g. tally config hourly_rate 120 | tally config models.judge opus | tally config writeback true\n");
    return 1;
  }
  const parsed = /^(true|false)$/.test(value) ? value === "true" : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  const patch = {};
  let cur = patch;
  const parts = key.split(".");
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = parsed;
    else cur = cur[p] = {};
  });
  try {
    const cfg = saveConfig(patch);
    process.stdout.write(`${key} = ${JSON.stringify(parsed)}
`);
  } catch (err) {
    process.stderr.write(`Invalid: ${err instanceof Error ? err.message : String(err)}
`);
    return 1;
  }
}
var init_config2 = __esm({
  "src/commands/config.ts"() {
    "use strict";
    init_config();
    init_paths();
    init_engine();
  }
});

// src/commands/sessions.ts
var sessions_exports = {};
__export(sessions_exports, {
  run: () => run17
});
async function run17(_args) {
  const active = new Set(activeSessions().map((s) => s.id));
  const ids = listSessions();
  if (!ids.length) {
    process.stdout.write("No sessions tracked yet.\n");
    return;
  }
  for (const id of ids.slice(0, 30)) {
    const ev = readEvents(id);
    const first = ev[0]?.ts ?? "";
    const cwd = ev.find((e) => e.cwd)?.cwd ?? "";
    const task = loadTask(id);
    const j = loadJudge(id);
    process.stdout.write(`${active.has(id) ? "\u25CF" : "\u25CB"} ${id.slice(0, 8)}  ${first.slice(0, 16)}  ${cwd}
    ${task ? task.title : "(no task)"}${j ? `  \u2192 ${j.verdict.verdict}, ${j.completion_pct}% , ${fmtUsd(j.cost.total_usd)}${j.followup ? `, final: ${j.followup.final_status}` : ""}` : ""}
`);
  }
}
var init_sessions = __esm({
  "src/commands/sessions.ts"() {
    "use strict";
    init_events();
    init_session();
    init_intake();
    init_judge();
    init_pricing();
  }
});

// src/commands/otel.ts
var otel_exports = {};
__export(otel_exports, {
  run: () => run18
});
async function run18(args) {
  if (has(args, "status") || args._[0] === "status") {
    const points = readOtelPoints();
    const sessions = new Set(points.map((p) => p.attrs["session.id"]).filter((s) => !!s));
    process.stdout.write(`${points.length} metric point(s) from ${sessions.size} session(s) in ${otelFile()}
`);
    for (const s of [...sessions].slice(-5)) process.stdout.write(`  ${s}: $${otelCostForSession(s, points).total_usd.toFixed(4)}
`);
    return;
  }
  const port = Number(flag(args, "port") ?? 4318);
  const { port: bound } = await startOtelReceiver({
    port,
    onPoints: (p) => {
      const cost = p.filter((x) => x.name === "claude_code.cost.usage").reduce((s, x) => s + x.value, 0);
      if (cost > 0) process.stdout.write(`  +$${cost.toFixed(4)} (${p.length} points)
`);
    }
  });
  const env = otelSetupEnv(bound);
  process.stdout.write(`Tally OTel receiver listening on http://127.0.0.1:${bound}/v1/metrics \u2192 ${otelFile()}

Start Claude Code with these variables (put them in your shell profile or ~/.claude/settings.json "env"):
`);
  for (const [k, v] of Object.entries(env)) process.stdout.write(`  ${k}=${v}
`);
  process.stdout.write("\nReceipts will then show an OTel cross-check next to the transcript cost. Ctrl-C to stop.\n");
  await new Promise(() => {
  });
}
var init_otel2 = __esm({
  "src/commands/otel.ts"() {
    "use strict";
    init_cli();
    init_otel();
  }
});

// src/calibrate/calibrate.ts
import fs29 from "node:fs";
import path29 from "node:path";
function calibrationFile() {
  return path29.join(tallyHome(), "calibration.jsonl");
}
function parseStatuses(s) {
  return s.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => {
    const m = STATUSES.find((st) => st === x || st.startsWith(x));
    if (!m) throw new Error(`unknown status "${x}" (use met, partial, unmet, unverifiable)`);
    return m;
  });
}
function parseVerdict(s) {
  if (!s) return void 0;
  const v = s.trim().toLowerCase().replace(/[_-]/g, " ");
  const m = VERDICTS.find((x) => x === v || x.startsWith(v));
  if (!m) throw new Error(`unknown verdict "${s}" (use "worth it", "borderline", "not worth it")`);
  return m;
}
function entryFromJudge(judge, human, humanVerdict, source = "human") {
  if (human.length !== judge.criteria.length) throw new Error(`expected ${judge.criteria.length} grade(s) for ${judge.criteria.map((c) => c.id).join(", ")}, got ${human.length}`);
  return {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: judge.session,
    source,
    task_title: judge.task.title,
    criteria: judge.criteria.map((c, i) => ({ id: c.id, text: c.text, judge: c.status, human: human[i], evidence: c.evidence })),
    judge_verdict: judge.verdict.verdict,
    human_verdict: humanVerdict,
    judge_model: judge.judge_model,
    task_source: judge.task.task_source
  };
}
function rescoreCalibration(opts = {}) {
  const all = readCalibration().filter((e) => e.source === (opts.source ?? "backfill") && (!opts.grader || (e.grader ?? "") === opts.grader));
  const latest = /* @__PURE__ */ new Map();
  for (const e of all) latest.set(`${e.session}|${e.grader ?? ""}`, e);
  const rescored = [];
  const skipped = [];
  for (const e of latest.values()) {
    const judge = loadJudge(e.session);
    if (!judge) {
      skipped.push({ session: e.session, why: "no receipt" });
      continue;
    }
    const ids = judge.criteria.map((c) => c.id).join(",");
    if (ids !== e.criteria.map((c) => c.id).join(",")) {
      skipped.push({ session: e.session, why: `criteria changed (${ids})` });
      continue;
    }
    const unchanged = judge.criteria.every((c, i) => c.status === e.criteria[i].judge) && judge.verdict.verdict === e.judge_verdict;
    if (unchanged) continue;
    const fresh = entryFromJudge(judge, e.criteria.map((c) => c.human), e.human_verdict, e.source);
    const next = { ...fresh, grader: e.grader, coach: e.coach, task_edited: e.task_edited, rescored_from: e.ts, criteria: fresh.criteria.map((c, i) => ({ ...c, text: e.criteria[i].text })) };
    appendLine(calibrationFile(), JSON.stringify(next));
    rescored.push(e.session);
  }
  return { rescored, skipped };
}
function addCalibration(session, human, humanVerdict) {
  const judge = loadJudge(session);
  if (!judge) throw new Error(`no receipt for session ${session}; run tally judge first`);
  const entry = entryFromJudge(judge, human, humanVerdict);
  ensureDir(tallyHome());
  appendLine(calibrationFile(), JSON.stringify(entry));
  return entry;
}
function readCalibration(file = calibrationFile()) {
  if (!fs29.existsSync(file)) return [];
  const bySession = /* @__PURE__ */ new Map();
  for (const line of fs29.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      bySession.set(`${e.session}|${e.grader ?? ""}`, e);
    } catch {
    }
  }
  return [...bySession.values()];
}
function buildCalibrationReport(entries) {
  const confusion = Object.fromEntries(STATUSES.map((h) => [h, Object.fromEntries(STATUSES.map((j) => [j, 0]))]));
  let total = 0;
  let agree = 0;
  let lenient = 0;
  const disagreements = [];
  const vd = [];
  let vTotal = 0;
  let vAgree = 0;
  for (const e of entries) {
    for (const c of e.criteria) {
      total += 1;
      confusion[c.human][c.judge] += 1;
      if (c.human === c.judge) {
        agree += 1;
        lenient += 1;
      } else {
        if (Math.abs(ORDER[c.human] - ORDER[c.judge]) === 1 && (c.human === "partial" || c.judge === "partial" || c.judge === "unverifiable")) lenient += 1;
        disagreements.push({ session: e.session, task: e.task_title, id: c.id, text: c.text, human: c.human, judge: c.judge, evidence: c.evidence });
      }
    }
    if (e.human_verdict) {
      vTotal += 1;
      if (e.human_verdict === e.judge_verdict) vAgree += 1;
      else vd.push({ session: e.session, task: e.task_title, human: e.human_verdict, judge: e.judge_verdict });
    }
  }
  const per_status = {};
  for (const s of STATUSES) {
    const humanCount = STATUSES.reduce((n, j) => n + confusion[s][j], 0);
    const judgeCount = STATUSES.reduce((n, h) => n + confusion[h][s], 0);
    per_status[s] = { human: humanCount, judge: judgeCount, precision: judgeCount ? confusion[s][s] / judgeCount : null, recall: humanCount ? confusion[s][s] / humanCount : null };
  }
  const lean = { lenient: 0, stricter: 0, same: 0 };
  for (const e of entries)
    for (const c of e.criteria) {
      if (ORDER[c.judge] > ORDER[c.human]) lean.lenient += 1;
      else if (ORDER[c.judge] < ORDER[c.human]) lean.stricter += 1;
      else lean.same += 1;
    }
  const byGraderSession = /* @__PURE__ */ new Map();
  for (const e of entries) if (e.grader) byGraderSession.set(e.session, [...byGraderSession.get(e.session) ?? [], e]);
  let igCriteria = 0;
  let igAgree = 0;
  let igSessions = 0;
  const graders = /* @__PURE__ */ new Set();
  for (const [, es] of byGraderSession) {
    if (es.length < 2) continue;
    igSessions += 1;
    for (const e of es) graders.add(e.grader);
    const [a, b] = es;
    for (let i = 0; i < Math.min(a.criteria.length, b.criteria.length); i++) {
      igCriteria += 1;
      if (a.criteria[i].human === b.criteria[i].human) igAgree += 1;
    }
  }
  const coachMarks = entries.flatMap((e) => e.coach ?? []);
  const perRule = /* @__PURE__ */ new Map();
  for (const m of coachMarks) {
    const r = perRule.get(m.rule) ?? { total: 0, useful: 0 };
    r.total += 1;
    if (m.mark === "useful") r.useful += 1;
    perRule.set(m.rule, r);
  }
  const by_task_source = ["linked", "confirmed", "inferred"].map((source) => {
    const es = entries.filter((e) => (e.task_source ?? "linked") === source);
    const cs = es.flatMap((e) => e.criteria);
    return { source, entries: es.length, criteria: cs.length, agreement: cs.length ? cs.filter((c) => c.human === c.judge).length / cs.length : null };
  }).filter((x) => x.entries > 0);
  return {
    by_task_source,
    lean,
    inter_grader: igSessions ? { sessions: igSessions, criteria: igCriteria, agreement: igCriteria ? igAgree / igCriteria : null, graders: [...graders] } : null,
    coach: { total: coachMarks.length, useful: coachMarks.filter((m) => m.mark === "useful").length, precision: coachMarks.length ? coachMarks.filter((m) => m.mark === "useful").length / coachMarks.length : null, per_rule: [...perRule.entries()].map(([rule, v]) => ({ rule, total: v.total, useful: v.useful, precision: v.useful / v.total })).sort((x, y) => y.total - x.total) },
    entries: entries.length,
    criteria: total,
    criterion_agreement: total ? agree / total : null,
    strict_agreement: total ? agree / total : null,
    lenient_agreement: total ? lenient / total : null,
    verdict_total: vTotal,
    verdict_agreement: vTotal ? vAgree / vTotal : null,
    confusion,
    disagreements,
    verdict_disagreements: vd,
    per_status
  };
}
function renderCalibrationReport(r, title = "Judge calibration") {
  const pct = (x) => x === null ? "n/a" : `${(x * 100).toFixed(0)}%`;
  const L = [];
  L.push(`${title}: ${r.entries} graded session(s), ${r.criteria} criteria`);
  if (!r.criteria) {
    L.push('No grades yet. Grade a receipt: tally calibrate add <session> --human met,partial,unmet,... --verdict "worth it"');
    return L.join("\n");
  }
  L.push(`criterion agreement   ${pct(r.criterion_agreement)} exact \xB7 ${pct(r.lenient_agreement)} within one step (partial/unverifiable neighbours) \xB7 n=${r.criteria}`);
  L.push(`verdict agreement     ${r.verdict_total ? `${pct(r.verdict_agreement)} of ${r.verdict_total}` : "n/a (no human verdicts)"} \xB7 n=${r.verdict_total}`);
  L.push(`lean                  Tally more lenient than the human on ${r.lean.lenient}, stricter on ${r.lean.stricter}, same on ${r.lean.same}`);
  if (r.inter_grader) L.push(`inter-grader          ${pct(r.inter_grader.agreement)} of ${r.inter_grader.criteria} criteria across ${r.inter_grader.sessions} session(s) graded by ${r.inter_grader.graders.join(" and ")}`);
  else L.push("inter-grader          n/a (no session graded by two people; use --grader <name>)");
  if (r.coach.total) {
    L.push(`coach precision       ${pct(r.coach.precision)} of ${r.coach.total} replayed suggestion(s) marked useful`);
    for (const p of r.coach.per_rule) L.push(`  ${p.rule.padEnd(22)} ${pct(p.precision)} (${p.useful}/${p.total})`);
  } else L.push("coach precision       n/a (no Coach suggestions graded)");
  if (r.by_task_source.length > 1) for (const s of r.by_task_source) L.push(`by task source        ${s.source.padEnd(10)} ${pct(s.agreement)} on ${s.criteria} criteria (${s.entries} session(s))`);
  L.push("");
  L.push("confusion (rows = human, columns = judge)");
  L.push(`${"human \\ judge".padEnd(16)}${STATUSES.map((s) => s.padStart(13)).join("")}   recall`);
  for (const h of STATUSES) L.push(`${h.padEnd(16)}${STATUSES.map((j) => String(r.confusion[h][j]).padStart(13)).join("")}   ${pct(r.per_status[h].recall)}`);
  L.push(`${"precision".padEnd(16)}${STATUSES.map((j) => pct(r.per_status[j].precision).padStart(13)).join("")}`);
  if (r.disagreements.length) {
    L.push("");
    L.push(`disagreements (${r.disagreements.length})`);
    for (const d of r.disagreements) L.push(`- [${d.session.slice(0, 12)}] ${d.id} "${d.text.slice(0, 70)}": human ${d.human}, judge ${d.judge} (${ORDER[d.judge] > ORDER[d.human] ? "lenient" : "stricter"})
    judge's evidence: ${d.evidence.slice(0, 220).replace(/\n/g, " ")}`);
  }
  if (r.verdict_disagreements.length) {
    L.push("");
    L.push("verdict disagreements");
    for (const d of r.verdict_disagreements) L.push(`- [${d.session.slice(0, 12)}] "${d.task.slice(0, 50)}": human ${d.human}, judge ${d.judge}`);
  }
  return L.join("\n");
}
var STATUSES, VERDICTS, ORDER;
var init_calibrate = __esm({
  "src/calibrate/calibrate.ts"() {
    "use strict";
    init_paths();
    init_judge();
    STATUSES = ["met", "partial", "unmet", "unverifiable"];
    VERDICTS = ["worth it", "borderline", "not worth it"];
    ORDER = { met: 3, partial: 2, unverifiable: 1, unmet: 0 };
  }
});

// src/calibrate/grade.ts
import fs30 from "node:fs";
import path30 from "node:path";
function evidenceSummary(session) {
  const j = loadJudge(session);
  const task = loadTask(session);
  if (!j || !task) throw new Error(`session ${session} has no receipt; run tally backfill add or tally judge first`);
  const L = [];
  L.push(`Task: ${task.title}${task.source.url ? `  (${task.source.url})` : ""}`);
  if (task.historical) L.push(`  ${task.historical.note}`);
  L.push("");
  L.push("Criteria (frozen at intake):");
  for (const c of task.criteria) L.push(`  ${c.id}. ${c.text}`);
  L.push("");
  L.push("Evidence:");
  L.push(`  diff: ${j.evidence.files_changed.length} file(s), +${j.evidence.insertions} \u2212${j.evidence.deletions}${j.evidence.files_changed.length ? " \u2014 " + j.evidence.files_changed.slice(0, 12).join(", ") + (j.evidence.files_changed.length > 12 ? ", \u2026" : "") : ""}`);
  if (j.evidence.diff_stat) L.push("  " + j.evidence.diff_stat.split("\n").slice(0, 8).join("\n  "));
  L.push(`  tests: ${j.verification.ran ? `${j.verification.command} \u2192 ${j.verification.passed ? "passed" : j.verification.timed_out ? "timed out" : "FAILED"}` : `not run (${j.verification.reason})`}`);
  if (j.evidence.command_runs.length) L.push(`  commands run in session: ${j.evidence.command_runs.map((c) => `${c.command} ${c.passed ? "ok" : "failed"}`).join("; ")}`);
  L.push(`  shipped: ${j.evidence.ship_events.map((s) => `${s.kind}${s.url ? " " + s.url : ""}`).join(", ") || "no push/PR recorded"}`);
  if (j.followup) L.push(`  outcome: ${j.followup.notes.join(" ")}`);
  L.push(`  session cost: $${j.cost.total_usd.toFixed(2)}, ${j.evidence.tool_calls} tool calls`);
  L.push("");
  L.push("Final assistant message:");
  L.push("  " + (j.evidence.final_message || "(none)").slice(0, 900).replace(/\n/g, "\n  "));
  return L.join("\n");
}
function statusFrom(answer) {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  if (a === "m" || a === "met") return "met";
  if (a === "p" || a.startsWith("part")) return "partial";
  if (a === "u" || a === "unmet") return "unmet";
  if (a === "x" || a === "?" || a.startsWith("unv")) return "unverifiable";
  return STATUSES.find((s) => s.startsWith(a)) ?? null;
}
function verdictFrom(answer) {
  const a = answer.trim().toLowerCase();
  if (a === "w" || a.startsWith("worth")) return "worth it";
  if (a === "b" || a.startsWith("border")) return "borderline";
  if (a === "n" || a.startsWith("not")) return "not worth it";
  return VERDICTS.find((v) => v.startsWith(a)) ?? null;
}
async function gradeSession(session, opts) {
  const j = loadJudge(session);
  const summary = evidenceSummary(session);
  const task = loadTask(session);
  if (j.criteria.length !== task.criteria.length) throw new Error(`the receipt for ${session.slice(0, 8)} has ${j.criteria.length} criteria but the task now has ${task.criteria.length}; re-run tally judge ${session.slice(0, 8)} before grading`);
  opts.out(`Blind grading \xB7 session ${session.slice(0, 8)} \xB7 grader ${opts.grader}
(Tally's own statuses and verdict stay hidden until you have graded.)
`);
  opts.out(summary);
  let criteria = task.criteria.map((c) => ({ id: c.id, text: c.text }));
  let taskEdited = false;
  if (task.inferred) {
    opts.out(`
These criteria were inferred from the prompts${task.context?.branch ? `, branch "${task.context.branch}"` : ""}${task.context?.commits?.length ? " and commits" : ""} (${task.confirmed ? "confirmed" : "unconfirmed"}). [a]ccept them or [e]dit: `);
    let choice = "";
    while (!/^[ae]$/.test(choice)) choice = (await opts.ask("  > ")).trim().toLowerCase();
    if (choice === "e") {
      opts.out("  Enter each criterion as you understood the task (same count and order; empty keeps the original):");
      const edited = [];
      for (const c of criteria) {
        const line = (await opts.ask(`  ${c.id} [${c.text.slice(0, 60)}] > `)).trim();
        edited.push(line || c.text);
      }
      taskEdited = edited.some((t, i) => t !== criteria[i].text);
      criteria = criteria.map((c, i) => ({ id: c.id, text: edited[i] }));
    }
  }
  opts.out("\nGrade each criterion: [m]et  [p]artial  [u]nmet  [x] unverifiable");
  const human = [];
  for (const c of criteria) {
    let s = null;
    while (!s) s = statusFrom(await opts.ask(`  ${c.id} "${c.text.slice(0, 80)}" > `));
    human.push(s);
  }
  let verdict = null;
  while (!verdict) verdict = verdictFrom(await opts.ask("Your verdict: [w]orth it  [b]orderline  [n]ot worth it > "));
  const replayPath = path30.join(sessionDir(session), "coach_replay.json");
  const replay = fs30.existsSync(replayPath) ? JSON.parse(fs30.readFileSync(replayPath, "utf8")) : null;
  const coach = [];
  if (replay?.shown.length) {
    opts.out(`
The Coach would have shown ${replay.shown.length} suggestion(s). Mark each [u]seful or [n]oise:`);
    for (const s of replay.shown) {
      let mark = null;
      while (!mark) {
        const a = (await opts.ask(`  [${s.rule}] ${s.title}: ${s.message.split("\n")[0].slice(0, 100)} > `)).trim().toLowerCase();
        mark = a === "u" || a.startsWith("use") ? "useful" : a === "n" || a.startsWith("noi") ? "noise" : null;
      }
      coach.push({ rule: s.rule, key: s.key, title: s.title, mark });
    }
  }
  const base = entryFromJudge(j, human, verdict, "backfill");
  const entry = { ...base, criteria: base.criteria.map((c, i) => ({ ...c, text: criteria[i].text })), grader: opts.grader, coach, task_edited: taskEdited };
  ensureDir(tallyHome());
  appendLine(calibrationFile(), JSON.stringify(entry));
  const R = [];
  R.push(`
Saved. Tally's judgment, side by side (${j.tiers.ran.join(" \u2192 ")}):`);
  R.push(`  ${"criterion".padEnd(12)} ${"you".padEnd(13)} ${"tally".padEnd(13)} evidence`);
  for (const c of entry.criteria) R.push(`  ${c.id.padEnd(12)} ${c.human.padEnd(13)} ${c.judge.padEnd(13)} ${c.human === c.judge ? "" : "\u2260 "}${c.evidence.slice(0, 90).replace(/\n/g, " ")}`);
  R.push(`  ${"verdict".padEnd(12)} ${verdict.padEnd(13)} ${j.verdict.verdict.padEnd(13)} ${verdict === j.verdict.verdict ? "" : "\u2260"}`);
  if (j.followup) R.push(`  follow-up: ${j.followup.final_status} \u2192 ${j.followup.final_verdict}`);
  if (coach.length) R.push(`  coach: ${coach.filter((c) => c.mark === "useful").length}/${coach.length} marked useful`);
  const reveal = R.join("\n");
  opts.out(reveal);
  return { entry, reveal };
}
var init_grade = __esm({
  "src/calibrate/grade.ts"() {
    "use strict";
    init_judge();
    init_intake();
    init_paths();
    init_calibrate();
  }
});

// src/calibrate/eval.ts
import fs31 from "node:fs";
import os4 from "node:os";
import path31 from "node:path";
import { spawnSync as spawnSync9 } from "node:child_process";
function fixturesRoot() {
  return path31.join(packageRoot(), "test", "fixtures", "calibration");
}
function baselineFile() {
  return path31.join(fixturesRoot(), "baseline.json");
}
function loadFixtures(root = fixturesRoot()) {
  if (!fs31.existsSync(root)) return [];
  return fs31.readdirSync(root).filter((d) => fs31.existsSync(path31.join(root, d, "expected.json"))).sort().map((name) => {
    const dir = path31.join(root, name);
    const read = (f) => JSON.parse(fs31.readFileSync(path31.join(dir, f), "utf8"));
    const recordedPath = path31.join(dir, "model-output.json");
    let recorded;
    if (fs31.existsSync(recordedPath)) {
      const raw = read("model-output.json");
      recorded = Array.isArray(raw.calls) ? { calls: raw.calls } : void 0;
    }
    return { name, dir, task: TaskSchema.parse(read("task.json")), repo: read("repo.json"), expected: read("expected.json"), recorded };
  });
}
function git2(cwd, ...args) {
  const r = spawnSync9("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function materializeRepo(c, root) {
  const cwd = path31.join(root, c.name);
  fs31.mkdirSync(cwd, { recursive: true });
  git2(cwd, "init", "-q", "-b", "main");
  git2(cwd, "config", "user.email", "fixture@tally.local");
  git2(cwd, "config", "user.name", "tally fixture");
  for (const [f, content] of Object.entries(c.repo.base)) {
    fs31.mkdirSync(path31.dirname(path31.join(cwd, f)), { recursive: true });
    fs31.writeFileSync(path31.join(cwd, f), content);
  }
  git2(cwd, "add", "-A");
  git2(cwd, "commit", "-q", "-m", "base");
  const base = git2(cwd, "rev-parse", "HEAD");
  for (const [f, content] of Object.entries(c.repo.after)) {
    fs31.mkdirSync(path31.dirname(path31.join(cwd, f)), { recursive: true });
    fs31.writeFileSync(path31.join(cwd, f), content);
  }
  for (const f of c.repo.delete ?? []) if (fs31.existsSync(path31.join(cwd, f))) fs31.unlinkSync(path31.join(cwd, f));
  return { cwd, base };
}
async function runFixture(c, opts) {
  const cfg = opts.cfg ?? loadConfig();
  const workRoot = opts.workRoot ?? fs31.mkdtempSync(path31.join(os4.tmpdir(), "tally-cal-"));
  const { cwd, base } = materializeRepo(c, workRoot);
  const session = c.task.session;
  ensureDir(sessionDir(session));
  const transcriptPath = path31.join(sessionDir(session), "transcript.jsonl");
  fs31.copyFileSync(path31.join(c.dir, "transcript.jsonl"), transcriptPath);
  const events = readEventsFile(path31.join(c.dir, "events.jsonl")).map((e) => e.type === "session_start" ? { ...e, session, cwd, data: { ...e.data, git_head: base } } : { ...e, session, cwd });
  const calls = [];
  let llm;
  if (opts.llm) llm = opts.llm;
  else if (opts.live) {
    const real = makeLlm({ session });
    llm = {
      complete: async (req) => {
        const r = await real.complete(req);
        if (req.kind === "judge") calls.push({ tier: req.tier ?? 2, model: r.model, cost_usd: r.cost_usd, prompt_tokens: Math.ceil(req.prompt.length / 4), data: r.data });
        return r;
      }
    };
  } else {
    if (!c.recorded) throw new Error(`${c.name}: no model-output.json recorded; run \`tally calibrate eval --live --record\` once`);
    llm = new ReplayLlm(c.recorded.calls, session);
  }
  const task = { ...c.task, cwd };
  const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason: "push", events, task, consent: true, deep: opts.deep });
  const human = judge.criteria.map((cr) => c.expected.criteria[cr.id] ?? "unverifiable");
  const entry = entryFromJudge(judge, human, c.expected.verdict, "fixture");
  const matches = entry.criteria.filter((x) => x.human === x.judge).length;
  return { name: c.name, session, judge, entry, matches, total: entry.criteria.length, verdict_match: judge.verdict.verdict === c.expected.verdict, calls };
}
async function runEval(opts) {
  const cases = loadFixtures().filter((c) => !opts.only?.length || opts.only.includes(c.name));
  if (!cases.length) throw new Error("no calibration fixtures found");
  const workRoot = fs31.mkdtempSync(path31.join(os4.tmpdir(), "tally-cal-"));
  const results = [];
  for (const c of cases) {
    const r = await runFixture(c, { cfg: opts.cfg, live: opts.live, llm: opts.llmFor?.(c), workRoot, deep: opts.deep });
    results.push(r);
  }
  fs31.rmSync(workRoot, { recursive: true, force: true });
  const report = buildCalibrationReport(results.map((r) => r.entry));
  const fixtures = results.map((r) => ({
    name: r.name,
    matches: r.matches,
    total: r.total,
    verdict_match: r.verdict_match,
    judge_verdict: r.judge.verdict.verdict,
    expected_verdict: r.entry.human_verdict ?? "",
    statuses: r.judge.criteria.map((c, i) => ({ id: c.id, human: r.entry.criteria[i].human, judge: c.status, resolved_by: c.resolved_by })),
    session_usd: r.judge.cost.total_usd,
    tally_usd: r.judge.cost.tally_own_usd,
    share_pct: r.judge.cost.tally_share_pct,
    tiers: r.judge.tiers.ran,
    tier_reason: r.judge.tiers.reason
  }));
  const totalSession = fixtures.reduce((s, f) => s + f.session_usd, 0);
  const totalTally = fixtures.reduce((s, f) => s + f.tally_usd, 0);
  const summary = {
    fixtures,
    report,
    criterion_agreement: report.criterion_agreement ?? 0,
    verdict_agreement: report.verdict_agreement ?? 0,
    avg_share_pct: fixtures.length ? fixtures.reduce((s, f) => s + f.share_pct, 0) / fixtures.length : 0,
    total_session_usd: totalSession,
    total_tally_usd: totalTally,
    live: !!opts.live,
    judge_model: results.flatMap((r) => r.judge.tiers.calls.map((c) => c.model)).filter((m, i, a) => a.indexOf(m) === i).join("+") || "mechanical"
  };
  if (opts.record) {
    const old = loadBaseline();
    if (!old || summary.criterion_agreement >= old.criterion_agreement - 1e-9) {
      for (const r of results) fs31.writeFileSync(path31.join(cases.find((c) => c.name === r.name).dir, "model-output.json"), JSON.stringify({ recorded_at: (/* @__PURE__ */ new Date()).toISOString(), calls: r.calls }, null, 2) + "\n");
      fs31.writeFileSync(baselineFile(), JSON.stringify({ recorded_at: (/* @__PURE__ */ new Date()).toISOString(), judge_model: summary.judge_model, criterion_agreement: summary.criterion_agreement, verdict_agreement: summary.verdict_agreement, avg_share_pct: Math.round(summary.avg_share_pct * 100) / 100, fixtures: fixtures.map((f) => ({ name: f.name, matches: f.matches, total: f.total, verdict_match: f.verdict_match, session_usd: f.session_usd, tally_usd: f.tally_usd, share_pct: f.share_pct, tiers: f.tiers })) }, null, 2) + "\n");
      summary.baseline_updated = true;
    } else summary.baseline_updated = false;
  }
  return summary;
}
function loadBaseline() {
  const f = baselineFile();
  if (!fs31.existsSync(f)) return null;
  return JSON.parse(fs31.readFileSync(f, "utf8"));
}
function renderOverheadTable(s) {
  const L = [];
  L.push("fixture                    session $   tally $   share   tiers");
  for (const f of s.fixtures) L.push(`${f.name.padEnd(26)} ${("$" + f.session_usd.toFixed(3)).padStart(9)} ${("$" + f.tally_usd.toFixed(3)).padStart(9)} ${(f.share_pct.toFixed(1) + "%").padStart(7)}   ${f.tiers.map((t) => t.replace("tier", "")).join("\u2192")}  ${f.tier_reason}`);
  L.push(`${"average / total".padEnd(26)} ${("$" + s.total_session_usd.toFixed(3)).padStart(9)} ${("$" + s.total_tally_usd.toFixed(3)).padStart(9)} ${(s.avg_share_pct.toFixed(1) + "%").padStart(7)}`);
  return L.join("\n");
}
var ReplayLlm;
var init_eval = __esm({
  "src/calibrate/eval.ts"() {
    "use strict";
    init_config();
    init_client();
    init_judge();
    init_intake();
    init_events();
    init_paths();
    init_calibrate();
    ReplayLlm = class {
      constructor(calls, session) {
        this.calls = calls;
        this.session = session;
      }
      used = 0;
      async complete(req) {
        if (req.kind !== "judge") throw new Error(`ReplayLlm: unexpected ${req.kind} call`);
        const call = this.calls.find((c, i) => i >= this.used && c.tier === req.tier);
        if (!call) throw new Error(`ReplayLlm: no recorded tier ${req.tier} call (recorded: ${this.calls.map((c) => "tier" + c.tier).join(", ") || "none"}); re-record with --live --record`);
        this.used = this.calls.indexOf(call) + 1;
        const usage = { input: call.prompt_tokens, output: 300, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
        recordTallySpend({ kind: `judge:tier${call.tier}`, model: call.model, cost_usd: call.cost_usd, usage, session: this.session });
        return { data: call.data, usage, cost_usd: call.cost_usd, model: call.model, duration_ms: 1 };
      }
    };
  }
});

// src/commands/calibrate.ts
var calibrate_exports = {};
__export(calibrate_exports, {
  run: () => run19
});
import fs32 from "node:fs";
import os5 from "node:os";
import path32 from "node:path";
import readline3 from "node:readline";
async function run19(args) {
  const sub = args._[0];
  if (sub === "add") {
    const session = resolveSession(args._[1] ?? flag(args, "session"), process.cwd());
    const human = flag(args, "human");
    if (!session || !human) {
      process.stderr.write('Usage: tally calibrate add <session> --human met,partial,unmet,unverifiable[,...] [--verdict "worth it"|borderline|"not worth it"]\n');
      return 1;
    }
    const judge = loadJudge(session);
    if (!judge) {
      process.stderr.write(`No receipt for ${session}. Run tally judge first.
`);
      return 1;
    }
    try {
      const entry = addCalibration(session, parseStatuses(human), parseVerdict(flag(args, "verdict")));
      process.stdout.write(`Recorded ${entry.criteria.length} grade(s) for "${entry.task_title}":
`);
      for (const c of entry.criteria) process.stdout.write(`  ${c.id} human ${c.human.padEnd(12)} judge ${c.judge.padEnd(12)} ${c.human === c.judge ? "agree" : "DISAGREE"}  ${c.text.slice(0, 60)}
`);
      if (entry.human_verdict) process.stdout.write(`  verdict: human ${entry.human_verdict}, judge ${entry.judge_verdict}
`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
      return 1;
    }
    return;
  }
  if (sub === "grade") {
    const session = resolveSession(args._[1] ?? flag(args, "session"), process.cwd());
    if (!session || !loadJudge(session)) {
      process.stderr.write("Usage: tally calibrate grade <session> [--grader name]   (the session needs a receipt: tally backfill add or tally judge)\n");
      return 1;
    }
    const grader = flag(args, "grader") ?? os5.userInfo().username;
    const rl = readline3.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));
    try {
      await gradeSession(session, { grader, ask, out: (s) => process.stdout.write(s + "\n") });
    } finally {
      rl.close();
    }
    process.stdout.write("\nReport: tally calibrate report --source backfill\n");
    return;
  }
  if (sub === "rescore") {
    const r = rescoreCalibration({ grader: flag(args, "grader"), source: "backfill" });
    process.stdout.write(`${r.rescored.length} entr${r.rescored.length === 1 ? "y" : "ies"} rescored against the current receipts (human grades unchanged)${r.rescored.length ? ": " + r.rescored.map((s) => s.slice(0, 8)).join(", ") : ""}
`);
    for (const s of r.skipped) process.stdout.write(`  skipped ${s.session.slice(0, 8)}: ${s.why}
`);
    return;
  }
  if (sub === "report" || !sub) {
    const source = flag(args, "source");
    const all = readCalibration();
    const sections = source ? [[source, all.filter((e) => e.source === source)]] : [["backfill", all.filter((e) => e.source === "backfill")], ["human", all.filter((e) => e.source === "human")]];
    for (const [name, entries] of sections) {
      process.stdout.write(renderCalibrationReport(buildCalibrationReport(entries), name === "backfill" ? "Backfill calibration (real sessions, blind-graded)" : name === "fixture" ? "Fixture calibration" : "Calibration (receipts graded with calibrate add)") + "\n\n");
    }
    if (!source || source === "fixture") {
      const b = loadBaseline();
      if (b) process.stdout.write(`Fixture regression baseline (kept separate from real sessions; ${b.judge_model ?? "?"}, ${b.recorded_at?.slice(0, 10) ?? "?"}): ${(b.criterion_agreement * 100).toFixed(0)}% criterion agreement, ${(b.verdict_agreement * 100).toFixed(0)}% verdict agreement, ${b.avg_share_pct ?? "?"}% average self-share. Run \`tally calibrate eval\` to re-check.
`);
    }
    return;
  }
  if (sub === "eval") {
    const live = has(args, "live");
    const record = has(args, "record");
    if (record && !live) {
      process.stderr.write("--record needs --live (it stores the real judge model output).\n");
      return 1;
    }
    const prevHome = process.env.TALLY_HOME;
    const keep = has(args, "keep");
    if (!keep) process.env.TALLY_HOME = fs32.mkdtempSync(path32.join(os5.tmpdir(), "tally-cal-home-"));
    try {
      const only = flag(args, "only")?.split(",").filter(Boolean);
      const s = await runEval({ live, record, only, deep: has(args, "deep") });
      process.stdout.write(`Calibration eval (${live ? "live judge model: " + s.judge_model : "recorded model output replayed through the pipeline"})

`);
      for (const f of s.fixtures) process.stdout.write(`${f.verdict_match && f.matches === f.total ? "ok  " : "diff"} ${f.name.padEnd(26)} ${f.matches}/${f.total} criteria \xB7 verdict ${f.judge_verdict}${f.verdict_match ? "" : ` (expected ${f.expected_verdict})`}${f.matches === f.total ? "" : "  [" + f.statuses.filter((x) => x.human !== x.judge).map((x) => `${x.id}: judge ${x.judge}, human ${x.human}`).join("; ") + "]"}
`);
      process.stdout.write("\n" + renderCalibrationReport(s.report, "Fixture agreement") + "\n");
      process.stdout.write("\nSelf-overhead (Tally spend as a share of each session)\n" + renderOverheadTable(s) + "\n");
      if (has(args, "verbose")) for (const f of s.fixtures) process.stdout.write("\n" + renderSummary(loadJudge(f.name.startsWith("cal-") ? f.name : `cal-${f.name}`) ?? {}, false) + "\n");
      const baseline = loadBaseline();
      const threshold = flag(args, "fail-below") !== void 0 ? Number(flag(args, "fail-below")) : baseline ? baseline.criterion_agreement - 1e-9 : void 0;
      if (threshold !== void 0 && s.criterion_agreement < threshold) {
        process.stderr.write(`
FAIL: criterion agreement ${(s.criterion_agreement * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%${baseline && flag(args, "fail-below") === void 0 ? ` (baseline recorded ${baseline.recorded_at?.slice(0, 10)})` : ""}.
`);
        return 1;
      }
      const maxShare = flag(args, "max-share") !== void 0 ? Number(flag(args, "max-share")) : void 0;
      if (maxShare !== void 0 && s.avg_share_pct > maxShare) {
        process.stderr.write(`
FAIL: average self-share ${s.avg_share_pct.toFixed(1)}% is above ${maxShare}%.
`);
        return 1;
      }
      if (threshold !== void 0) process.stdout.write(`
PASS: criterion agreement ${(s.criterion_agreement * 100).toFixed(1)}% \u2265 ${(threshold * 100).toFixed(1)}%${maxShare !== void 0 ? `; average self-share ${s.avg_share_pct.toFixed(1)}% \u2264 ${maxShare}%` : ""}.
`);
      if (record) process.stdout.write(s.baseline_updated ? `Recorded model outputs and baseline under test/fixtures/calibration/.
` : `Nothing recorded: agreement ${(s.criterion_agreement * 100).toFixed(1)}% is below the current baseline; the previous model outputs and baseline stay.
`);
    } finally {
      if (!keep) {
        fs32.rmSync(process.env.TALLY_HOME, { recursive: true, force: true });
        if (prevHome === void 0) delete process.env.TALLY_HOME;
        else process.env.TALLY_HOME = prevHome;
      }
    }
    return;
  }
  process.stderr.write("Usage: tally calibrate add|grade|rescore|report|eval\n");
  return 1;
}
var init_calibrate2 = __esm({
  "src/commands/calibrate.ts"() {
    "use strict";
    init_cli();
    init_calibrate();
    init_calibrate();
    init_grade();
    init_eval();
    init_judge();
    init_judge();
    init_session();
  }
});

// src/backfill/scan.ts
import fs33 from "node:fs";
import path33 from "node:path";
function indexFile() {
  return path33.join(tallyHome(), "backfill", "index.json");
}
function parseSince(s, now = Date.now()) {
  if (!s) return now - 60 * 864e5;
  const m = /^(\d+)([dhwm])$/.exec(s.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] === "h" ? 36e5 : m[2] === "d" ? 864e5 : m[2] === "w" ? 7 * 864e5 : 30 * 864e5;
    return now - n * unit;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new Error(`bad --since "${s}" (use 60d, 2w, 12h, or a date)`);
}
function summarize(transcript) {
  const t = parseTranscriptFile(transcript);
  if (t.internal || !t.prompts.length) return null;
  const edited = /* @__PURE__ */ new Set();
  for (const c of t.toolCalls) if (["Edit", "Write", "MultiEdit"].includes(c.name) && typeof c.input.file_path === "string") edited.add(String(c.input.file_path).replace(/\\/g, "/"));
  return {
    session: t.sessionId || path33.basename(transcript, ".jsonl"),
    transcript,
    cwd: t.cwd,
    repo: t.cwd ? repoKey(t.cwd) : void 0,
    branch: t.gitBranch,
    started: t.startedAt,
    ended: t.endedAt,
    cost: Math.round(t.cost * 1e4) / 1e4,
    prompts: t.prompts.map((p) => p.text.slice(0, 500)),
    first_prompt: t.prompts[0]?.text.slice(0, 200) ?? "",
    tool_calls: t.toolCalls.length,
    files_edited: [...edited].slice(0, 50),
    models: t.models,
    version: t.version,
    mtime: fs33.statSync(transcript).mtimeMs
  };
}
function listTranscripts(projectsDir = path33.join(claudeHome(), "projects")) {
  if (!fs33.existsSync(projectsDir)) return [];
  const out = [];
  for (const d of fs33.readdirSync(projectsDir)) {
    const dir = path33.join(projectsDir, d);
    if (isInternalCwd(d) || !fs33.statSync(dir).isDirectory()) continue;
    for (const f of fs33.readdirSync(dir)) if (f.endsWith(".jsonl")) out.push(path33.join(dir, f));
  }
  return out;
}
function scanSessions(opts = {}) {
  const since = parseSince(opts.since, opts.now);
  const wantRepo = opts.repo ? repoKey(opts.repo) : void 0;
  const idx = opts.useIndex === false ? { entries: {} } : readJson(indexFile(), { entries: {} });
  const out = [];
  let dirty = false;
  for (const file of listTranscripts(opts.projectsDir)) {
    const st = fs33.statSync(file);
    if (st.mtimeMs < since - 7 * 864e5) continue;
    const key = file.replace(/\\/g, "/");
    let c = idx.entries[key];
    if (!c || c.indexed_mtime !== st.mtimeMs) {
      try {
        const s = summarize(file);
        if (!s) {
          delete idx.entries[key];
          continue;
        }
        c = { ...s, indexed_mtime: st.mtimeMs };
        idx.entries[key] = c;
        dirty = true;
      } catch {
        continue;
      }
    }
    if (!c.started || Date.parse(c.started) < since) continue;
    if (wantRepo && c.repo !== wantRepo) continue;
    out.push(c);
  }
  if (dirty && opts.useIndex !== false) writeJson(indexFile(), idx);
  return out.sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""));
}
var init_scan = __esm({
  "src/backfill/scan.ts"() {
    "use strict";
    init_paths();
    init_parse();
  }
});

// src/backfill/link.ts
import { spawnSync as spawnSync10 } from "node:child_process";
function githubRemote(cwd, deps = realLinkDeps) {
  const r = deps.exec("git", ["remote", "get-url", "origin"], cwd);
  if (!r.ok) return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
function linkFromPrompts(prompts) {
  for (const p of prompts) {
    const m = p.match(URL_RE);
    if (m?.length) return { kind: "url", ref: m[0], url: m[0].replace(/[.,]+$/, ""), confidence: 0.9, evidence: "URL in a prompt" };
  }
  return null;
}
function keysIn(text) {
  const keys = [...new Set([...text.matchAll(KEY_RE)].map((m) => m[1]).filter((k) => !/^(UTF|ISO|SHA|MD|RFC|CVE|HTTP|HTTPS|API|V|X|T)-?\d/.test(k)))];
  const hashes = [...new Set([...text.matchAll(HASH_RE)].map((m) => m[1]))];
  return { keys, hashes };
}
function commitsInWindow(cwd, branch, start, end, deps = realLinkDeps) {
  const ref = branch ? [branch] : ["--all"];
  const r = deps.exec("git", ["log", ...ref, `--since=${start}`, `--until=${end}`, "--format=%H%x1f%s%x1f%b%x1e"], cwd);
  if (!r.ok) {
    if (branch) return commitsInWindow(cwd, void 0, start, end, deps);
    return [];
  }
  return r.stdout.split("").map((rec) => rec.trim()).filter(Boolean).map((rec) => {
    const [sha = "", subject = "", body = ""] = rec.split("");
    return { sha: sha.trim(), subject, body };
  });
}
function detectTaskLink(input, deps = realLinkDeps) {
  const fromPrompt = linkFromPrompts(input.prompts);
  if (fromPrompt) return fromPrompt;
  const cwd = input.cwd;
  if (!cwd) return { kind: "none", ref: "", confidence: 0, evidence: "no cwd recorded" };
  const remote = githubRemote(cwd, deps);
  const commits = input.start && input.end ? commitsInWindow(cwd, input.branch, input.start, input.end, deps) : [];
  const branchKeys = keysIn(input.branch ?? "");
  const commitText = commits.map((c) => `${c.subject}
${c.body}`).join("\n");
  const commitKeys = keysIn(commitText);
  const key = branchKeys.keys[0] ?? commitKeys.keys[0];
  const hash = branchKeys.hashes[0] ?? commitKeys.hashes[0];
  if (key) {
    const where = branchKeys.keys[0] ? `branch "${input.branch}"` : `${commits.length} commit message(s) in the session window`;
    return { kind: "key", ref: key, confidence: 0.6, evidence: `issue key in ${where}` };
  }
  if (hash && remote) {
    const where = branchKeys.hashes[0] ? `branch "${input.branch}"` : "a commit message in the session window";
    return { kind: "key", ref: `#${hash}`, url: `https://github.com/${remote.owner}/${remote.repo}/issues/${hash}`, confidence: 0.6, evidence: `#${hash} in ${where}` };
  }
  if (deps.ghOk() && input.branch && input.branch !== "main" && input.branch !== "master") {
    const r = deps.exec("gh", ["pr", "list", "--state", "all", "--head", input.branch, "--json", "number,url,title,state", "--limit", "1"], cwd);
    if (r.ok) {
      try {
        const [pr] = JSON.parse(r.stdout);
        if (pr) return { kind: "pr", ref: `#${pr.number}`, url: pr.url, confidence: 0.7, evidence: `PR "${pr.title}" (${pr.state}) from branch "${input.branch}" overlaps the session` };
      } catch {
      }
    }
  }
  const why = commits.length ? `${commits.length} commit(s) in the window but no issue key or PR found` : "no URL in prompts, no commits in the session window";
  return { kind: "none", ref: "", confidence: 0, evidence: why + (deps.ghOk() ? "" : " (gh unavailable: PR lookup skipped)") };
}
var realLinkDeps, URL_RE, KEY_RE, HASH_RE;
var init_link = __esm({
  "src/backfill/link.ts"() {
    "use strict";
    init_gh();
    realLinkDeps = {
      exec: (bin, args, cwd) => {
        const r = spawnSync10(bin, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 3e4 });
        return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      ghOk: () => ghStatus().ok
    };
    URL_RE = /https?:\/\/(?:github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+|[^\s/]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|linear\.app\/[^\s/]+\/issue\/[A-Z0-9]+-\d+)[^\s)>\]]*/g;
    KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
    HASH_RE = /(?:^|[\s(])#(\d{1,6})\b/g;
  }
});

// src/backfill/history.ts
import fs34 from "node:fs";
import os6 from "node:os";
import path34 from "node:path";
import { spawnSync as spawnSync11 } from "node:child_process";
function revBefore(cwd, ref, ts, exec) {
  const r = exec("git", ["rev-list", "-1", `--before=${ts}`, ref], cwd);
  return r.ok ? r.stdout.trim() || void 0 : void 0;
}
function reconstructWindow(cwd, opts) {
  const exec = opts.exec ?? gitExecRaw;
  const notes = [];
  let branch = opts.branch;
  if (branch) {
    const ok = exec("git", ["rev-parse", "--verify", "--quiet", branch], cwd).ok;
    if (!ok) {
      notes.push(`branch "${branch}" no longer exists; using all refs`);
      branch = void 0;
    }
  }
  const ref = branch ?? "--all";
  let start_head = revBefore(cwd, ref, opts.start, exec);
  let end_head = revBefore(cwd, ref, opts.end, exec);
  const count = exec("git", ["rev-list", "--count", `--since=${opts.start}`, `--until=${opts.end}`, ref], cwd);
  const commits_in_window = count.ok ? Number(count.stdout.trim()) || 0 : 0;
  if (!start_head && commits_in_window > 0) {
    start_head = EMPTY_TREE;
    notes.push("no commit before the session start on this branch; diffing from the empty tree");
  } else if (!start_head) notes.push("no commit before the session start on this branch");
  if (commits_in_window === 0) notes.push("no commits inside the session window; uncommitted work cannot be recovered");
  let extended_to_pr;
  if (branch && (opts.ghOk ?? ghStatus().ok) && branch !== "main" && branch !== "master") {
    const r = exec("gh", ["pr", "list", "--state", "merged", "--head", branch, "--json", "headRefOid,number", "--limit", "1"], cwd);
    if (r.ok) {
      try {
        const [pr] = JSON.parse(r.stdout);
        if (pr?.headRefOid && exec("git", ["cat-file", "-e", `${pr.headRefOid}^{commit}`], cwd).ok) {
          end_head = pr.headRefOid;
          extended_to_pr = `#${pr.number}`;
          notes.push(`end extended to merged PR #${pr.number} head ${pr.headRefOid.slice(0, 8)}`);
        }
      } catch {
      }
    }
  }
  return { start_head, end_head, branch, commits_in_window, extended_to_pr, notes };
}
function addWorktree(cwd, sha, exec = gitExecRaw) {
  const dir = fs34.mkdtempSync(path34.join(os6.tmpdir(), "tally-wt-"));
  fs34.rmdirSync(dir);
  const r = exec("git", ["worktree", "add", "--detach", dir, sha], cwd);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 200)}`);
  return {
    path: dir,
    remove: () => {
      exec("git", ["worktree", "remove", "--force", dir], cwd);
      if (fs34.existsSync(dir)) fs34.rmSync(dir, { recursive: true, force: true });
      exec("git", ["worktree", "prune"], cwd);
    }
  };
}
async function prepareDeps(wt, timeoutMs) {
  const has2 = (f) => fs34.existsSync(path34.join(wt, f));
  if (has2("package.json")) {
    if (has2("node_modules")) return { ok: true, note: "node_modules present" };
    const pkg = JSON.parse(fs34.readFileSync(path34.join(wt, "package.json"), "utf8"));
    if (!Object.keys(pkg.dependencies ?? {}).length && !Object.keys(pkg.devDependencies ?? {}).length) return { ok: true, note: "no dependencies" };
    if (!has2("package-lock.json") && !has2("npm-shrinkwrap.json")) return { ok: false, note: "no lockfile; offline install not attempted" };
    const isWin = process.platform === "win32";
    const cmd = "npm ci --offline --ignore-scripts --no-audit --no-fund";
    const r = await runProcess(isWin ? "cmd.exe" : "sh", isWin ? ["/d", "/s", "/c", `"${cmd}"`] : ["-c", cmd], { cwd: wt, timeoutMs, env: scrubEnv(), replaceEnv: true });
    return r.code === 0 ? { ok: true, note: "npm ci --offline succeeded" } : { ok: false, note: `npm ci --offline failed (${r.timedOut ? "timeout" : "exit " + r.code}); dependencies unavailable offline` };
  }
  if (has2("requirements.txt") || has2("pyproject.toml")) return { ok: fs34.existsSync(path34.join(wt, ".venv")) || fs34.existsSync(path34.join(wt, "venv")), note: "python: runs only when a checked-in venv exists" };
  return { ok: true, note: "no dependency step needed" };
}
async function runHistoricalTests(wt, opts) {
  if (opts.consent !== true) return { ran: false, reason: "tests not run: no consent", consent: opts.consent };
  const detected = detectTestCommand(wt);
  if (!detected) return { ran: false, reason: "no test command detected", consent: true };
  const deps = await prepareDeps(wt, opts.timeoutMs);
  if (!deps.ok) return { ran: false, reason: `${HISTORICAL_UNRUNNABLE}: ${deps.note}`, consent: true, command: detected.command };
  const started = Date.now();
  const isWin = process.platform === "win32";
  const r = await runProcess(isWin ? "cmd.exe" : "sh", isWin ? ["/d", "/s", "/c", `"${detected.command}"`] : ["-c", detected.command], { cwd: wt, timeoutMs: opts.timeoutMs, env: scrubEnv(), replaceEnv: true });
  const out = (r.stdout + "\n" + r.stderr).trim();
  return { ran: true, command: detected.command, basis: `${detected.basis} (historical worktree; ${deps.note})`, passed: !r.timedOut && r.code === 0, exit_code: r.code, timed_out: r.timedOut, duration_ms: Date.now() - started, output_tail: out.length > 3e3 ? "\u2026" + out.slice(-3e3) : out, env_scrubbed: true, consent: true };
}
var gitExecRaw, HISTORICAL_UNRUNNABLE, EMPTY_TREE;
var init_history = __esm({
  "src/backfill/history.ts"() {
    "use strict";
    init_client();
    init_verify();
    init_gh();
    gitExecRaw = (bin, args, cwd) => {
      const r = spawnSync11(bin, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 6e4, maxBuffer: 20 * 1024 * 1024 });
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    HISTORICAL_UNRUNNABLE = "historical tests not runnable";
    EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  }
});

// src/backfill/events.ts
function eventsFromTranscript(t, session, cwd, transcriptPath, gitHead) {
  const ev = [];
  const push = (ts, type, data) => ev.push({ ts, type, session, cwd, data });
  const start = t.startedAt ?? (/* @__PURE__ */ new Date(0)).toISOString();
  const end = t.endedAt ?? start;
  const mcp = [...new Set(t.mcpCalls.map((m) => m.server))];
  const skills = [...new Set(t.skills.map((s) => s.name))];
  push(start, "session_start", { source: "backfill", model: t.models[0], transcript_path: transcriptPath, git_head: gitHead, loaded: { mcp, skills, plugins: [] }, synthesized: true });
  for (const p of t.prompts) push(p.ts, "prompt", { prompt: redact(p.text.slice(0, 2e3)), chars: p.text.length, turn: p.turn });
  for (const c of t.toolCalls) {
    if (c.agent !== "main") continue;
    const input = {};
    for (const [k, v] of Object.entries(c.input)) input[k] = typeof v === "string" ? redact(v.slice(0, 600)) : v;
    push(c.ts, "pre_tool", { tool_name: c.name, tool_input: input, tool_use_id: c.id, agent: null });
    const text = c.result?.text ?? "";
    push(c.ts, "post_tool", { tool_name: c.name, tool_input: input, tool_use_id: c.id, is_error: !!c.result?.isError, response_chars: c.result?.chars ?? 0, response_head: redact(text.slice(0, 600)), agent: null });
    const cmd = typeof c.input.command === "string" ? c.input.command : "";
    if (c.name === "Bash" && cmd && isShipCommand(cmd) && !c.result?.isError) {
      const kind = /gh\s+pr\s+create/.test(cmd) ? "pr" : /gh\s+pr\s+merge/.test(cmd) ? "merge" : /publish|upload/.test(cmd) ? "publish" : "push";
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      push(c.ts, "ship", { kind, command: redact(cmd), url });
    }
  }
  for (const c of t.compactions) push(c.ts, "pre_compact", { trigger: "auto" });
  if (t.finalAssistantText) push(end, "stop", { last_assistant_message: redact(t.finalAssistantText.slice(0, 800)) });
  push(end, "session_end", { reason: "backfill", transcript_path: transcriptPath });
  return ev.sort((a, b) => a.ts.localeCompare(b.ts));
}
function replayCoach(opts) {
  const engine = new CoachEngine({ shown: 0, shown_keys: [], skips: {}, llm_events_seen: 0 }, opts.cfg, void 0, {});
  const base = buildContext({ session: opts.session, cwd: opts.cwd, cfg: opts.cfg, events: [], transcript: opts.transcript, history: opts.history ?? [] });
  const shown = [];
  let held = 0;
  const mains = opts.transcript.messages.filter((m) => m.agent === "main");
  for (let i = 0; i < opts.events.length; i++) {
    const now = new Date(opts.events[i].ts);
    const upTo = opts.events.slice(0, i + 1);
    const prefix = mains.filter((m) => Date.parse(m.ts) <= now.getTime());
    const last = prefix.at(-1);
    const ctx = { ...base, now, events: upTo, spendUsd: prefix.reduce((s, m) => s + m.cost, 0), contextTokensNow: last ? last.usage.input + last.usage.cache_read + last.usage.cache_write : 0 };
    const r = engine.tick(ctx);
    held += r.held.length;
    for (const s of r.show) shown.push({ ts: now.toISOString(), rule: s.rule, key: s.key, severity: s.severity, title: s.title, message: s.message, usd_saved: Math.round(s.usd_saved * 1e3) / 1e3, action: s.action.kind });
  }
  return { session: opts.session, replayed_at: (/* @__PURE__ */ new Date()).toISOString(), events: opts.events.length, shown, held, note: "deterministic rules only, replayed with the session timestamps and the normal noise limits; the LLM coach pass is not replayed" };
}
var init_events2 = __esm({
  "src/backfill/events.ts"() {
    "use strict";
    init_parse();
    init_engine();
    init_context();
    init_redact();
  }
});

// src/backfill/ticket.ts
async function ticketAsOf(fetched, sessionStart, cfg, deps = realDeps) {
  const current = { title: fetched.title, body: fetched.body, as_of: "current", note: "ticket text is the current version; it may have changed since the session" };
  try {
    if (fetched.source.kind === "jira" && fetched.source.key && cfg.jira.base_url && cfg.jira.email && cfg.jira.api_token) return await jiraAsOf(fetched, sessionStart, cfg, deps, current);
    if (fetched.source.kind === "github" && fetched.source.owner && fetched.source.repo && fetched.source.number) return await githubAsOf(fetched, sessionStart, deps, current);
  } catch (err) {
    return { ...current, note: `${current.note} (history lookup failed: ${err instanceof Error ? err.message : String(err)})` };
  }
  return current;
}
async function jiraAsOf(fetched, sessionStart, cfg, deps, current) {
  const auth = Buffer.from(`${cfg.jira.email}:${cfg.jira.api_token}`).toString("base64");
  const base = cfg.jira.base_url.replace(/\/$/, "");
  const changes = [];
  let startAt = 0;
  for (let page = 0; page < 20; page++) {
    const r = await deps.fetch(`${base}/rest/api/3/issue/${fetched.source.key}/changelog?startAt=${startAt}&maxResults=100`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (!r.ok) return { ...current, note: `${current.note} (Jira changelog ${r.status})` };
    const j = JSON.parse(await r.text());
    changes.push(...j.values ?? []);
    if (j.isLast !== false || !j.values?.length) break;
    startAt += j.values.length;
  }
  const later = changes.filter((c) => c.created > sessionStart).sort((a, b) => b.created.localeCompare(a.created));
  let title = fetched.title;
  let body = fetched.body;
  let applied = 0;
  for (const c of later) {
    for (const it of c.items ?? []) {
      if (it.field === "summary" && typeof it.fromString === "string") {
        title = it.fromString;
        applied += 1;
      } else if (it.field === "description" && typeof it.fromString === "string") {
        body = it.fromString;
        applied += 1;
      }
    }
  }
  if (!applied) return { ...current, as_of: "session_start", note: "ticket unchanged since the session (Jira changelog)" };
  return { title, body, as_of: "session_start", note: `ticket text reconstructed from the Jira changelog (${applied} later change(s) reverted)` };
}
async function githubAsOf(fetched, sessionStart, deps, current) {
  const { owner, repo, number } = fetched.source;
  const tl = deps.exec("gh", ["api", `repos/${owner}/${repo}/issues/${number}/timeline`, "--paginate", "--jq", '[.[] | select(.event == "renamed") | {created_at, from: .rename.from, to: .rename.to}]']);
  let title = fetched.title;
  let renames = 0;
  if (tl.ok) {
    try {
      const evs = JSON.parse(tl.stdout.trim().replace(/\]\s*\[/g, ",")).filter((e) => e.created_at > sessionStart).sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const e of evs) {
        title = e.from;
        renames += 1;
      }
    } catch {
    }
  }
  const kind = fetched.source.is_pr ? "pullRequest" : "issue";
  const q = `query { repository(owner: "${owner}", name: "${repo}") { ${kind}(number: ${number}) { createdAt userContentEdits(first: 100) { nodes { editedAt diff } } } } }`;
  const ed = deps.exec("gh", ["api", "graphql", "-f", `query=${q}`]);
  let body = fetched.body;
  let note = "";
  if (ed.ok) {
    try {
      const j = JSON.parse(ed.stdout);
      const node = j.data?.repository?.[kind];
      const edits = (node?.userContentEdits?.nodes ?? []).filter((e) => typeof e.diff === "string").sort((a, b) => a.editedAt.localeCompare(b.editedAt));
      const before = edits.filter((e) => e.editedAt <= sessionStart);
      const after = edits.filter((e) => e.editedAt > sessionStart);
      if (before.length) {
        body = before[before.length - 1].diff ?? body;
        note = `body as of the last edit before the session (${before[before.length - 1].editedAt.slice(0, 10)})`;
      } else if (after.length) note = `body was edited ${after.length} time(s) after the session and the original text is not exposed by the API; current body used`;
      else note = "body never edited";
    } catch {
      note = "edit history unavailable";
    }
  } else note = "edit history unavailable (gh api failed)";
  const asOf = renames || /as of the last edit|never edited/.test(note) ? "session_start" : "current";
  return { title, body, as_of: asOf, note: `${renames ? `title restored from ${renames} later rename(s); ` : ""}${note}` };
}
var init_ticket = __esm({
  "src/backfill/ticket.ts"() {
    "use strict";
    init_fetchers();
  }
});

// src/backfill/run.ts
import fs35 from "node:fs";
import path35 from "node:path";
function projectCost(candidates, cfg) {
  const tier2 = candidates.filter((c) => c.cost >= cfg.judge.deepThreshold).length;
  const n = candidates.length;
  const intake2 = n * 0.01;
  const tier1 = n * 0.015;
  const t2 = tier2 * 0.12;
  return { sessions: n, intake_usd: intake2, tier1_usd: tier1, tier2_usd: t2, total_usd: intake2 + tier1 + t2, tier2_sessions: tier2 };
}
async function backfillSession(c, opts) {
  const log2 = opts.log ?? (() => {
  });
  const cfg = opts.cfg;
  const deps = opts.deps ?? {};
  const session = c.session;
  const cwd = c.cwd;
  const t = parseTranscriptFile(c.transcript);
  if (t.internal) return { session, link: { kind: "none", ref: "", confidence: 0, evidence: "internal run" }, window: { commits_in_window: 0, notes: [] }, skipped: "internal Tally run", tally_spend_usd: 0 };
  if (!cwd || !fs35.existsSync(cwd)) return { session, link: { kind: "none", ref: "", confidence: 0, evidence: "cwd missing" }, window: { commits_in_window: 0, notes: [] }, skipped: `repo directory no longer exists: ${cwd ?? "?"}`, tally_spend_usd: 0 };
  const start = c.started ?? t.startedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const end = c.ended ?? t.endedAt ?? start;
  const link = opts.taskRef ? { kind: /^https?:\/\//.test(opts.taskRef) ? "url" : "key", ref: opts.taskRef, url: /^https?:\/\//.test(opts.taskRef) ? opts.taskRef : void 0, confidence: 1, evidence: "given with --task" } : detectTaskLink({ cwd, branch: c.branch, prompts: c.prompts, start, end }, deps.link ?? realLinkDeps);
  const window = reconstructWindow(cwd, { branch: c.branch, start, end, exec: deps.git, ghOk: deps.ghOk });
  log2(`  window: ${window.start_head?.slice(0, 8) ?? "?"} \u2192 ${window.end_head?.slice(0, 8) ?? "?"} (${window.commits_in_window} commit(s))${window.notes.length ? "; " + window.notes.join("; ") : ""}`);
  const noTree = !window.end_head || !window.start_head;
  if (noTree) window.notes.push("no commits inside the session window: evidence reconstructed from the transcript, tests not run");
  const dir = ensureDir(sessionDir(session)) ?? sessionDir(session);
  const events = eventsFromTranscript(t, session, cwd, c.transcript, window.start_head);
  fs35.writeFileSync(eventsFile(session), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeJson(path35.join(dir, "backfill.json"), { session, link, window, started: start, ended: end, repo: cwd, transcript: c.transcript, backfilled_at: (/* @__PURE__ */ new Date()).toISOString() });
  let task = loadTask(session);
  if (!task) {
    const ref = link.url ?? (link.kind === "key" ? link.ref : void 0);
    const text = c.prompts[0] ?? c.first_prompt;
    const fetched = await fetchTask(ref ?? text, { cwd, cfg, deps: deps.fetch, promptText: text });
    const asOf = ref ? await ticketAsOf(fetched, start, cfg, deps.fetch) : { title: fetched.title, body: fetched.body, as_of: "current", note: "no tracker link; criteria come from the first prompt as recorded in the transcript" };
    const commits = commitsInWindow(cwd, c.branch, start, end, deps.link ?? realLinkDeps).map((x) => x.subject);
    const r = await intake({ session, cwd, ref, text: ref ? void 0 : text, cfg, llm: opts.llm, deps: deps.fetch, override: ref ? { title: asOf.title, body: asOf.body } : void 0, historical: { ticket_as_of: asOf.as_of, note: asOf.note }, context: ref ? void 0 : { branch: c.branch, commits } });
    task = r.task;
    log2(`  task: "${task.title}" (${task.criteria.length} criteria, ${task.criteria.filter((x) => x.kind === "mechanical").length} mechanical${task.cached ? ", intake cached" : ""}) \xB7 ${asOf.note}`);
  }
  let judge;
  if (noTree) {
    judge = await judgeSession({ session, cwd, repoCwd: cwd, transcriptPath: c.transcript, cfg, llm: opts.llm, reason: "manual", events, verification: { ran: false, reason: "no git tree for this session; tests run only against a real tree" }, task, skipGit: true, historical: { start_head: window.start_head, end_head: window.end_head, notes: window.notes } });
    log2(`  evidence: reconstructed from the transcript (${judge.evidence.reconstructed_files.length} file(s), ${judge.evidence.bash_edits} shell edit(s))`);
  } else {
    const wt = addWorktree(cwd, window.end_head, deps.git ?? gitExecRaw);
    try {
      const consent = testRerunConsent(cfg, cwd);
      const ver = await runHistoricalTests(wt.path, { consent, timeoutMs: cfg.judge.test_timeout_ms });
      log2(`  tests: ${ver.ran ? `${ver.command} \u2192 ${ver.passed ? "passed" : "failed"}` : ver.reason}`);
      judge = await judgeSession({ session, cwd: wt.path, repoCwd: cwd, transcriptPath: c.transcript, cfg, llm: opts.llm, reason: "manual", events, verification: ver, task, consent, historical: { start_head: window.start_head, end_head: window.end_head, notes: [...window.notes, ver.reason?.startsWith(HISTORICAL_UNRUNNABLE) ? ver.reason : ""].filter(Boolean) } });
    } finally {
      wt.remove();
    }
  }
  const fu = followupSession(session, deps.followup);
  if (fu) judge = fu;
  log2(`  judged: ${judge.verdict.verdict} (${judge.completion_pct}%), tiers ${judge.tiers.ran.join("\u2192")}${judge.followup ? ` \xB7 follow-up: ${judge.followup.final_status} \u2192 ${judge.followup.final_verdict}` : ""}`);
  const replay = replayCoach({ session, cwd, cfg, events, transcript: t, history: loadHistory() });
  writeJson(path35.join(dir, "coach_replay.json"), replay);
  log2(`  coach replay: ${replay.shown.length} suggestion(s) would have shown (${replay.held} held by noise limits)`);
  appendLine(path35.join(sessionDir(session), "backfill.log"), `${(/* @__PURE__ */ new Date()).toISOString()} backfilled`);
  return { session, link, window, task, judge, replay, tally_spend_usd: tallyOwnSpend(session) };
}
function isBackfilled(session) {
  return fs35.existsSync(path35.join(sessionDir(session), "backfill.json")) && !!loadJudge(session);
}
var init_run = __esm({
  "src/backfill/run.ts"() {
    "use strict";
    init_config();
    init_parse();
    init_paths();
    init_events();
    init_intake();
    init_fetchers();
    init_judge();
    init_followup();
    init_link();
    init_history();
    init_events2();
    init_ticket();
    init_context();
  }
});

// src/commands/backfill.ts
var backfill_exports = {};
__export(backfill_exports, {
  run: () => run20
});
import fs36 from "node:fs";
import path36 from "node:path";
function shortRepo(repo) {
  if (!repo) return "?";
  const parts = repo.split("/");
  return parts.slice(-2).join("/");
}
async function run20(args) {
  const cfg = loadConfig();
  const sub = args._[0] ?? "list";
  const since = flag(args, "since") ?? "60d";
  const repo = flag(args, "repo");
  const plain = has(args, "plain");
  if (sub === "list" && flag(args, "suggest")) {
    const n = Math.max(1, Number(flag(args, "suggest")) || 20);
    const cands = scanSessions({ since, repo }).filter((c) => c.cwd && fs36.existsSync(c.cwd) && c.cost >= 0.2);
    const scored = cands.map((c) => {
      const link = detectTaskLink({ cwd: c.cwd, branch: c.branch, prompts: c.prompts, start: c.started, end: c.ended });
      const why = [];
      let score = c.cost;
      if (c.files_edited.length) why.push(`${c.files_edited.length} file(s) edited`);
      else score *= 0.25;
      if (link.kind !== "none") {
        score *= 1.3;
        why.push(`link ${link.kind} ${link.confidence.toFixed(1)}`);
      } else why.push("task inferred from prompts");
      if (c.first_prompt.trim().length < 40) score *= 0.5;
      else why.push("concrete first prompt");
      return { c, link, score, why, state: isBackfilled(c.session) ? "backfilled" : "" };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, n);
    process.stdout.write(`Top ${top.length} of ${cands.length} candidate(s) since ${since} for calibration (by cost, edits and link; sessions without commits are judged from the transcript reconstruction, tests not run)

`);
    process.stdout.write(`${"session".padEnd(10)} ${"date".padEnd(11)} ${"repo".padEnd(26)} ${"cost".padStart(8)}  ${"why".padEnd(52)} state
`);
    for (const s of top) process.stdout.write(`${s.c.session.slice(0, 8).padEnd(10)} ${(s.c.started ?? "").slice(0, 10).padEnd(11)} ${shortRepo(s.c.repo).slice(0, 26).padEnd(26)} ${fmtUsd(s.c.cost).padStart(8)}  ${s.why.join(", ").slice(0, 52).padEnd(52)} ${s.state}
${"".padEnd(10)} ${"".padEnd(11)} ${s.c.first_prompt.replace(/\s+/g, " ").slice(0, 90)}
`);
    const proj = projectCost(top.filter((s) => !s.state).map((s) => s.c), cfg);
    process.stdout.write(`
Projected Tally spend to backfill the ${top.filter((s) => !s.state).length} not yet done: ${fmtUsd(proj.total_usd)}.
Next: tally backfill add <session> [--max-spend 3]
`);
    return;
  }
  if (sub === "list") {
    const cands = scanSessions({ since, repo });
    if (!cands.length) {
      process.stdout.write(`No sessions with prompts found in the last ${since}${repo ? ` for ${repo}` : ""}.
`);
      return;
    }
    process.stdout.write(`${cands.length} session(s) since ${since}${repo ? ` in ${repo}` : ""} (task link: URL in prompt > issue key in branch/commits > PR on branch)

`);
    process.stdout.write(`${"session".padEnd(10)} ${"date".padEnd(11)} ${"repo".padEnd(28)} ${"cost".padStart(8)}  ${"link".padEnd(40)} conf   state
`);
    let linked = 0;
    for (const c of cands) {
      const link = detectTaskLink({ cwd: c.cwd, branch: c.branch, prompts: c.prompts, start: c.started, end: c.ended });
      if (link.kind !== "none") linked += 1;
      const state = isBackfilled(c.session) ? "backfilled" : "";
      const linkText = link.kind === "none" ? "(none)" : `${link.url ?? link.ref}`;
      process.stdout.write(`${c.session.slice(0, 8).padEnd(10)} ${(c.started ?? "").slice(0, 10).padEnd(11)} ${shortRepo(c.repo).slice(0, 28).padEnd(28)} ${fmtUsd(c.cost).padStart(8)}  ${linkText.slice(0, 40).padEnd(40)} ${link.confidence.toFixed(1).padStart(4)}   ${state}
`);
      if (!plain) process.stdout.write(`${"".padEnd(10)} ${"".padEnd(11)} ${c.first_prompt.replace(/\s+/g, " ").slice(0, 70)}  \xB7 ${link.evidence}
`);
    }
    const proj = projectCost(cands, cfg);
    process.stdout.write(`
${linked}/${cands.length} with a detected task link. Projected cost to backfill all: ${fmtUsd(proj.total_usd)} (intake ${fmtUsd(proj.intake_usd)}, tier 1 ${fmtUsd(proj.tier1_usd)}, tier 2 ${fmtUsd(proj.tier2_usd)} on ${proj.tier2_sessions} session(s) \u2265 $${cfg.judge.deepThreshold}).
`);
    process.stdout.write(`Next: tally backfill add <session> [--task <url|text>]   or   tally backfill add all --max-spend 3
`);
    return;
  }
  if (sub === "add") {
    const target = args._[1];
    if (!target) {
      process.stderr.write("Usage: tally backfill add <session-prefix|all> [--task <url|text>] [--since 60d] [--repo path] [--max-spend 3] [--force]\n");
      return 1;
    }
    const cands = scanSessions({ since, repo });
    const chosen = target === "all" ? cands.filter((c) => !isBackfilled(c.session) || has(args, "force")) : cands.filter((c) => c.session.startsWith(target));
    if (!chosen.length) {
      process.stderr.write(target === "all" ? "Nothing to backfill (all candidates already done; pass --force to redo).\n" : `No session starting with "${target}" in the last ${since}. Run tally backfill list.
`);
      return 1;
    }
    if (chosen.length > 1 && target !== "all") {
      process.stderr.write(`"${target}" matches ${chosen.length} sessions; give more characters.
`);
      return 1;
    }
    const maxSpend = Number(flag(args, "max-spend") ?? 3);
    const proj = projectCost(chosen, cfg);
    process.stdout.write(`Backfilling ${chosen.length} session(s). Projected Tally spend ${fmtUsd(proj.total_usd)} (cap ${fmtUsd(maxSpend)}; intake hits the cache when the ticket text is unchanged).
`);
    const cwds = [...new Set(chosen.map((c) => c.cwd).filter((x) => !!x))];
    for (const c of cwds) {
      const consent = testRerunConsent(cfg, c);
      if (consent === void 0) process.stdout.write(`  ${c}: no test re-run consent stored; historical tests will not run (tally config consent on, run from that repo, to allow).
`);
    }
    let spent = 0;
    let done = 0;
    for (const c of chosen) {
      if (spent >= maxSpend) {
        process.stdout.write(`Stopped: Tally spend ${fmtUsd(spent)} reached the --max-spend cap ${fmtUsd(maxSpend)} after ${done} session(s).
`);
        break;
      }
      if (isBackfilled(c.session) && !has(args, "force")) {
        process.stdout.write(`${c.session.slice(0, 8)}: already backfilled (--force to redo)
`);
        continue;
      }
      if (has(args, "force")) {
        for (const f of ["judge.json", "task.json", "coach_replay.json"]) if (fs36.existsSync(path36.join(sessionDir(c.session), f))) fs36.unlinkSync(path36.join(sessionDir(c.session), f));
      }
      process.stdout.write(`${c.session.slice(0, 8)} ${(c.started ?? "").slice(0, 10)} ${shortRepo(c.repo)} ${fmtUsd(c.cost)}
`);
      try {
        const r = await backfillSession(c, { cfg, llm: makeLlm({ session: c.session }), taskRef: flag(args, "task"), log: (s) => process.stdout.write(s + "\n") });
        if (r.skipped) process.stdout.write(`  skipped: ${r.skipped}
`);
        spent += r.tally_spend_usd;
        done += 1;
      } catch (err) {
        process.stdout.write(`  failed: ${err instanceof Error ? err.message : String(err)}
`);
      }
    }
    process.stdout.write(`
Done: ${done} session(s), Tally spend ${fmtUsd(spent)}. Grade them blind: tally calibrate grade <session> [--grader you]
`);
    return;
  }
  process.stderr.write("Usage: tally backfill list|add\n");
  return 1;
}
var init_backfill = __esm({
  "src/commands/backfill.ts"() {
    "use strict";
    init_cli();
    init_config();
    init_client();
    init_scan();
    init_link();
    init_run();
    init_pricing();
    init_paths();
  }
});

// src/cli.ts
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
          out.flags[key] = next;
          i += 1;
        } else {
          out.flags[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
function flag(args, name) {
  const v = args.flags[name];
  return typeof v === "string" ? v : void 0;
}
function has(args, name) {
  return args.flags[name] !== void 0 && args.flags[name] !== false;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  if (has(args, "version") || cmd === "version") {
    process.stdout.write("tally 0.1.0\n");
    return;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || has(args, "help")) {
    process.stdout.write(HELP);
    return;
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(`Unknown command: ${cmd}

${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    const mod = await loader();
    const code = await mod.run(args);
    if (typeof code === "number") process.exitCode = code;
    if (has(args, "plugin") && PLUGIN_HINTS[cmd]) process.stdout.write(`
${PLUGIN_HINTS[cmd]}
`);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    log(`command ${cmd} failed: ${msg}`);
    if (has(args, "auto")) return;
    process.stderr.write(`tally ${cmd}: ${err instanceof Error ? err.message : String(err)}
`);
    process.exitCode = 1;
  }
}
var COMMANDS, HELP, PLUGIN_HINTS;
var init_cli = __esm({
  "src/cli.ts"() {
    init_paths();
    COMMANDS = {
      install: () => Promise.resolve().then(() => (init_install2(), install_exports)),
      uninstall: () => Promise.resolve().then(() => (init_install2(), install_exports)).then((m) => ({ run: m.runUninstall })),
      task: () => Promise.resolve().then(() => (init_task(), task_exports)),
      judge: () => Promise.resolve().then(() => (init_judge2(), judge_exports)),
      finalize: () => Promise.resolve().then(() => (init_finalize(), finalize_exports)),
      followup: () => Promise.resolve().then(() => (init_followup2(), followup_exports)),
      watch: () => Promise.resolve().then(() => (init_watch(), watch_exports)),
      start: () => Promise.resolve().then(() => (init_start(), start_exports)),
      coach: () => Promise.resolve().then(() => (init_coach(), coach_exports)),
      undo: () => Promise.resolve().then(() => (init_undo2(), undo_exports)),
      experiment: () => Promise.resolve().then(() => (init_experiment2(), experiment_exports)),
      report: () => Promise.resolve().then(() => (init_report4(), report_exports)),
      doctor: () => Promise.resolve().then(() => (init_doctor(), doctor_exports)),
      demo: () => Promise.resolve().then(() => (init_demo2(), demo_exports)),
      status: () => Promise.resolve().then(() => (init_status(), status_exports)),
      statusline: () => Promise.resolve().then(() => (init_statusline(), statusline_exports)),
      config: () => Promise.resolve().then(() => (init_config2(), config_exports)),
      sessions: () => Promise.resolve().then(() => (init_sessions(), sessions_exports)),
      otel: () => Promise.resolve().then(() => (init_otel2(), otel_exports)),
      calibrate: () => Promise.resolve().then(() => (init_calibrate2(), calibrate_exports)),
      backfill: () => Promise.resolve().then(() => (init_backfill(), backfill_exports))
    };
    HELP = `tally \u2014 per-task receipts and live coaching for Claude Code

Usage: tally <command> [options]

Setup
  install [--project]         Add Tally hooks + status line to Claude Code settings (backs up first)
  uninstall [--project]       Remove hooks; settings return byte-identical
  doctor                      Check claude, gh, hooks, pricing, config
  config [key value]          Show or set config (hourly_rate, writeback, auto_apply, models.*)

Judge
  task <url|path|text>        Link a task to the current session; freeze acceptance criteria
  judge [session] [--post]    Produce the receipt (judge.json + report.md); --post comments on issue/PR
  followup [session]          Post-merge truth: merged, reverted, reopened, review churn, CI
  report                      Trends: cost per task, completion, rework, skill/MCP payoff
  sessions                    List tracked sessions
  status [--session id]       What Tally knows about a session

Coach
  start                       Open the Coach pane (tmux split if available)
  watch [session]             Attach the Coach to the latest active session
  coach --once                Print pending suggestions and exit
  coach --tick                One autopilot pass (the Stop hook runs this after every turn)
  statusline [--install]      Claude Code status line: task, spend vs budget, context, Coach flags
  undo [n]                    Reverse the last Coach change(s)

Experiments
  experiment start <skill|mcp> <name> --tasks N
  experiment report
  experiment stop

Backfill (past sessions from ~/.claude/projects)
  backfill list [--since 60d] [--repo path]     candidates with cost and detected task link
  backfill add <session|all> [--task <url|text>] [--max-spend 3]   reconstruct, judge, follow up, replay the Coach

Calibration
  calibrate grade <session> [--grader name]     blind grading of a backfilled receipt
  calibrate add <session> --human met,partial,... [--verdict "worth it"]
  calibrate report [--source backfill|human|fixture]   agreement, confusion, lean, inter-grader, Coach precision
  calibrate rescore [--grader name]             refresh the judge side of graded sessions from their current receipts
  calibrate eval [--live] [--record] [--fail-below N]   Regression eval on the fixture sessions

Other
  otel [--port 4318]          Loopback OTLP receiver for Claude Code telemetry (optional cost cross-check)
  demo                        Replay a fixture session end to end with a stubbed LLM
`;
    PLUGIN_HINTS = {
      coach: "The live Coach pane with one-key actions needs the CLI: npm i -g @kru3ish/tally, then `tally watch` in a second terminal.",
      status: "For the live Coach pane, backfill and blind grading install the CLI: npm i -g @kru3ish/tally",
      report: "Receipts for past sessions and blind grading need the CLI: npm i -g @kru3ish/tally, then `tally backfill list` and `tally calibrate grade`."
    };
    void main();
  }
});
init_cli();
export {
  flag,
  has,
  parseArgs
};
