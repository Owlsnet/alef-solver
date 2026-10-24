<#
  Launch Chrome with a remote-debugging port so tools/solve.js can drive it.

  Two modes, neither of which copies any of your data:

    .\launch.ps1                 fresh profile at <project>\.chrome-profile (git-ignored)
                                 (log in to alefed once; it persists from then on)

    .\launch.ps1 -UseRealProfile uses your everyday profile directly.
                                 Requires every chrome.exe to be closed first —
                                 Chrome refuses the flag otherwise.
#>

param(
  [int]$Port = 9222,
  [switch]$UseRealProfile,
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'

$exe = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $exe) { throw "chrome.exe not found" }

if ($UseRealProfile) {
  $running = @(Get-Process chrome -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    Write-Host "`n✗ $($running.Count) chrome processes are running." -ForegroundColor Red
    Write-Host "  Chrome only enables the debug port on a profile no other instance owns." -ForegroundColor Yellow
    Write-Host "  Close Chrome completely (check the tray) and run this again.`n" -ForegroundColor Yellow
    exit 1
  }
  $dest = "$env:LOCALAPPDATA\Google\Chrome\User Data"
  Write-Host "using your real profile: $dest" -ForegroundColor Yellow
} else {
  $dest = Join-Path (Split-Path $PSScriptRoot -Parent) '.chrome-profile'
  if ($Fresh -and (Test-Path $dest)) {
    Remove-Item $dest -Recurse -Force
    Write-Host "wiped the debug profile" -ForegroundColor DarkGray
  }
  New-Item -ItemType Directory -Force $dest | Out-Null
}

# Bail out if something already holds the port.
try {
  $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  Write-Host "`n✓ already listening on :$Port — $($v.Browser)" -ForegroundColor Green
  Write-Host "`n  node tools\solve.js --recon`n" -ForegroundColor Cyan
  exit 0
} catch { }

$cargs = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$dest",
  "--no-first-run",
  "--no-default-browser-check",
  "https://moe.alefed.com"
)

Write-Host "`nlaunching chrome on :$Port" -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList $cargs | Out-Null

foreach ($i in 1..48) {
  Start-Sleep -Milliseconds 250
  try {
    $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    Write-Host "✓ ready: $($v.Browser)" -ForegroundColor Green
    if (-not $UseRealProfile) {
      Write-Host "`n  If that window shows a login page, sign in to alefed once." -ForegroundColor Yellow
      Write-Host "  The session is stored in the debug profile and survives restarts.`n" -ForegroundColor Yellow
    }
    Write-Host "  node tools\solve.js --recon      # see what it scrapes" -ForegroundColor White
    Write-Host "  node tools\solve.js --solve      # full cycle`n" -ForegroundColor White
    exit 0
  } catch { }
}

Write-Warning "chrome started but :$Port never answered"
exit 1
