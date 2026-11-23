# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-24

### Added
- **OpenCodeRepair** — maintenance tool for Open Code desktop app
  - `doctor`: DB integrity, sessions (with prompt sizes), workspaces, log accumulation, cache sizes
  - `fix`: safe repair — stop app, back up, vacuum database, clear renderer caches, verify
  - `clear-ui-state`: targeted fix for "Delete does nothing" / deleted items reappearing
  - `delete-session`: delete a conversation/session (state + document rows cascade, plus runs and task inputs) — **does not auto-create a replacement**
  - `delete-workspace`: delete a workspace and all its sessions by ID or path substring
  - `backup` / `restore` / `list-backups`: safety net stored under platform-appropriate config directory
  - `factory-reset`: wipe all app data for a first-run state (requires typing `RESET`)
  - `uninstall`: launch the official uninstaller, optionally wiping data
  - `version`: print tool version and detected app/data locations
  - Interactive menu with numbered pickers (no UUID typing needed)

- **Cross-platform support** — runs on Windows, macOS, and Linux
  - `oc-repair.mjs` — cross-platform CLI (uses Node's built-in `node:sqlite`, Node 22+)
  - Auto-detection of install/data paths per platform
  - npm package with `bin` entry: `npm install -g .` → `oc-repair`

- **Windows PowerShell version** — original `.ps1` script with `.cmd` launcher

### Notes
- Database helper uses Node's built-in `node:sqlite` (Node 22+), no native modules.
- Data-only commands (`backup`/`restore`/`list-backups`/`factory-reset`) work even after the app is uninstalled.
- Tested against Open Code 2.4.0 on Windows 11.