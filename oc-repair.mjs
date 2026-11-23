#!/usr/bin/env node
/**
 * OpenCodeRepair — cross-platform maintenance tool for Open Code desktop app.
 * Runs on Windows, macOS, and Linux. Uses system Node with node:sqlite (Node 22+).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_VERSION = '1.0.0';
const HELPER_PATH = path.join(__dirname, 'lib', 'oc-data.mjs');

const COLORS = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function logStep(text) { console.log(`${COLORS.cyan}\n== ${text}${COLORS.reset}`); }
function logOk(text) { console.log(`${COLORS.green}   [ok]   ${text}${COLORS.reset}`); }
function logWarn(text) { console.log(`${COLORS.yellow}   [warn] ${text}${COLORS.reset}`); }
function logBad(text) { console.log(`${COLORS.red}   [fail] ${text}${COLORS.reset}`); }
function logInfo(text) { console.log(`${COLORS.gray}   ${text}${COLORS.reset}`); }

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function getDirSize(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        try { total += fs.statSync(path.join(entry.parentPath ?? dir, entry.name)).size; } catch {}
      }
    }
    return total;
  } catch { return 0; }
}

// ------------------------------------------------------------- Platform paths
function getPlatformPaths() {
  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'win32') {
    return {
      appCandidates: [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ai.opencode.desktop'),
        'C:\\Program Files\\ai.opencode.desktop',
      ],
      dataRoot: path.join(process.env.APPDATA || '', 'ai.opencode.desktop'),
      backupRoot: path.join(process.env.APPDATA || '', 'Open Design', 'oc-repair-backups'),
      exeName: 'OpenCode.exe',
    };
  } else if (platform === 'darwin') {
    return {
      appCandidates: [
        '/Applications/Open Code.app',
        path.join(home, 'Applications', 'Open Code.app'),
      ],
      dataRoot: path.join(home, 'Library', 'Application Support', 'ai.opencode.desktop'),
      backupRoot: path.join(home, 'Library', 'Application Support', 'Open Design', 'oc-repair-backups'),
      exeName: 'Open Code',
      appBundle: true,
    };
  } else {
    return {
      appCandidates: [
        '/opt/Open Code',
        '/usr/lib/open-code',
        path.join(home, '.local', 'share', 'applications', 'Open Code'),
      ],
      dataRoot: path.join(home, '.config', 'ai.opencode.desktop'),
      backupRoot: path.join(home, '.config', 'Open Design', 'oc-repair-backups'),
      exeName: 'open-code',
    };
  }
}

// ------------------------------------------------------------- Discovery
function findAppInstall(paths) {
  for (const dir of paths.appCandidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    let exePath = paths.appBundle
      ? path.join(dir, 'Contents', 'MacOS', paths.exeName)
      : path.join(dir, paths.exeName);
    if (fs.existsSync(exePath)) {
      return { dir, exe: exePath, root: paths.appBundle ? path.join(dir, 'Contents', 'Resources') : dir };
    }
  }
  return null;
}

function getPrimaryDataDir(paths) {
  const dataDir = paths.dataRoot;
  if (!fs.existsSync(dataDir)) throw new Error(`No Open Code data found under "${dataDir}". Has the app been opened at least once?`);
  return dataDir;
}

function getOcProcesses(exePath) {
  if (!exePath) return [];
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${path.basename(exePath)}`, '/FO', 'CSV'], { encoding: 'utf8' });
      return out.stdout.includes(path.basename(exePath)) ? [{}] : [];
    } else {
      const out = spawnSync('pgrep', ['-f', exePath], { encoding: 'utf8' });
      return out.stdout.trim() ? [{}] : [];
    }
  } catch { return []; }
}

function stopOcApp(exePath) {
  if (!exePath) { logWarn('App executable not found; ensure Open Code is closed.'); return; }
  const procs = getOcProcesses(exePath);
  if (procs.length === 0) { logOk('Open Code is not running.'); return; }
  logInfo(`Stopping ${procs.length} process(es)...`);
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/IM', path.basename(exePath)], { stdio: 'ignore' });
    else spawnSync('pkill', ['-f', exePath], { stdio: 'ignore' });
  } catch {}
  for (let i = 0; i < 10; i++) { if (getOcProcesses(exePath).length === 0) break; sleep(500); }
  if (getOcProcesses(exePath).length > 0) logWarn('Some processes did not exit. Close manually, then re-run.');
  else logOk('Open Code stopped.');
}

function startOcApp(install) {
  if (!install) { logWarn('App not found; cannot relaunch.'); return; }
  logInfo('Starting Open Code...');
  try {
    if (process.platform === 'win32') spawnSync(install.exe, [], { detached: true, stdio: 'ignore' });
    else if (install.root?.includes('.app')) spawnSync('open', ['-a', install.dir], { stdio: 'ignore' });
    else spawnSync(install.exe, [], { detached: true, stdio: 'ignore' });
    logOk('Launched.');
  } catch { logWarn('Could not start app.'); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ------------------------------------------------------------- Backup
function getBackupRoot(backupRoot) {
  const root = path.join(backupRoot, 'opencode');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function newBackup(dataDir, backupRoot, label = 'manual') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(getBackupRoot(backupRoot), `${stamp}-${label}`);
  logStep(`Backup -> ${dest}`);
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(dataDir)) fs.cpSync(dataDir, path.join(dest, 'data'), { recursive: true });
  const size = getDirSize(path.join(dest, 'data'));
  logOk(`Backup written (${formatBytes(size)}).`);
  return dest;
}

function listBackups(backupRoot) {
  const dir = getBackupRoot(backupRoot);
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => b.name.localeCompare(a.name)) : [];
}

function restoreBackup(dataDir, backupRoot, source) {
  const backups = listBackups(backupRoot);
  const target = source ? backups.find(b => b.path === source || b.name === source) : backups[0];
  if (!target) throw new Error('Backup not found.');
  if (!confirm(`Replace current app data with backup '${target.name}'?`)) return;
  newBackup(dataDir, backupRoot, 'pre-restore');
  if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.cpSync(path.join(target.path, 'data'), dataDir, { recursive: true });
  logOk('Restore complete.');
}

// ------------------------------------------------------------- DB helper
function invokeHelper(command, args, dataDir) {
  if (!fs.existsSync(HELPER_PATH)) throw new Error(`Helper missing: ${HELPER_PATH}`);

  const result = spawnSync('node', ['--experimental-sqlite', HELPER_PATH, command, ...args, '--data', dataDir], {
    encoding: 'utf8', timeout: 120000
  });
  const text = result.stdout?.trim() || '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const json = start >= 0 && end > start ? text.slice(start, end + 1) : '';
  if (!json) throw new Error(`Helper failed (exit ${result.status}): ${result.stderr || 'no output'}`);
  return JSON.parse(json);
}

// ------------------------------------------------------------- Actions
async function runDoctor(install, dataDir, paths) {
  logStep('Environment');
  if (install) {
    logInfo(`Tool      : OpenCodeRepair ${TOOL_VERSION}`);
    logInfo(`Install   : ${install.dir}`);
    logInfo(`App exe   : ${install.exe}`);
  } else {
    logWarn('App install: not found (data-only commands still work)');
  }
  logInfo(`Data dir  : ${dataDir}`);

  const running = getOcProcesses(install?.exe);
  logInfo(`Running   : ${running.length ? `${running.length} process(es)` : 'no'}`);

  logStep('Database');
  const report = invokeHelper('doctor', [], dataDir);
  if (!report.ok) throw new Error(`Helper error: ${report.error}`);

  const dbColor = report.database.integrity === 'ok' ? COLORS.green : COLORS.red;
  console.log(`${dbColor}   integrity : ${report.database.integrity}${COLORS.reset}`);
  logInfo(`size      : ${formatBytes(report.database.bytes)} (+ wal ${formatBytes(report.database.walBytes)}, shm ${formatBytes(report.database.shmBytes)})`);
  logInfo(`tables    : ${Object.entries(report.counts).map(([k,v]) => `${k}:${v}`).join(', ')}`);
  logInfo(`sessions  : ${report.sessions.total}`);
  for (const s of report.sessions.list) {
    logInfo(`  ${s.id}  [${s.workspaceId}]  ${s.promptLen} bytes`);
  }
  logInfo(`workspaces: ${report.workspaces.total}`);
  for (const w of report.workspaces.list) {
    logInfo(`  ${w.id}  (${w.sessionCount} session(s))`);
  }

  logStep('Problems');
  let problems = 0;
  if (report.logs.sessions > 20) { problems++; logWarn(`${report.logs.sessions} log session folders accumulated.`); }
  if (report.caches.totalBytes > 100 * 1024 * 1024) { problems++; logWarn(`Renderer caches total ${formatBytes(report.caches.totalBytes)}.`); }
  if (report.localStorage.bytes > 50 * 1024 * 1024) { problems++; logWarn(`Local Storage holds ${formatBytes(report.localStorage.bytes)}.`); }
  if (problems === 0) logOk('No problems detected.');
  else logInfo(`\n${problems} issue group(s). Run 'fix' to repair the safe ones.`);

  logStep('Disk');
  logInfo(`data       : ${formatBytes(getDirSize(dataDir))}`);
  logInfo(`caches     : ${formatBytes(report.caches.totalBytes)}`);
  logInfo(`logs       : ${formatBytes(report.logs.bytes)}`);
  logInfo(`localStorage: ${formatBytes(report.localStorage.bytes)}`);
  return report;
}

async function runFix(install, dataDir, paths, dryRun) {
  logStep('Repair plan');
  logInfo('1. stop the app');
  logInfo('2. back up data');
  logInfo('3. vacuum database');
  logInfo('4. clear renderer caches');
  if (!dryRun && !confirm('Proceed with the repair?')) return;

  stopOcApp(install?.exe);
  if (!dryRun) newBackup(dataDir, paths.backupRoot, 'pre-fix');

  logStep('Vacuuming database');
  const prune = invokeHelper('prune', dryRun ? ['--dry-run'] : [], dataDir);
  if (!prune.ok) logBad(`prune failed: ${prune.error}`);
  else logOk('Database vacuumed.');

  logStep('Clearing renderer cache and local state');
  clearUiState(dataDir, dryRun);

  logStep('Verification');
  const after = invokeHelper('doctor', [], dataDir);
  logOk(`database integrity: ${after.database.integrity}`);
}

function clearUiState(dataDir, dryRun) {
  const targets = [
    'Cache', 'Code Cache', 'ShaderCache', 'GrShaderCache', 'GPUCache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary',
    'Local Storage', 'Session Storage', 'blob_storage',
  ];
  for (const name of targets) {
    const p = path.join(dataDir, name);
    if (!fs.existsSync(p)) continue;
    if (dryRun) { logInfo(`would remove ${name}`); continue; }
    try { fs.rmSync(p, { recursive: true, force: true }); logOk(`cleared ${name}`); }
    catch (e) { logBad(`could not clear ${name}: ${e.message}`); }
  }
}

async function runDeleteSession(install, dataDir, paths, sessionId, workspaceId, sessionTitle, dryRun) {
  const report = invokeHelper('doctor', [], dataDir);
  if (!report.ok) throw new Error(`Helper error: ${report.error}`);

  let target = null;
  if (sessionId) {
    target = report.sessions.list.find(s => s.id === sessionId);
    if (!target) logWarn(`No session with id '${sessionId}'.`);
  } else if (workspaceId && process.stdin.isTTY) {
    const wsSessions = report.sessions.list.filter(s => s.workspaceId === workspaceId);
    if (wsSessions.length === 0) { logWarn(`No sessions in workspace '${workspaceId}'.`); return; }
    console.log(`Sessions in ${workspaceId}:`);
    wsSessions.forEach((s, i) => console.log(`  ${i + 1}) ${s.id}  (${s.promptLen} bytes)`));
    const sel = await prompt('Select a session number to delete (0 to cancel): ');
    const n = parseInt(sel);
    if (!isNaN(n) && n >= 1 && n <= wsSessions.length) target = wsSessions[n - 1];
  } else if (process.stdin.isTTY) {
    if (report.sessions.list.length === 0) { logWarn('No sessions found.'); return; }
    console.log('Sessions:');
    report.sessions.list.forEach((s, i) => console.log(`  ${i + 1}) ${s.id}  [${s.workspaceId}]  (${s.promptLen} bytes)`));
    const sel = await prompt('Select a session number to delete (0 to cancel): ');
    const n = parseInt(sel);
    if (!isNaN(n) && n >= 1 && n <= report.sessions.list.length) target = report.sessions.list[n - 1];
  }

  if (!target) {
    logWarn('No matching session.');
    report.sessions.list.forEach(s => logInfo(`  ${s.id}  [${s.workspaceId}]`));
    return;
  }

  logStep(`Delete session: ${target.id}`);
  logInfo(`workspace : ${target.workspaceId}`);
  logInfo('Note: unlike the app UI, this does NOT auto-create a replacement session.');
  if (!dryRun && !confirm('Permanently delete this session?')) return;

  stopOcApp(install?.exe);
  if (!dryRun) newBackup(dataDir, paths.backupRoot, 'pre-delete-session');

  const result = invokeHelper('delete-session', ['--id', target.id, ...(dryRun ? ['--dry-run'] : [])], dataDir);
  if (!result.ok) { logBad(`delete failed: ${result.error}`); return; }
  if (!result.found) { logWarn('Session no longer exists in the database.'); return; }

  logOk('Session deleted.');
  logOk(`state rows removed: ${result.removedStateRows}`);
  logOk(`document rows removed: ${result.removedDocumentRows}`);
}

async function runDeleteWorkspace(install, dataDir, paths, workspaceId, workspacePath, dryRun) {
  const report = invokeHelper('doctor', [], dataDir);
  if (!report.ok) throw new Error(`Helper error: ${report.error}`);

  let target = null;
  if (workspaceId) target = report.workspaces.list.find(w => w.id === workspaceId);
  else if (workspacePath) target = report.workspaces.list.find(w => w.id.includes(workspacePath));
  else if (process.stdin.isTTY) {
    if (report.workspaces.list.length === 0) { logWarn('No workspaces found.'); return; }
    console.log('Workspaces:');
    report.workspaces.list.forEach((w, i) => console.log(`  ${i + 1}) ${w.id}  (${w.sessionCount} session(s))`));
    const sel = await prompt('Select a workspace number to delete (0 to cancel): ');
    const n = parseInt(sel);
    if (!isNaN(n) && n >= 1 && n <= report.workspaces.list.length) target = report.workspaces.list[n - 1];
  }

  if (!target) { logWarn('No matching workspace.'); report.workspaces.list.forEach(w => logInfo(`  ${w.id}  (${w.sessionCount})`)); return; }

  logStep(`Delete workspace: ${target.id}`);
  logInfo(`sessions  : ${target.sessionCount}`);
  logInfo('This permanently removes the workspace and all its sessions.');
  if (!dryRun && !confirm('Permanently delete this workspace and all its sessions?')) return;

  stopOcApp(install?.exe);
  if (!dryRun) newBackup(dataDir, paths.backupRoot, 'pre-delete-workspace');

  const result = invokeHelper('delete-workspace', ['--id', target.id, ...(dryRun ? ['--dry-run'] : [])], dataDir);
  if (!result.ok) { logBad(`delete failed: ${result.error}`); return; }
  if (!result.found) { logWarn('Workspace no longer exists in the database.'); return; }

  logOk('Workspace deleted.');
  logOk(`sessions removed: ${result.sessionCount}`);
  logOk(`state rows removed: ${result.removedStateRows}`);
}

async function runFactoryReset(install, dataDir, paths, dryRun) {
  logStep('Factory reset');
  logInfo('This deletes all Open Code app data:');
  logInfo(`  ${dataDir}`);
  logInfo('The app itself stays installed. Next launch starts as first run.');
  if (!dryRun && !confirm('Wipe ALL Open Code app data on this device? Type RESET to confirm:', 'RESET')) return;

  stopOcApp(install?.exe);
  if (!dryRun) newBackup(dataDir, paths.backupRoot, 'pre-reset');

  if (!fs.existsSync(dataDir)) logWarn('Data dir already missing.');
  else {
    if (dryRun) logInfo(`would remove ${dataDir}`);
    else { try { fs.rmSync(dataDir, { recursive: true, force: true }); logOk(`removed ${dataDir}`); } catch (e) { logBad(`could not remove: ${e.message}`); } }
  }

  logStep('Done');
  if (!dryRun) logInfo(`Backups: ${getBackupRoot(paths.backupRoot)}`);
}

function confirm(question, typedWord) {
  if (process.argv.includes('--yes')) return true;
  if (process.argv.includes('--dry-run')) return true;
  if (typedWord) {
    const readline = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(r => readline.question(`${question}\nType '${typedWord}' to continue: `, ans => { readline.close(); r(ans === typedWord); }));
  }
  const readline = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => readline.question(`${question} [y/N] `, ans => { readline.close(); r(/^y(es)?$/i.test(ans)); }));
}

function prompt(question) {
  const readline = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => readline.question(question, ans => { readline.close(); r(ans); }));
}

function showVersion(install, dataDir, paths) {
  logStep('OpenCodeRepair');
  logInfo(`Tool version : ${TOOL_VERSION}`);
  if (install) { logInfo(`App install  : ${install.dir}`); } else { logWarn('App install  : not found'); }
  logInfo(`Data dir     : ${dataDir}`);
  const backups = listBackups(paths.backupRoot);
  logInfo(`Backups      : ${backups.length} available`);
}

function showMenu(install) {
  console.log(`\n Open Code Repair v${TOOL_VERSION}`);
  console.log(' ------------------');
  if (install) console.log(` App: ${install.dir}`);
  else console.log(' App: not detected (data-only commands still available)');
  console.log(' 1  Doctor (diagnose problems)');
  console.log(' 2  Fix (safe repair + clear caches)');
  console.log(' 3  Clear UI cache only');
  console.log(' 4  Delete a session');
  console.log(' 5  Delete a workspace');
  console.log(' 6  Backup now');
  console.log(' 7  Restore a backup');
  console.log(' 8  Factory reset (wipe all app data)');
  console.log(' 9  Version / locations');
  console.log(' 0  Exit\n');
}

async function main() {
  const paths = getPlatformPaths();
  const install = findAppInstall(paths);
  let dataDir;
  try { dataDir = getPrimaryDataDir(paths); } catch { dataDir = null; }

  const args = process.argv.slice(2);
  const command = args[0];
  const dryRun = args.includes('--dry-run');

  if (!command || !['doctor', 'fix', 'clear-ui-state', 'delete-session', 'delete-workspace', 'backup', 'restore', 'list-backups', 'factory-reset', 'version'].includes(command)) {
    if (!process.stdin.isTTY) { if (dataDir) await runDoctor(install, dataDir, paths); return; }
    while (true) {
      showMenu(install);
      const choice = await prompt('Select: ');
      switch (choice) {
        case '1': if (dataDir) await runDoctor(install, dataDir, paths); break;
        case '2': if (dataDir) await runFix(install, dataDir, paths, false); break;
        case '3': if (dataDir) clearUiState(dataDir, false); break;
        case '4': if (dataDir) await runDeleteSession(install, dataDir, paths, null, null, null, false); break;
        case '5': if (dataDir) await runDeleteWorkspace(install, dataDir, paths, null, null, false); break;
        case '6': if (dataDir) newBackup(dataDir, paths.backupRoot, 'manual'); break;
        case '7': if (dataDir) restoreBackup(dataDir, paths.backupRoot, null); break;
        case '8': if (dataDir) await runFactoryReset(install, dataDir, paths, false); break;
        case '9': showVersion(install, dataDir, paths); break;
        case '0': return;
        default: logWarn('Unknown choice.');
      }
      await prompt('\nPress Enter to continue...');
    }
    return;
  }

  const sessionId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
  const workspaceId = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;
  const workspacePath = args.includes('--path') ? args[args.indexOf('--path') + 1] : null;
  const backupPath = args.includes('--backup-path') ? args[args.indexOf('--backup-path') + 1] : null;

  if (!dataDir && !['version'].includes(command)) {
    logBad('No Open Code data directory found.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'doctor': await runDoctor(install, dataDir, paths); break;
      case 'fix': await runFix(install, dataDir, paths, dryRun); break;
      case 'clear-ui-state': clearUiState(dataDir, dryRun); break;
      case 'delete-session': await runDeleteSession(install, dataDir, paths, sessionId, workspaceId, null, dryRun); break;
      case 'delete-workspace': await runDeleteWorkspace(install, dataDir, paths, workspaceId, workspacePath, dryRun); break;
      case 'backup': newBackup(dataDir, paths.backupRoot, 'manual'); break;
      case 'restore': restoreBackup(dataDir, paths.backupRoot, backupPath); break;
      case 'list-backups': listBackups(paths.backupRoot).forEach(b => logInfo(`${b.name}  ${formatBytes(getDirSize(b.path))}`)); break;
      case 'factory-reset': await runFactoryReset(install, dataDir, paths, dryRun); break;
      case 'version': showVersion(install, dataDir, paths); break;
    }
  } catch (e) {
    logBad(e.message);
    process.exit(1);
  }
}

main();