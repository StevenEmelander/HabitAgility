param(
  [string]$UnlockToken = $env:UNLOCK_TOKEN,
  [string]$BaseUrl = $(if (-not [string]::IsNullOrWhiteSpace($env:BASE_URL)) { $env:BASE_URL } else { 'https://ght.vexom.io' }),
  [string]$OutDir = $(Join-Path $PSScriptRoot '..\backups')
)

# Backup the entire habit-tracker data via the per-item REST API.
#
# Layout (v0.5+):
#   /api/trend/sprint-summary       → list of all sprints (id, dates, name, …)
#   /api/sprint/:id                 → full sprint def (categories, habits, retrospective, …)
#   /api/entry/:dateKey             → one day's entry (habitValuesById, sprintId)
#
# The previous version of this script targeted /api/cycles and /api/entries,
# which were removed in the v0.5 refactor. This rewrite walks the summary list,
# fetches each full sprint definition, then enumerates every date covered by
# any sprint and pulls the entry (skipping 404s for unentered days).

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($UnlockToken)) {
  Write-Host "Usage: `$env:UNLOCK_TOKEN='your-token'; .\backup.ps1"
  exit 1
}

# Compute htok = sha256(UNLOCK_TOKEN) as lowercase hex
$sha = [System.Security.Cryptography.SHA256]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($UnlockToken)
$hash = $sha.ComputeHash($bytes)
$htok = ($hash | ForEach-Object { $_.ToString('x2') }) -join ''

$cookieJar = New-Object System.Net.CookieContainer
$uri = [Uri]$BaseUrl
$cookieJar.Add((New-Object System.Net.Cookie('htok', $htok, '/', $uri.Host)))
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.Cookies = $cookieJar

function Get-Json {
  param([string]$Path)
  return Invoke-RestMethod -Uri "$BaseUrl$Path" -WebSession $session -Method Get
}

# 1. Sprint summaries — gives us all sprint IDs and their date ranges.
Write-Host "Fetching /api/trend/sprint-summary ..."
$summary = Get-Json '/api/trend/sprint-summary'
$summaries = @($summary.summaries)
Write-Host "  found $($summaries.Count) sprint(s)"

# 2. Full sprint defs.
Write-Host "Fetching each /api/sprint/:id ..."
$sprints = @()
foreach ($s in $summaries) {
  $def = Get-Json "/api/sprint/$($s.sprintId)"
  $sprints += $def
}
Write-Host "  $($sprints.Count) full sprint def(s) loaded"

# 3. Entries — iterate over each sprint's date range. Days without an entry
#    return an empty habitValuesById; skip those rather than persisting noise.
Write-Host "Fetching /api/entry/:dateKey for every covered date ..."
$entries = [ordered]@{}
foreach ($sprint in $sprints) {
  if (-not $sprint.startDate -or -not $sprint.endDate) { continue }
  $cur = [datetime]::ParseExact($sprint.startDate, 'yyyy-MM-dd', $null)
  $end = [datetime]::ParseExact($sprint.endDate, 'yyyy-MM-dd', $null)
  while ($cur -le $end) {
    $dk = $cur.ToString('yyyy-MM-dd')
    if (-not $entries.Contains($dk)) {
      try {
        $entry = Get-Json "/api/entry/$dk"
        if ($entry.habitValuesById -and $entry.habitValuesById.PSObject.Properties.Count -gt 0) {
          $entries[$dk] = $entry
        }
      }
      catch {
        # Network/transient errors: surface and abort so a partial backup
        # doesn't masquerade as complete.
        Write-Host "  ERROR fetching $dk : $_"
        throw
      }
    }
    $cur = $cur.AddDays(1)
  }
}
Write-Host "  $($entries.Count) entry row(s) captured"

# 4. Write a single timestamped JSON.
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir "habit-tracker-$stamp.json"
$payload = [ordered]@{
  exportedAt = (Get-Date).ToString('o')
  schemaVersion = '0.6'
  sprints = $sprints
  entries = $entries
}
$payload | ConvertTo-Json -Depth 32 | Out-File -FilePath $file -Encoding utf8

Write-Host ""
Write-Host "Saved $file"
Write-Host "  sprints: $($sprints.Count)"
Write-Host "  entries: $($entries.Count)"
