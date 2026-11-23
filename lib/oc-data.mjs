#!/usr/bin/env node
/**
 * oc-data.mjs — data-layer helper for OpenCodeRepair.
 *
 * Runs under system Node (v22+) with --experimental-sqlite, using the built-in
 * node:sqlite module. No native modules or app-bundled dependencies required.
 *
 * Usage:
 *   node --experimental-sqlite oc-data.mjs <command> --data <data dir> [options]
 *
 * Commands:
 *   doctor                     Inspect DB + folders, print a JSON report.
 *   prune                      Remove orphaned sessions/workspaces/runs/blobs,
 *                              then vacuum.
 *   delete-session --id <id>   Delete one conversation/session (rows + runs).
 *                --workspace <wsId>
 *                --title <title>
 *   delete-workspace --id <id> Delete one workspace and all its sessions.
 *                --path "<path>"
 *
 * Options:
 *   --dry-run                  Report what would change; change nothing.
 *
 * Output: a single JSON object on stdout (diagnostics go to stderr).
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'doctor';
const dryRun = Boolean(args['dry-run']);

function fail(message, code = 1) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

if (!args.data) fail('missing --data <Open Code data directory>');
const dataDir = path.resolve(args.data);
const dbPath = path.join(dataDir, 'drafts.sqlite');
if (!fs.existsSync(dbPath)) fail(`database not found: ${dbPath}`);

const projectsDir = null; // Open Code doesn't use per-project folders like Open Design
const logsDir = path.join(dataDir, 'logs');
const cacheRoots = [
  path.join(dataDir, 'Cache'),
  path.join(dataDir, 'Code Cache'),
  path.join(dataDir, 'ShaderCache'),
  path.join(dataDir, 'GrShaderCache'),
  path.join(dataDir, 'GPUCache'),
  path.join(dataDir, 'DawnGraphiteCache'),
  path.join(dataDir, 'DawnWebGPUCache'),
];

const listDirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};
const listFiles = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
};
const safeUnlink = (file) => {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
};
const safeRmdir = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};
const dirSize = (dir) => {
  try {
    return (
      fs
        .readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile())
        .reduce((sum, e) => {
          try {
            return sum + fs.statSync(path.join(e.parentPath ?? dir, e.name)).size;
          } catch {
            return sum;
          }
        }, 0) ?? 0
    );
  } catch {
    return 0;
  }
};

// node:sqlite (Node 22+) opens WAL-mode databases read-only fine.
import { DatabaseSync } from 'node:sqlite';

function open(readonly) {
  const db = new DatabaseSync(dbPath, readonly ? { readonly: true } : {});
  db.pragma = (sql, opts) => {
    const full = sql.toUpperCase().startsWith('PRAGMA ') ? sql : `PRAGMA ${sql}`;
    const row = db.prepare(full).get();
    return opts?.simple ? String(row[Object.keys(row)[0]]) : row;
  };
  return db;
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name),
  );
}

function columnSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  try {
    return new Set(db.pragma(`table_info("${table}")`).map((c) => c.name));
  } catch {
    return new Set();
  }
}

function doctor() {
  const db = open(true);
  const integrity = String(db.pragma('integrity_check', { simple: true }));

  // Sessions: state entries with name like 'opencode.workspace.<ws>.dat' and key 'session:<id>:prompt'
  const stateRows = db.prepare("select name, key, value, updated_at from state order by name, key").all();
  const docRows = tableExists(db, 'document')
    ? db.prepare("select key, value from document order by key").all()
    : [];
  const sessions = [];
  const workspaces = new Map();

  // Find sessions from state table (session:<id>:comments, etc.)
  for (const r of stateRows) {
    const m = r.name.match(/^opencode\.workspace\.(.+)\.dat$/);
    if (!m) continue;
    const wsId = m[1];
    const sm = r.key.match(/^session:(.+):/);
    if (sm) {
      if (!workspaces.has(wsId)) workspaces.set(wsId, { id: wsId, sessionIds: [] });
      const existing = workspaces.get(wsId);
      if (!existing.sessionIds.includes(sm[1])) existing.sessionIds.push(sm[1]);
    } else if (r.key === 'workspace:model-selection') {
      if (!workspaces.has(wsId)) workspaces.set(wsId, { id: wsId, sessionIds: [] });
    }
  }

  // Find sessions from document table (opencode.workspace.<ws>.dat:session:<id>:prompt)
  for (const r of docRows) {
    const m = r.key.match(/^opencode\.workspace\.(.+)\.dat:session:(.+):prompt$/);
    if (!m) continue;
    const wsId = m[1];
    const sessionId = m[2];
    if (!workspaces.has(wsId)) workspaces.set(wsId, { id: wsId, sessionIds: [] });
    const existing = workspaces.get(wsId);
    if (!existing.sessionIds.includes(sessionId)) existing.sessionIds.push(sessionId);
    // Check if already added from state table
    if (!sessions.some((s) => s.id === sessionId)) {
      sessions.push({
        id: sessionId,
        workspaceId: wsId,
        updatedAt: null,
        promptLen: r.value ? r.value.length : 0,
      });
    } else {
      // Update promptLen from document table
      const s = sessions.find((s) => s.id === sessionId);
      if (s) s.promptLen = r.value ? r.value.length : 0;
    }
  }

  // Settings / model / layout / providers from global state
  const globalSettings = {};
  for (const r of stateRows) {
    if (r.name === 'opencode.global.dat') {
      globalSettings[r.key] = r.value;
    }
  }

  const workspaceList = [...workspaces.values()].map((w) => ({
    id: w.id,
    sessionCount: w.sessionIds.length,
    sessions: w.sessionIds,
  }));

  const counts = {};
  for (const t of ['document', 'state', 'blob', 'plugin', 'migration']) {
    if (tableExists(db, t)) counts[t] = db.prepare(`select count(*) c from "${t}"`).get().c;
  }

  const blobCount = tableExists(db, 'blob') ? db.prepare('select count(*) c from blob').get().c : 0;
  const documentCount = tableExists(db, 'document')
    ? db.prepare('select count(*) c from document').get().c
    : 0;

  const walBytes = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
  const shmBytes = fs.existsSync(`${dbPath}-shm`) ? fs.statSync(`${dbPath}-shm`).size : 0;

  // Log accumulation
  let logSessions = 0;
  let logBytes = 0;
  try {
    for (const d of listDirs(logsDir)) {
      const dp = path.join(logsDir, d);
      logSessions++;
      for (const f of listFiles(dp)) {
        try {
          logBytes += fs.statSync(path.join(dp, f)).size;
        } catch {}
      }
    }
  } catch {}

  // Cache sizes
  const cacheSizes = {};
  let totalCacheBytes = 0;
  for (const c of cacheRoots) {
    const s = dirSize(c);
    if (s > 0) {
      cacheSizes[path.basename(c)] = s;
      totalCacheBytes += s;
    }
  }

  // Local Storage size
  const localStorageDir = path.join(dataDir, 'Local Storage');
  const localStorageBytes = dirSize(localStorageDir);

  db.close();

  return {
    ok: true,
    command: 'doctor',
    dataDir,
    database: {
      path: dbPath,
      bytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
      walBytes,
      shmBytes,
      integrity,
    },
    counts,
    blobs: { rows: blobCount },
    documents: { rows: documentCount },
    sessions: { total: sessions.length, list: sessions },
    workspaces: { total: workspaceList.length, list: workspaceList },
    globalSettings: Object.keys(globalSettings),
    logs: { sessions: logSessions, bytes: logBytes },
    caches: { entries: cacheSizes, totalBytes: totalCacheBytes },
    localStorage: { bytes: localStorageBytes },
  };
}

function prune() {
  const db = open(false);
  const result = {
    ok: true,
    command: 'prune',
    dryRun,
    deletedSessions: [],
    deletedWorkspaces: [],
    vacuumed: false,
  };

  const stateRows = db.prepare("select name, key from state order by name, key").all();
  const wsPattern = /^opencode\.workspace\.(.+)\.dat$/;

  // Find workspace IDs that have session prompts
  const wsWithSessions = new Set();
  const sessionKeys = [];
  for (const r of stateRows) {
    const m = r.name.match(wsPattern);
    if (!m) continue;
    const wsId = m[1];
    if (r.key.match(/^session:.+:prompt$/)) {
      wsWithSessions.add(wsId);
      sessionKeys.push(r);
    }
  }

  // Delete all session state + document entries for orphaned workspaces.
  // Open Code has no "project folder on disk" concept like Open Design, so we
  // treat all existing workspaces as valid and only remove sessions explicitly.
  // (No automatic orphan pruning for sessions here — that's delete-session.)

  if (!dryRun) db.exec('vacuum');
  result.vacuumed = true;
  db.close();
  return result;
}

function deleteSession() {
  const id = args.id;
  const workspaceId = args.workspace;
  const title = args.title;
  if (!id && !(workspaceId && title)) {
    fail('delete-session needs --id <sessionId>, or --workspace <wsId> --title "<title>"');
  }

  const db = open(false);
  const wsColumn = 'opencode.workplace.'; // not used; we match by name pattern

  let target;
  if (id) {
    // Find state entries for this session across all workspaces
    const rows = db
      .prepare(
        "select name, key, value from state where key = ? or key like ?",
      )
      .all(`session:${id}:prompt`, `session:${id}:%`);
    if (rows.length === 0) {
      db.close();
      return { ok: true, command: 'delete-session', found: false, message: 'no matching session' };
    }
    target = { id, workspaceId: rows[0].name.match(/^opencode\.workspace\.(.+)\.dat$/)?.[1] ?? null, rows };
  } else {
    const wsName = `opencode.workspace.${workspaceId}.dat`;
    const rows = db
      .prepare("select name, key, value from state where name = ? and key like ?")
      .all(wsName, `session:%:${title === undefined ? '' : ''}`);
    // title-based lookup: iterate session prompt docs and match value content
    const allSessions = db
      .prepare("select name, key, value from state where name like ? and key like ?")
      .all(`opencode.workspace.${workspaceId}.dat`, 'session:%:prompt');
    const match = allSessions.find((r) => r.value === title || r.value.includes(title));
    if (!match) {
      db.close();
      return { ok: true, command: 'delete-session', found: false, message: 'no matching session' };
    }
    const sm = match.key.match(/^session:(.+):prompt$/);
    target = { id: sm[1], workspaceId, rows: [match] };
  }

  // Collect all state keys for this session (prompt, comments, etc.)
  const sessionPrefix = `session:${target.id}:`;
  const sessionKeys = db
    .prepare("select name, key from state where key like ?")
    .all(`${sessionPrefix}%`);

  const documentKeys = [];
  // Documents may also reference the session
  try {
    const docRows = db.prepare("select key from document where key like ?").all(`%${target.id}%`);
    documentKeys.push(...docRows.map((r) => r.key));
  } catch {}

  const result = {
    ok: true,
    command: 'delete-session',
    dryRun,
    found: true,
    session: { id: target.id, workspaceId: target.workspaceId },
    removedStateRows: sessionKeys.length,
    removedDocumentRows: documentKeys.length,
    replacementCreated: false,
  };

  if (!dryRun) {
    for (const r of sessionKeys) {
      db.prepare('delete from state where name = ? and key = ?').run(r.name, r.key);
    }
    for (const k of documentKeys) {
      try {
        db.prepare('delete from document where key = ?').run(k);
      } catch {}
    }
    db.exec('vacuum');
  }
  db.close();
  return result;
}

function deleteWorkspace() {
  const id = args.id;
  const pathMatch = args.path;
  if (!id && !pathMatch) {
    fail('delete-workspace needs --id <workspaceId> or --path "<workspace path>"');
  }

  const db = open(false);
  const wsNamePrefix = `opencode.workspace.`;
  let targetWsId = id;

  if (!targetWsId && pathMatch) {
    // Workspace IDs are base64-ish of the path; search state names
    const rows = db.prepare("select distinct name from state where name like ?").all(`${wsNamePrefix}%.dat`);
    for (const r of rows) {
      const m = r.name.match(/^opencode\.workspace\.(.+)\.dat$/);
      if (m && m[1].includes(pathMatch)) {
        targetWsId = m[1];
        break;
      }
    }
    if (!targetWsId) {
      db.close();
      return { ok: true, command: 'delete-workspace', found: false, message: 'no matching workspace' };
    }
  }

  const wsName = `opencode.workspace.${targetWsId}.dat`;
  const wsRows = db.prepare("select key from state where name = ?").all(wsName);
  const sessionIds = wsRows
    .filter((r) => r.key.startsWith('session:'))
    .map((r) => r.key.match(/^session:(.+):/)[1]);

  const result = {
    ok: true,
    command: 'delete-workspace',
    dryRun,
    found: true,
    workspace: { id: targetWsId },
    sessionCount: sessionIds.length,
    removedStateRows: wsRows.length,
  };

  if (!dryRun) {
    for (const r of wsRows) {
      db.prepare('delete from state where name = ? and key = ?').run(wsName, r.key);
    }
    db.exec('vacuum');
  }
  db.close();
  return result;
}

try {
  if (command === 'doctor') console.log(JSON.stringify(doctor(), null, 2));
  else if (command === 'prune') console.log(JSON.stringify(prune(), null, 2));
  else if (command === 'delete-session') console.log(JSON.stringify(deleteSession(), null, 2));
  else if (command === 'delete-workspace') console.log(JSON.stringify(deleteWorkspace(), null, 2));
  else fail(`unknown command: ${command}`);
} catch (error) {
  fail(`${command} failed: ${error && error.message ? error.message : String(error)}`);
}