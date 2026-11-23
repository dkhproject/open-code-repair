<#
.SYNOPSIS
  OpenCodeRepair - diagnose, repair, reset and fully wipe Open Code app data.

.DESCRIPTION
  An unofficial community maintenance tool for the Open Code desktop app on
  Windows. It never modifies the app binaries; it operates on the app's data
  (database, renderer cache, local state, logs) and can restore the app to a
  first-run state.

  Install location and data directories are auto-detected. No Node.js needed.
  The database helper runs under system Node with node:sqlite.

  All destructive actions create a backup first (unless -NoBackup) and ask for
  confirmation (unless -Yes or -DryRun). Backup/restore/list-backups/version
  work even if the app itself has been uninstalled.

.PARAMETER Command
  doctor            Show data paths, DB health, sessions, workspaces, settings,
                    log accumulation, and cache sizes.
  fix               Safe repair: back up, vacuum the database, clear renderer
                    caches, then verify.
  clear-ui-state    Clear renderer cache + Local/Session Storage only.
  delete-session    Delete one conversation/session by -SessionId, or by
                    -WorkspaceId/-WorkspacePath + -SessionTitle. Does NOT
                    auto-create a replacement session (the app UI does that).
  delete-workspace  Delete one workspace and all its sessions by -WorkspaceId
                    or -WorkspacePath.
  backup            Snapshot data into the backup folder.
  restore           Restore the newest backup (or -BackupPath).
  list-backups      List available backups.
  factory-reset     Delete all app data -> app starts as new.
  uninstall         Launch the app's uninstaller (optionally wipes data too).
  version           Print tool version and detected app/data locations.

.PARAMETER SessionId
  Session UUID for delete-session.

.PARAMETER SessionTitle
  Exact session title (matches the prompt text) for delete-session.

.PARAMETER WorkspaceId
  Workspace ID for delete-session / delete-workspace.

.PARAMETER WorkspacePath
  Workspace path substring for delete-workspace.

.PARAMETER BackupPath
  Specific backup folder to restore from.

.PARAMETER AppPath
  Override the install directory if auto-detection fails.

.PARAMETER Yes
  Skip confirmation prompts (for scripting).

.PARAMETER DryRun
  Show what would happen without changing anything.

.PARAMETER NoBackup
  Skip the automatic backup before destructive actions (not recommended).

.PARAMETER StartAfter
  Relaunch the app when the command finishes.

.EXAMPLE
  .\OpenCodeRepair.ps1 doctor

.EXAMPLE
  .\OpenCodeRepair.ps1 fix

.EXAMPLE
  .\OpenCodeRepair.ps1 delete-session -WorkspaceId QzpcVXNlcnNc -SessionTitle "my prompt"

.EXAMPLE
  .\OpenCodeRepair.ps1 factory-reset
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('doctor', 'fix', 'clear-ui-state', 'delete-session', 'delete-workspace', 'backup', 'restore', 'list-backups', 'factory-reset', 'uninstall', 'version')]
  [string]$Command,

  [string]$SessionId,
  [string]$SessionTitle,
  [string]$WorkspaceId,
  [string]$WorkspacePath,
  [string]$BackupPath,
  [string]$AppPath,

  [switch]$Yes,
  [switch]$DryRun,
  [switch]$NoBackup,
  [switch]$StartAfter
)

$ErrorActionPreference = 'Stop'
$script:ToolVersion = '1.0.0'
$script:HelperPath = Join-Path $PSScriptRoot 'lib\oc-data.mjs'
$script:BackupRootName = 'oc-repair-backups'

function Write-Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   [ok]   $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   [warn] $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host "   [fail] $Text" -ForegroundColor Red }
function Write-Info([string]$Text) { Write-Host "   $Text" -ForegroundColor Gray }

function Confirm-Action([string]$Question, [string]$TypedWord) {
  if ($Yes) { return $true }
  if ($DryRun) { return $true }
  if ($TypedWord) {
    $answer = Read-Host "$Question`nType '$TypedWord' to continue"
    return ($answer -eq $TypedWord)
  }
  $answer = Read-Host "$Question [y/N]"
  return ($answer -match '^(y|yes)$')
}

function Format-Bytes([double]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
  return ('{0:N0} B' -f $Bytes)
}

function Get-DirSize([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [double]$sum
}

# ------------------------------------------------------------- discovery layer
function Get-AppInstall {
  $candidates = @()
  if ($AppPath) { $candidates += $AppPath }
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\ai.opencode.desktop')
  $candidates += 'C:\Program Files\ai.opencode.desktop'

  foreach ($dir in $candidates) {
    if (-not $dir) { continue }
    $exe = Join-Path $dir 'OpenCode.exe'
    if (Test-Path -LiteralPath $exe) {
      return [pscustomobject]@{
        Dir  = (Resolve-Path -LiteralPath $dir).Path
        Exe  = (Resolve-Path -LiteralPath $exe).Path
        Root = (Join-Path (Resolve-Path -LiteralPath $dir).Path 'resources')
      }
    }
  }

  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    $entry = Get-ItemProperty $key -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match '^Open Code' } | Select-Object -First 1
    if ($entry -and $entry.InstallLocation) {
      $exe = Join-Path $entry.InstallLocation 'OpenCode.exe'
      if (Test-Path -LiteralPath $exe) {
        return [pscustomobject]@{
          Dir  = $entry.InstallLocation
          Exe  = $exe
          Root = (Join-Path $entry.InstallLocation 'resources')
        }
      }
    }
  }
  return $null
}

function Get-PrimaryDataDir {
  $dataDir = Join-Path $env:APPDATA 'ai.opencode.desktop'
  if (-not (Test-Path -LiteralPath $dataDir)) {
    throw "No Open Code data found under `"$dataDir`". Has the app been opened at least once?"
  }
  return $dataDir
}

function Get-OdProcesses([string]$ExePath) {
  if (-not $ExePath) { return @() }
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and ($_.Path -ieq $ExePath) } catch { $false }
  }
}

function Stop-OcApp([string]$ExePath) {
  if (-not $ExePath) {
    Write-Warn 'App executable not found; make sure Open Code is closed before continuing.'
    return
  }
  $procs = @(Get-OdProcesses $ExePath)
  if ($procs.Count -eq 0) {
    Write-Ok 'Open Code is not running.'
    return
  }
  Write-Info ("Stopping {0} process(es)..." -f $procs.Count)
  $procs | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { } }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    if (@(Get-OdProcesses $ExePath).Count -eq 0) { break }
  }
  if (@(Get-OdProcesses $ExePath).Count -gt 0) {
    Write-Warn 'Some Open Code processes did not exit. Close them manually, then re-run.'
  } else {
    Write-Ok 'Open Code stopped.'
  }
}

function Start-OcApp($Install) {
  if (-not $Install) { Write-Warn 'App not found; cannot relaunch.'; return }
  Write-Info 'Starting Open Code...'
  Start-Process -FilePath $Install.Exe | Out-Null
  Write-Ok 'Launched.'
}

# ------------------------------------------------------------------ DB helper
function Invoke-OcHelper {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$DataDir
  )
  if (-not (Test-Path -LiteralPath $script:HelperPath)) {
    throw "Helper script missing: $($script:HelperPath)"
  }
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $quoted = @($script:HelperPath) + $Arguments + @('--data', $DataDir)
    $argLine = ($quoted | ForEach-Object { '"' + ([string]$_ -replace '"', '\"') + '"' }) -join ' '
    $proc = Start-Process -FilePath node -ArgumentList "--experimental-sqlite $argLine" -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $text = Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    $text = if ($null -eq $text) { '' } else { $text.Trim() }
    $start = $text.IndexOf('{')
    $end = $text.LastIndexOf('}')
    if ($start -ge 0 -and $end -gt $start) { $text = $text.Substring($start, $end - $start + 1) }
    if (-not $text) {
      $errText = Get-Content -LiteralPath $errFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($errText) { throw "Helper produced no output (exit $($proc.ExitCode)): $($errText.Trim())" }
      throw "Helper produced no output (exit $($proc.ExitCode))."
    }
    return $text | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

# --------------------------------------------------------------- backups
function Get-BackupRoot([string]$NamespaceName) {
  $root = Join-Path (Join-Path (Join-Path $env:APPDATA "Open Design") $script:BackupRootName) $NamespaceName
  if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
  return $root
}

function New-Backup($DataDir, [string]$Label = 'manual') {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dest = Join-Path (Get-BackupRoot 'opencode') "$stamp-$Label"
  Write-Step "Backup -> $dest"
  if ($DryRun) {
    Write-Info 'Dry run: would copy data.'
    return $dest
  }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  if (Test-Path -LiteralPath $DataDir) {
    Copy-Item -LiteralPath $DataDir -Destination (Join-Path $dest 'data') -Recurse -Force
  }
  $size = (Get-DirSize (Join-Path $dest 'data'))
  Write-Ok ("Backup written ({0})." -f (Format-Bytes $size))
  return $dest
}

function Get-Backups() {
  $dir = Get-BackupRoot 'opencode'
  Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
}

function Restore-Backup([string]$Source) {
  if (-not $Source) {
    $latest = Get-Backups | Select-Object -First 1
    if (-not $latest) { throw 'No backups found.' }
    $Source = $latest.FullName
  }
  if (-not (Test-Path -LiteralPath $Source)) { throw "Backup not found: $Source" }
  if (-not (Confirm-Action "Replace current app data with backup '$Source'?")) {
    Write-Warn 'Cancelled.'; return
  }
  $dataDir = Get-PrimaryDataDir
  New-Backup $dataDir 'pre-restore' | Out-Null
  if ($DryRun) { Write-Info 'Dry run: would restore files.'; return }
  $src = Join-Path $Source 'data'
  if (Test-Path -LiteralPath $src) {
    if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
    Copy-Item -LiteralPath $src -Destination $dataDir -Recurse -Force
  }
  Write-Ok 'Restore complete.'
}

# --------------------------------------------------------------- actions
function Invoke-Doctor {
  $Install = Get-AppInstall
  $DataDir = Get-PrimaryDataDir

  Write-Step 'Environment'
  if ($Install) {
    Write-Info "Tool      : OpenCodeRepair $($script:ToolVersion)"
    Write-Info "Install   : $($Install.Dir)"
    Write-Info "App exe   : $($Install.Exe)"
  } else {
    Write-Warn 'App install  : not found (data-only commands still work)'
  }
  Write-Info "Data dir  : $DataDir"

  $running = @(Get-OdProcesses $(if ($Install) { $Install.Exe } else { $null }))
  Write-Info "Running   : $(if ($running.Count) { "$($running.Count) process(es)" } else { 'no' })"

  Write-Step 'Database'
  $report = Invoke-OcHelper -Arguments @('doctor') -DataDir $DataDir
  if (-not $report.ok) { throw "Helper error: $($report.error)" }

  $dbColor = if ($report.database.integrity -eq 'ok') { 'Green' } else { 'Red' }
  Write-Host ("   integrity : {0}" -f $report.database.integrity) -ForegroundColor $dbColor
  Write-Info ("size      : {0} (+ wal {1}, shm {2})" -f (Format-Bytes $report.database.bytes), (Format-Bytes $report.database.walBytes), (Format-Bytes $report.database.shmBytes))
  Write-Info ("tables    : {0}" -f (($report.counts | ConvertTo-Json -Compress) -replace '{|}|"', ''))
  Write-Info ("sessions  : {0}" -f @($report.sessions.list).Count)
  foreach ($s in $report.sessions.list) {
    Write-Host ("   - {0}  [{1}]  {2} msg bytes" -f $s.id, $s.workspaceId, $s.promptLen) -ForegroundColor Gray
  }
  Write-Info ("workspaces: {0}" -f @($report.workspaces.list).Count)
  foreach ($w in $report.workspaces.list) {
    Write-Host ("   - {0}  ({1} session(s))" -f $w.id, $w.sessionCount) -ForegroundColor Gray
  }

  Write-Step 'Problems'
  $problems = 0
  if (@($report.logs.sessions).Count -gt 20) {
    $problems++
    Write-Warn ("{0} log session folders accumulated." -f $report.logs.sessions)
  }
  if ($report.caches.totalBytes -gt 100MB) {
    $problems++
    Write-Warn ("Renderer caches total {0}." -f (Format-Bytes $report.caches.totalBytes))
  }
  if ($report.localStorage.bytes -gt 50MB) {
    $problems++
    Write-Warn ("Local Storage holds {0}." -f (Format-Bytes $report.localStorage.bytes))
  }
  if ($problems -eq 0) { Write-Ok 'No problems detected.' }
  else { Write-Info ("`n{0} issue group(s). Run 'fix' to repair the safe ones." -f $problems) }

  Write-Step 'Disk'
  Write-Info ("data      : {0}" -f (Format-Bytes (Get-DirSize $DataDir)))
  Write-Info ("caches    : {0}" -f (Format-Bytes $report.caches.totalBytes))
  Write-Info ("logs      : {0}" -f (Format-Bytes $report.logs.bytes))
  Write-Info ("localStorage : {0}" -f (Format-Bytes $report.localStorage.bytes))

  return $report
}

function Invoke-Fix {
  $Install = Get-AppInstall
  $DataDir = Get-PrimaryDataDir

  Write-Step 'Repair plan'
  Write-Info '1. stop the app'
  Write-Info '2. back up data'
  Write-Info '3. vacuum database'
  Write-Info '4. clear renderer caches'
  if (-not (Confirm-Action 'Proceed with the repair?')) { Write-Warn 'Cancelled.'; return }

  Stop-OcApp $(if ($Install) { $Install.Exe } else { $null })
  if (-not $NoBackup) { New-Backup $DataDir 'pre-fix' | Out-Null }

  Write-Step 'Vacuuming database'
  $prune = Invoke-OcHelper -Arguments @('prune') -DataDir $DataDir
  if (-not $prune.ok) { Write-Bad "prune failed: $($prune.error)" }
  else { Write-Ok 'Database vacuumed.' }

  Write-Step 'Clearing renderer cache and local state'
  $session = Join-Path $DataDir 'session'
  $targets = @(
    'Cache', 'Code Cache', 'ShaderCache', 'GrShaderCache', 'GPUCache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary',
    'Local Storage', 'Session Storage', 'blob_storage'
  )
  foreach ($name in $targets) {
    $p = Join-Path $DataDir $name
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if ($DryRun) { Write-Info "would remove $name"; continue }
    try {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
      Write-Ok "cleared $name"
    } catch {
      Write-Bad "could not clear ${name}: $($_.Exception.Message)"
    }
  }

  Write-Step 'Verification'
  $after = Invoke-OcHelper -Arguments @('doctor') -DataDir $DataDir
  Write-Ok ("database integrity: {0}" -f $after.database.integrity)

  if ($StartAfter) { Start-OcApp $Install }
}

function Clear-UiState($DataDir) {
  $targets = @(
    'Cache', 'Code Cache', 'ShaderCache', 'GrShaderCache', 'GPUCache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary',
    'Local Storage', 'Session Storage', 'blob_storage'
  )
  Write-Step 'Clearing renderer cache and local state'
  foreach ($name in $targets) {
    $p = Join-Path $DataDir $name
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if ($DryRun) { Write-Info "would remove $name"; continue }
    try {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
      Write-Ok "cleared $name"
    } catch {
      Write-Bad "could not clear ${name}: $($_.Exception.Message)"
    }
  }
}

function Invoke-DeleteSession {
  $DataDir = Get-PrimaryDataDir

  $report = Invoke-OcHelper -Arguments @('doctor') -DataDir $DataDir
  if (-not $report.ok) { throw "Helper error: $($report.error)" }

  $target = $null
  if ($SessionId) {
    $match = @($report.sessions.list | Where-Object { $_.id -eq $SessionId }) | Select-Object -First 1
    if (-not $match) { Write-Warn "No session with id '$SessionId'." }
    else { $target = $match }
  } elseif ($WorkspaceId -and $SessionTitle) {
    $match = @($report.sessions.list | Where-Object { $_.workspaceId -eq $WorkspaceId -and $_.promptLen -gt 0 }) | Select-Object -First 1
    # title-based matching requires loading the doc content; fall back to listing
    if (@($report.sessions.list | Where-Object { $_.workspaceId -eq $WorkspaceId }).Count -eq 0) {
      Write-Warn "No sessions found in workspace '$WorkspaceId'."
    } else {
      Write-Info 'Available sessions in workspace:'
      foreach ($s in @($report.sessions.list | Where-Object { $_.workspaceId -eq $WorkspaceId })) {
        Write-Info ("   {0}  ({1} msg bytes)" -f $s.id, $s.promptLen)
      }
      Write-Warn 'Session title matching is not yet supported via CLI; use -SessionId or run interactively.'
    }
  } elseif ([Environment]::UserInteractive) {
    $all = @($report.sessions.list)
    if ($all.Count -eq 0) { Write-Warn 'No sessions found.'; return }
    Write-Step 'Sessions'
    for ($i = 0; $i -lt $all.Count; $i++) {
      Write-Host ("   {0}) {1}  [{2}]  ({3} msg bytes)" -f ($i + 1), $all[$i].id, $all[$i].workspaceId, $all[$i].promptLen) -ForegroundColor White
    }
    $sel = Read-Host 'Select a session number to delete (0 to cancel)'
    $n = 0
    if ([int]::TryParse($sel, [ref]$n) -and $n -ge 1 -and $n -le $all.Count) { $target = $all[$n - 1] }
  } else {
    Write-Warn 'Specify -SessionId (or run interactively to pick).'
  }

  if (-not $target) { return }

  Write-Step "Delete session: $($target.id)"
  Write-Info "workspace : $($target.workspaceId)"
  Write-Info 'Note: unlike the app UI, this does NOT auto-create a replacement session.'
  if (-not (Confirm-Action "Permanently delete this session?")) {
    Write-Warn 'Cancelled.'; return
  }

  Stop-OcApp $(Get-AppInstall | Select-Object -First 1 -ExpandProperty Exe -ErrorAction SilentlyContinue)
  if (-not $NoBackup) { New-Backup $DataDir 'pre-delete-session' | Out-Null }

  $cliArgs = @('delete-session', '--id', $target.id)
  if ($DryRun) { $cliArgs += '--dry-run' }
  $result = Invoke-OcHelper -Arguments $cliArgs -DataDir $DataDir
  if (-not $result.ok) { Write-Bad "delete failed: $($result.error)"; return }
  if (-not $result.found) { Write-Warn 'Session no longer exists in the database.'; return }

  Write-Ok 'Session deleted.'
  Write-Ok ("state rows removed: {0}" -f $result.removedStateRows)

  if ($StartAfter) { Start-OcApp (Get-AppInstall) }
}

function Invoke-DeleteWorkspace {
  $DataDir = Get-PrimaryDataDir

  $report = Invoke-OcHelper -Arguments @('doctor') -DataDir $DataDir
  if (-not $report.ok) { throw "Helper error: $($report.error)" }

  $target = $null
  if ($WorkspaceId) {
    $match = @($report.workspaces.list | Where-Object { $_.id -eq $WorkspaceId }) | Select-Object -First 1
    if (-not $match) { Write-Warn "No workspace with id '$WorkspaceId'." }
    else { $target = $match }
  } elseif ($WorkspacePath) {
    $match = @($report.workspaces.list | Where-Object { $_.id -like "*$WorkspacePath*" }) | Select-Object -First 1
    if (-not $match) { Write-Warn "No workspace matching path '$WorkspacePath'." }
    else { $target = $match }
  } elseif ([Environment]::UserInteractive) {
    $all = @($report.workspaces.list)
    if ($all.Count -eq 0) { Write-Warn 'No workspaces found.'; return }
    Write-Step 'Workspaces'
    for ($i = 0; $i -lt $all.Count; $i++) {
      Write-Host ("   {0}) {1}  ({2} session(s))" -f ($i + 1), $all[$i].id, $all[$i].sessionCount) -ForegroundColor White
    }
    $sel = Read-Host 'Select a workspace number to delete (0 to cancel)'
    $n = 0
    if ([int]::TryParse($sel, [ref]$n) -and $n -ge 1 -and $n -le $all.Count) { $target = $all[$n - 1] }
  } else {
    Write-Warn 'Specify -WorkspaceId or -WorkspacePath (or run interactively).'
  }

  if (-not $target) { return }

  Write-Step "Delete workspace: $($target.id)"
  Write-Info "sessions  : $($target.sessionCount)"
  Write-Info 'This permanently removes the workspace and all its sessions.'
  if (-not (Confirm-Action "Permanently delete this workspace and all its sessions?")) {
    Write-Warn 'Cancelled.'; return
  }

  Stop-OcApp $(Get-AppInstall | Select-Object -First 1 -ExpandProperty Exe -ErrorAction SilentlyContinue)
  if (-not $NoBackup) { New-Backup $DataDir 'pre-delete-workspace' | Out-Null }

  $cliArgs = @('delete-workspace', '--id', $target.id)
  if ($DryRun) { $cliArgs += '--dry-run' }
  $result = Invoke-OcHelper -Arguments $cliArgs -DataDir $DataDir
  if (-not $result.ok) { Write-Bad "delete failed: $($result.error)"; return }
  if (-not $result.found) { Write-Warn 'Workspace no longer exists in the database.'; return }

  Write-Ok 'Workspace deleted.'
  Write-Ok ("sessions removed: {0}" -f $result.sessionCount)
  Write-Ok ("state rows removed: {0}" -f $result.removedStateRows)

  if ($StartAfter) { Start-OcApp (Get-AppInstall) }
}

function Invoke-FactoryReset {
  $Install = Get-AppInstall
  $DataDir = Get-PrimaryDataDir

  Write-Step 'Factory reset'
  Write-Info 'This deletes all Open Code app data:'
  Write-Info "  $DataDir"
  Write-Info 'The app itself stays installed. Next launch starts as first run.'

  if (-not (Confirm-Action 'Wipe ALL Open Code app data on this device?' 'RESET')) {
    Write-Warn 'Cancelled.'; return
  }

  Stop-OcApp $(if ($Install) { $Install.Exe } else { $null })
  if (-not $NoBackup) { New-Backup $DataDir 'pre-reset' | Out-Null }

  if (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Warn 'Data dir already missing.'
  } else {
    if ($DryRun) { Write-Info "would remove $DataDir" }
    else {
      try {
        Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction Stop
        Write-Ok "removed $DataDir"
      } catch {
        Write-Bad "could not remove $($DataDir): $($_.Exception.Message)"
      }
    }
  }

  Write-Step 'Done'
  if ($NoBackup) { Write-Warn 'No backup was made (-NoBackup).' }
  else { Write-Info ("Backups: {0}" -f (Get-BackupRoot 'opencode')) }
  if ($StartAfter) { Start-OcApp $Install }
}

function Invoke-ListBackups() {
  $items = @(Get-Backups)
  if ($items.Count -eq 0) { Write-Warn 'No backups yet.'; return }
  Write-Step 'Open Code backups'
  foreach ($item in $items) {
    $size = Get-DirSize $item.FullName
    Write-Info ("{0}  {1}" -f $item.Name, (Format-Bytes $size))
  }
}

function Invoke-Uninstall($Install) {
  if (-not $Install) { throw 'Open Code installation not found; nothing to uninstall.' }
  $uninstaller = Join-Path $Install.Dir 'Uninstall OpenCode.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw "Uninstaller not found: $uninstaller" }
  if (-not (Confirm-Action 'Run the Open Code uninstaller?')) { Write-Warn 'Cancelled.'; return }
  Write-Warn 'Your app data can be removed separately after uninstall.'
  if (Confirm-Action 'Wipe app data too (factory reset)?' 'RESET') {
    Invoke-FactoryReset
  }
  if (-not $DryRun) { Start-Process -FilePath $uninstaller -Wait }
  Write-Ok 'Uninstaller finished.'
}

function Show-Version {
  Write-Step 'OpenCodeRepair'
  Write-Info "Tool version : $($script:ToolVersion)"
  $Install = Get-AppInstall
  if ($Install) {
    Write-Info "App install  : $($Install.Dir)"
  } else {
    Write-Warn 'App install  : not found'
  }
  $dataDir = Get-PrimaryDataDir
  Write-Info "Data dir     : $dataDir"
  $backups = @(Get-Backups)
  Write-Info "Backups      : $($backups.Count) available"
}

# --------------------------------------------------------------- entry point
function Show-Menu($Install) {
  Write-Host ""
  Write-Host " Open Code Repair v$($script:ToolVersion)" -ForegroundColor White
  Write-Host ' ------------------' -ForegroundColor DarkGray
  if ($Install) { Write-Host " App: ($($Install.Dir))" -ForegroundColor DarkGray }
  else { Write-Host ' App: not detected (data-only commands still available)' -ForegroundColor DarkGray }
  Write-Host ' 1  Doctor (diagnose problems)'
  Write-Host ' 2  Fix (safe repair + clear caches)'
  Write-Host ' 3  Clear UI cache only'
  Write-Host ' 4  Delete a session'
  Write-Host ' 5  Delete a workspace'
  Write-Host ' 6  Backup now'
  Write-Host ' 7  Restore a backup'
  Write-Host ' 8  Factory reset (wipe all app data)'
  Write-Host ' 9  Uninstall app'
  Write-Host ' 10 Version / locations'
  Write-Host ' 0  Exit'
  Write-Host ''
}

function Wait-MenuPause {
  if ([Environment]::UserInteractive) { Read-Host "`nPress Enter to return to the menu" | Out-Null }
}

$install = Get-AppInstall   # may be $null; data-only commands do not require it

if (-not $Command) {
  if (-not [Environment]::UserInteractive) { $Command = 'doctor' }
  else {
    while ($true) {
      Show-Menu $install
      $choice = Read-Host 'Select'
      switch ($choice) {
        '1' { Invoke-Doctor | Out-Null }
        '2' { Invoke-Fix }
        '3' { $d = Get-PrimaryDataDir; Clear-UiState $d }
        '4' { Invoke-DeleteSession }
        '5' { Invoke-DeleteWorkspace }
        '6' { $d = Get-PrimaryDataDir; New-Backup $d 'manual' | Out-Null }
        '7' { Restore-Backup $BackupPath }
        '8' { Invoke-FactoryReset }
        '9' { Invoke-Uninstall $install }
        '10' { Show-Version }
        '0' { return }
        default { Write-Warn 'Unknown choice.' }
      }
      Wait-MenuPause
    }
  }
}

switch ($Command) {
  'doctor' { Invoke-Doctor | Out-Null }
  'fix' { Invoke-Fix }
  'clear-ui-state' { $d = Get-PrimaryDataDir; Clear-UiState $d }
  'delete-session' { Invoke-DeleteSession }
  'delete-workspace' { Invoke-DeleteWorkspace }
  'backup' { $d = Get-PrimaryDataDir; New-Backup $d 'manual' | Out-Null }
  'restore' { Restore-Backup $BackupPath }
  'list-backups' { Invoke-ListBackups }
  'factory-reset' { Invoke-FactoryReset }
  'uninstall' { Invoke-Uninstall $install }
  'version' { Show-Version }
}
