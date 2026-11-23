# Open Code Repair

[![npm version](https://img.shields.io/npm/v/open-code-repair?color=blue&label=npm)](https://www.npmjs.com/package/open-code-repair)
[![npm downloads](https://img.shields.io/npm/dm/open-code-repair?label=downloads)](https://www.npmjs.com/package/open-code-repair)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/dkhproject/open-code-repair/workflows/CI/badge.svg)](https://github.com/dkhproject/open-code-repair/actions)

> **Cross-platform maintenance & repair tool for the [Open Code](https://github.com/opencode-io/opencode) desktop app.**
> Fixes stuck sessions, workspace issues, cache bloat, log accumulation, orphaned data — and resets to factory-fresh state.

**Unofficial community tool.** Not affiliated with or endorsed by the Open Code authors. It only touches app *data* (database, caches, local state), never the app binaries. Use at your own risk; automatic backups are taken before any destructive action.

---

## Why you might need this

- **"Delete does nothing" / deleted sessions keep coming back.** The app's renderer keeps stale copies in its HTTP cache and Local Storage and restores them as ghosts. `fix` / `clear-ui-state` clears it.
- **A workspace is stuck or half-deleted.** If data was removed outside the app, database rows become orphans. `doctor` flags them; `fix` prunes them.
- **You want a clean slate.** `factory-reset` wipes all app data so the next launch behaves like a first run.
- **Leftover data after uninstall.** `backup`, `restore`, `list-backups` and `factory-reset` work even when the app itself is no longer installed.

---

## Requirements

| Platform | Requirement |
|----------|-------------|
| **Windows** | PowerShell 5.1+ **or** Node.js 22+ |
| **macOS** | Node.js 22+ |
| **Linux** | Node.js 22+ |

**No Python or other runtime needed.** The database helper uses Node's built-in `node:sqlite` module (Node 22+).

---

## Install

### Option 1: npm (recommended)
```bash
npm install -g open-code-repair
# or from source:
npm install -g .
```

### Option 2: Direct download
Download the repo as ZIP and extract, or:
```bash
git clone https://github.com/dkhproject/open-code-repair.git
cd open-code-repair
```

### Option 3: Windows PowerShell (original)
Use `OpenCodeRepair.ps1` directly on Windows:
```powershell
.\OpenCodeRepair.ps1 doctor
```
If scripts are blocked, use the `.cmd` launcher or:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\OpenCodeRepair.ps1 doctor
```

---

## Quick start

### Cross-platform (Node.js)
```bash
oc-repair doctor          # diagnose (read-only, safe)
oc-repair fix             # repair detected problems
oc-repair factory-reset   # wipe all app data, start fresh
```

### Windows PowerShell
```powershell
# Double-click OpenCodeRepair.cmd for menu
.\OpenCodeRepair.ps1 doctor
.\OpenCodeRepair.ps1 fix
```

---

## Commands

| Command | What it does |
|---|---|
| `doctor` | Read-only diagnosis: DB integrity, sessions (with prompt sizes), workspaces, log accumulation, cache sizes. |
| `fix` | Stops the app → backs up → vacuums database → clears renderer caches → verifies. |
| `clear-ui-state` | Clears only the renderer cache + Local/Session Storage. The targeted fix for *"Delete does nothing"*. |
| `delete-session` | Deletes one conversation/session (state + document rows cascade, plus its runs and task inputs). **Does not** auto-create a replacement (the app UI does that). |
| `delete-workspace` | Deletes one workspace and all its sessions by `--workspace <id>` or `--path <substring>`. |
| `backup` | Snapshot data directory into the backup folder. |
| `restore` | Restore the newest backup, or a specific one via `--backup-path`. Takes a safety backup first. |
| `list-backups` | List available backups and sizes. |
| `factory-reset` | Deletes **all** app data → app starts as first run. Requires typing `RESET`. |
| `uninstall` | Runs the app's official uninstaller; optionally wipes data too. |
| `version` | Print tool version and detected app/data locations. |

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Show what would happen; change nothing. |
| `--yes` | Skip confirmation prompts (for scripting). |
| `--no-backup` | Skip the automatic backup (not recommended). |
| `--app-path <dir>` | Override the install location if auto-detection fails. |
| `--start-after` | Relaunch the app when the command finishes. |

### Examples

```bash
oc-repair doctor
oc-repair fix
oc-repair delete-session --id ses_df6a5782effeS7iXoFgygK51xY
oc-repair delete-workspace --workspace QzpcVXNlcnNc.1wf4p7a
oc-repair factory-reset
oc-repair restore --backup-path "C:\Users\me\AppData\Roaming\Open Code\oc-repair-backups\opencode\20261123-185526-manual"
```

---

## Common Issues This Tool Fixes

These are the most frequently reported problems in the Open Code community:

| Issue | Symptoms | Root Cause |
|-------|----------|------------|
| **"Delete does nothing" / deleted sessions reappear** | Session/workspace seems to stay after clicking Delete | Renderer cache (HTTP cache, LocalStorage, IndexedDB) holds stale "ghost" references. Database delete succeeds, but UI restores from cache. |
| **Orphan workspaces/sessions** | Workspace/session appears in UI but data missing on disk | External tool or crash removed data on disk, but database rows remain. |
| **Stuck runs** | Run shows "running" status indefinitely | Process crashed mid-run; status never updated to failed/completed. |
| **Log accumulation** | Hundreds of log folders consuming disk space | Each session creates a log folder; old ones never cleaned up. |
| **Cache corruption after update/crash** | UI shows stale data, missing workspaces, or glitches | Renderer caches (Cache, GPUCache, LocalStorage, etc.) become inconsistent after app update or crash. |

This tool addresses all of the above:

- `doctor` → Diagnoses all issues above (read-only, safe)
- `fix` → Clears renderer caches, vacuums database, removes stale logs
- `clear-ui-state` → Targeted cache/LocalStorage clearing for "delete does nothing"
- `delete-session` → Permanently removes a session
- `delete-workspace` → Removes workspace and all its sessions
- `factory-reset` → Complete wipe for clean slate

---

## Safety model

- Every destructive command **stops the app first**, then **backs up** data before changing anything (unless `--no-backup`).
- Destructive commands ask for confirmation; `factory-reset` requires typing `RESET`.
- `doctor`, `version`, and anything with `--dry-run` never modify data.
- Backups live in:
  - Windows: `%APPDATA%\Open Code\oc-repair-backups\opencode\`
  - macOS: `~/Library/Application Support/Open Code\oc-repair-backups\opencode\`
  - Linux: `~/.config\Open Code\oc-repair-backups\opencode\`
- Backups are **never** touched by `factory-reset`, so you can always restore.

---

## How it works

- **Discovery:** Auto-detects the install (`%LOCALAPPDATA%\Programs\ai.opencode.desktop` on Windows; `/Applications/Open Code.app` on macOS; `/opt/Open Code` on Linux) and the data root (`%APPDATA%\ai.opencode.desktop` on Windows; `~/Library/Application Support/ai.opencode.desktop` on macOS; `~/.config/ai.opencode.desktop` on Linux). Override with `--app-path`.
- **Database access:** `lib/oc-data.mjs` uses Node's built-in `node:sqlite` module (Node 22+). No native modules needed.
- **Ghost detection:** Scans renderer state directories for session/workspace UUIDs that no longer exist in the database.
- **Repair:** Vacuums database, clears stale renderer state.

---

## Compatibility

Tested against Open Code **2.4.0** on Windows 11. The helper is defensive about schema differences.

---

## Troubleshooting

- **"Open Code installation not found"** — pass `--app-path "/path/to/Open Code"`.
- **"No Open Code data found"** — the app has never been opened.
- **Helper errors / no output** — ensure the app is fully closed; re-run. Include the `doctor` output when reporting issues.
- **Node 22 required** — `node:sqlite` is experimental in Node 22+. Use `nvm` or similar to upgrade.

---

## Contributing

Issues and PRs welcome. Please include your Open Code version, OS, and the `doctor` output.

---

## License

[MIT](LICENSE)