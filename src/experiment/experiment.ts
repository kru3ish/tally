import fs from 'node:fs';
import path from 'node:path';
import { experimentsFile, readJson, writeJson, repoKey, ensureDir, tallyHome } from '../paths.js';

export interface Experiment {
  id: string;
  repo: string;
  kind: 'skill' | 'mcp';
  name: string;
  tasks_total: number;
  started_at: string;
  stopped_at?: string;
  assignments: Array<{ session: string; arm: 'on' | 'off'; started_at: string; applied: boolean }>;
  next_arm: 'on' | 'off';
  applied?: { session?: string; arm: 'on' | 'off'; settings_file: string; backup_file: string; had_file: boolean };
}

interface ExperimentsDb {
  experiments: Experiment[];
}

export function loadExperiments(): ExperimentsDb {
  return readJson<ExperimentsDb>(experimentsFile(), { experiments: [] });
}

export function saveExperiments(db: ExperimentsDb): void {
  writeJson(experimentsFile(), db);
}

export function activeExperiment(cwd: string): Experiment | undefined {
  const key = repoKey(cwd);
  return loadExperiments().experiments.find((e) => e.repo === key && !e.stopped_at && e.assignments.length < e.tasks_total);
}

export function startExperiment(cwd: string, kind: 'skill' | 'mcp', name: string, tasks: number): Experiment {
  const db = loadExperiments();
  const key = repoKey(cwd);
  for (const e of db.experiments) if (e.repo === key && !e.stopped_at) e.stopped_at = new Date().toISOString();
  const exp: Experiment = { id: `${kind}-${name}-${Date.now().toString(36)}`, repo: key, kind, name, tasks_total: tasks, started_at: new Date().toISOString(), assignments: [], next_arm: 'off' };
  db.experiments.push(exp);
  saveExperiments(db);
  applyArm(cwd, exp);
  return exp;
}

export function stopExperiment(cwd: string): Experiment | undefined {
  const db = loadExperiments();
  const key = repoKey(cwd);
  const exp = db.experiments.find((e) => e.repo === key && !e.stopped_at);
  if (!exp) return undefined;
  exp.stopped_at = new Date().toISOString();
  saveExperiments(db);
  restoreExperimentConfig(cwd);
  return exp;
}

function localSettingsPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.local.json');
}

function backupPath(exp: Experiment): string {
  return path.join(tallyHome(), 'backups', `experiment-${exp.id}-settings.local.json`);
}

/* Applies the next arm to .claude/settings.local.json so the *next* session starts with it.
   "off" for a skill = permissions.deny Skill(name); "off" for an mcp = disabledMcpjsonServers + disabledMcpServers.
   The pre-change file is backed up and restored byte-identically at session end. */
export function applyArm(cwd: string, exp: Experiment): void {
  if (exp.applied) return;
  const file = localSettingsPath(cwd);
  const hadFile = fs.existsSync(file);
  const bk = backupPath(exp);
  ensureDir(path.dirname(bk));
  if (hadFile) fs.copyFileSync(file, bk);
  else if (fs.existsSync(bk)) fs.unlinkSync(bk);
  const settings = hadFile ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  if (exp.next_arm === 'off') {
    if (exp.kind === 'skill') {
      const perms = (settings.permissions ??= {}) as Record<string, unknown>;
      const deny = ((perms.deny ??= []) as string[]);
      const rule = `Skill(${exp.name})`;
      if (!deny.includes(rule)) deny.push(rule);
    } else {
      for (const key of ['disabledMcpjsonServers', 'disabledMcpServers']) {
        const arr = ((settings[key] ??= []) as string[]);
        if (!arr.includes(exp.name)) arr.push(exp.name);
      }
    }
    settings._tally_experiment = { id: exp.id, arm: 'off', note: 'temporary; restored by tally at session end' };
  } else {
    settings._tally_experiment = { id: exp.id, arm: 'on', note: 'temporary marker; restored by tally at session end' };
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  const db = loadExperiments();
  const target = db.experiments.find((e) => e.id === exp.id);
  if (target) {
    target.applied = { arm: exp.next_arm, settings_file: file, backup_file: bk, had_file: hadFile };
    saveExperiments(db);
  }
}

export function recordAssignment(cwd: string, session: string): 'on' | 'off' | undefined {
  const db = loadExperiments();
  const exp = db.experiments.find((e) => e.repo === repoKey(cwd) && !e.stopped_at && e.assignments.length < e.tasks_total);
  if (!exp || !exp.applied) return undefined;
  if (exp.applied.session && exp.applied.session !== session) return exp.applied.arm;
  if (!exp.applied.session) {
    exp.applied.session = session;
    exp.assignments.push({ session, arm: exp.applied.arm, started_at: new Date().toISOString(), applied: true });
    saveExperiments(db);
  }
  return exp.applied.arm;
}

export function restoreExperimentConfig(cwd: string, session?: string): boolean {
  const db = loadExperiments();
  const key = repoKey(cwd);
  let restored = false;
  for (const exp of db.experiments) {
    if (exp.repo !== key || !exp.applied) continue;
    if (session && exp.applied.session && exp.applied.session !== session) continue;
    const { settings_file, backup_file, had_file } = exp.applied;
    if (had_file && fs.existsSync(backup_file)) fs.copyFileSync(backup_file, settings_file);
    else if (!had_file && fs.existsSync(settings_file)) fs.unlinkSync(settings_file);
    if (fs.existsSync(backup_file)) fs.unlinkSync(backup_file);
    exp.next_arm = exp.applied.arm === 'on' ? 'off' : 'on';
    delete exp.applied;
    restored = true;
  }
  if (restored) saveExperiments(db);
  return restored;
}

export function prepareNextArm(cwd: string): void {
  const exp = activeExperiment(cwd);
  if (exp && !exp.applied) applyArm(cwd, exp);
}
