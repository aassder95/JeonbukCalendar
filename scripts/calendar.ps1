[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('Validate', 'Preview', 'Status', 'Sync', 'Deploy')]
  [string]$Action = 'Status',

  [string]$DeploymentId,

  [switch]$AllowLargeDelete,

  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $repoRoot 'sync-calendar.ps1'
$codePath = Join-Path $repoRoot 'apps-script\Code.gs'
$claspScript = Join-Path $repoRoot 'node_modules\@google\clasp\build\src\index.js'
$claspProject = Join-Path $repoRoot '.clasp.json'

function Get-LocalSourceVersion {
  $source = Get-Content -LiteralPath $codePath -Raw
  $match = [regex]::Match($source, "sourceVersion:\s*'([^']+)'" )
  if (-not $match.Success) {
    throw 'apps-script/Code.gs에서 sourceVersion을 찾을 수 없습니다.'
  }
  return $match.Groups[1].Value
}

function Invoke-Validation {
  Push-Location $repoRoot
  try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'npm.cmd test가 실패했습니다.' }

    & git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'git diff --check가 실패했습니다.' }

    $trackedSecrets = @(& git ls-files -- '.clasp.json' '.clasprc*.json' 'client_secret*.json' 'oauth-client*.json')
    if ($LASTEXITCODE -ne 0) { throw 'Git 비밀 파일 추적 검사가 실패했습니다.' }
    if ($trackedSecrets.Count -gt 0) {
      throw "Git이 비밀 파일을 추적하고 있습니다: $($trackedSecrets -join ', ')"
    }

    $result = [ordered]@{
      valid = $true
      sourceVersion = Get-LocalSourceVersion
      trackedSecretCount = 0
    }
    if ($Json) { $result | ConvertTo-Json } else { Write-Output "로컬 검증 완료 (소스 버전 $($result.sourceVersion))" }
  } finally {
    Pop-Location
  }
}

function Invoke-RemotePlan {
  $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $syncScript -Action Preview -Json
  if ($LASTEXITCODE -ne 0) { throw '원격 동기화 미리보기가 실패했습니다.' }
  return $output | ConvertFrom-Json
}

if ($Action -eq 'Validate') {
  Invoke-Validation
  exit 0
}

if ($Action -eq 'Preview') {
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $syncScript, '-Action', 'Preview')
  if ($Json) { $arguments += '-Json' }
  & powershell.exe @arguments
  exit $LASTEXITCODE
}

if ($Action -eq 'Status') {
  $plan = Invoke-RemotePlan
  $localVersion = Get-LocalSourceVersion
  $status = [ordered]@{
    deploymentMatchesLocal = $plan.sourceVersion -eq $localVersion
    localSourceVersion = $localVersion
    deployedSourceVersion = $plan.sourceVersion
    icsHash = $plan.icsHash
    created = $plan.created
    updated = $plan.updated
    unchanged = $plan.unchanged
    deleted = $plan.deleted
    requiresDeleteConfirmation = $plan.requiresDeleteConfirmation
  }
  if ($Json) {
    $status | ConvertTo-Json
  } else {
    Write-Output "로컬 소스 버전 $localVersion"
    Write-Output "배포 소스 버전 $($plan.sourceVersion)"
    Write-Output "배포 일치 $($status.deploymentMatchesLocal)"
    Write-Output "예정 변경: 추가 $($plan.created) / 수정 $($plan.updated) / 변경 없음 $($plan.unchanged) / 삭제 $($plan.deleted)"
    Write-Output "ICS 해시 $($plan.icsHash)"
  }
  if (-not $status.deploymentMatchesLocal) { exit 2 }
  exit 0
}

if ($Action -eq 'Sync') {
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $syncScript, '-Action', 'Sync')
  if ($AllowLargeDelete) { $arguments += '-AllowLargeDelete' }
  if ($Json) { $arguments += '-Json' }
  & powershell.exe @arguments
  exit $LASTEXITCODE
}

if (-not $DeploymentId) {
  throw 'Deploy에는 기존 API 실행 파일의 -DeploymentId가 필요합니다.'
}
Invoke-Validation
if (-not (Test-Path -LiteralPath $claspProject -PathType Leaf)) {
  throw '.clasp.json을 찾을 수 없습니다.'
}
if (-not (Test-Path -LiteralPath $claspScript -PathType Leaf)) {
  throw "clasp를 찾을 수 없습니다. 저장소에서 'npm ci'를 먼저 실행하세요."
}

Push-Location $repoRoot
try {
  & node $claspScript --project $claspProject push --force
  if ($LASTEXITCODE -ne 0) { throw 'Apps Script 소스 반영이 실패했습니다.' }

  $versionOutput = & node $claspScript --project $claspProject --json version "JeonbukCalendar $(Get-LocalSourceVersion)"
  if ($LASTEXITCODE -ne 0) { throw 'Apps Script 버전 생성이 실패했습니다.' }
  $versionResult = $versionOutput | ConvertFrom-Json
  $versionNumber = $versionResult.versionNumber
  if ($null -eq $versionNumber) { $versionNumber = $versionResult.version }
  if ($null -eq $versionNumber) { throw '생성된 Apps Script 버전 번호를 확인할 수 없습니다.' }

  & node $claspScript --project $claspProject redeploy $DeploymentId --versionNumber $versionNumber --description "JeonbukCalendar $(Get-LocalSourceVersion)"
  if ($LASTEXITCODE -ne 0) { throw 'API 실행 파일 배포 갱신이 실패했습니다.' }
  Write-Output "Apps Script 배포 완료: 소스 $(Get-LocalSourceVersion), 버전 $versionNumber"
} finally {
  Pop-Location
}
