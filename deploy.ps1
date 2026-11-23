# One-shot deploy of Equipment Map to Cloudflare (Pages + KV + R2).
# Prerequisite: Node.js LTS installed (https://nodejs.org). Run in this folder:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# Optional: -SkipAssets to skip uploading plans/photos (already uploaded).
param([string]$Project = 'equipment-map', [string]$Bucket = 'equipment-assets', [switch]$SkipAssets)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw 'Node.js not found. Install Node.js LTS first, then reopen PowerShell.' }
$w = 'npx --yes wrangler@3'

Write-Host '1) Login (browser opens)'; Invoke-Expression "$w login"

Write-Host '2) R2 bucket'; try { Invoke-Expression "$w r2 bucket create $Bucket" } catch { Write-Host 'bucket exists, continuing' }

Write-Host '3) KV namespace'
$toml = Get-Content wrangler.toml -Raw
if ($toml -match 'REPLACE_WITH_KV_NAMESPACE_ID') {
  $out = (Invoke-Expression "$w kv namespace create STATE" | Out-String)
  if ($out -notmatch '"?id"?\s*[:=]\s*"([0-9a-f]{32})"') { throw "Could not read KV id from:`n$out" }
  Set-Content wrangler.toml ($toml -replace 'REPLACE_WITH_KV_NAMESPACE_ID', $Matches[1]) -Encoding UTF8
  Write-Host "KV id $($Matches[1]) written to wrangler.toml"
}

if (-not $SkipAssets) {
  Write-Host '4) Upload plans and photos to R2 (about 460 MB, takes a while)'
  foreach ($kind in 'plans', 'photos') {
    $files = Get-ChildItem "assets-upload\$kind" -File; $i = 0
    foreach ($f in $files) {
      $i++; Write-Host "[$kind $i/$($files.Count)] $($f.Name)"
      Invoke-Expression "$w r2 object put $Bucket/$kind/$($f.Name) --file `"$($f.FullName)`" --remote" | Out-Null
    }
  }
}

Write-Host '5) Deploy site + functions'
Invoke-Expression "$w pages project create $Project --production-branch main" 2>$null
Invoke-Expression "$w pages deploy public --project-name $Project --branch main"
Write-Host 'Done. Check Pages > Settings > Functions: bindings STATE (KV) and BUCKET (R2). Optional: add secret EDIT_TOKEN to restrict editing.'
