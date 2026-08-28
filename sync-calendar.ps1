[CmdletBinding()]
param(
  [ValidateSet('Preview', 'Status', 'Sync')]
  [string]$Action = 'Sync',

  [string]$ExpectedIcsHash,

  [switch]$AllowLargeDelete,

  [switch]$Json,

  [ValidateRange(30, 900)]
  [int]$TimeoutSeconds = 420
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = $PSScriptRoot
$claspScript = Join-Path $repoRoot 'node_modules\@google\clasp\build\src\index.js'
$claspProject = Join-Path $repoRoot '.clasp.json'
$syncLogPath = Join-Path $repoRoot 'sync-log.txt'
$syncStatePath = Join-Path $repoRoot '.sync-state.json'
$syncStateScript = Join-Path $repoRoot 'scripts\sync-state.ps1'
. $syncStateScript

function Add-SyncLogEntry {
  param(
    [Parameter(Mandatory)]
    [string]$Status,

    [Parameter(Mandatory)]
    [string]$Details
  )

  $timestamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  $singleLineDetails = $Details -replace '[\r\n]+', ' '
  Add-Content -LiteralPath $syncLogPath -Value "$timestamp status=$Status $singleLineDetails" -Encoding UTF8
}

function Invoke-ClaspFunction {
  param(
    [Parameter(Mandatory)]
    [string]$FunctionName,

    [object[]]$Parameters = @()
  )

  $parameterArguments = ''
  if ($Parameters.Count -gt 0) {
    $parametersJson = ConvertTo-Json -InputObject $Parameters -Compress
    $escapedParameters = $parametersJson.Replace('"', '\"')
    $parameterArguments = " --params `"$escapedParameters`""
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeCommand.Source
  $startInfo.Arguments = "`"$claspScript`" --project `"$claspProject`" --json run-function $FunctionName --nondev$parameterArguments"
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw 'clasp 프로세스를 시작하지 못했습니다.'
  }

  $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
  $standardErrorTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { }
    throw "Apps Script 실행이 제한 시간 ${TimeoutSeconds}초를 초과했습니다."
  }
  $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
  $standardError = $standardErrorTask.GetAwaiter().GetResult()
  $outputText = $standardOutput.Trim()

  if ($process.ExitCode -ne 0) {
    throw "Apps Script 실행에 실패했습니다. (종료 코드: $($process.ExitCode))`n$($standardError.Trim())`n$outputText"
  }

  try {
    $resultEnvelope = $outputText | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Apps Script 응답이 유효한 JSON이 아닙니다.`n$outputText"
  }

  $errorProperty = $resultEnvelope.PSObject.Properties['error']
  if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) {
    $errorJson = $errorProperty.Value | ConvertTo-Json -Depth 10 -Compress
    throw "Apps Script가 오류를 반환했습니다: $errorJson"
  }

  $responseProperty = $resultEnvelope.PSObject.Properties['response']
  if ($null -eq $responseProperty -or $null -eq $responseProperty.Value) {
    throw "Apps Script 응답에 response가 없습니다.`n$outputText"
  }
  return $responseProperty.Value
}

function Assert-SyncCounts {
  param([Parameter(Mandatory)][object]$Result)

  foreach ($propertyName in 'created', 'updated', 'unchanged', 'deleted') {
    $property = $Result.PSObject.Properties[$propertyName]
    if ($null -eq $property -or $property.Value -isnot [long] -and $property.Value -isnot [int]) {
      throw "Apps Script 응답에 정수형 '$propertyName' 값이 없습니다."
    }
    if ($property.Value -lt 0) {
      throw "Apps Script 응답의 '$propertyName' 값이 음수입니다."
    }
  }
  if ($Result.icsHash -isnot [string] -or $Result.icsHash -notmatch '^[0-9a-f]{64}$') {
    throw 'Apps Script 응답에 유효한 SHA-256 ICS 해시가 없습니다.'
  }
  if ($Result.sourceVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($Result.sourceVersion)) {
    throw 'Apps Script 응답에 소스 버전이 없습니다.'
  }
}

function Write-PlanOutput {
  param([Parameter(Mandatory)][object]$Plan)

  if ($Json) {
    $Plan | ConvertTo-Json -Depth 10
    return
  }

  Write-Output '전북현대 일정 동기화 미리보기'
  Write-Output "추가 $($Plan.created)건 / 수정 $($Plan.updated)건 / 변경 없음 $($Plan.unchanged)건 / 삭제 $($Plan.deleted)건"
  Write-Output "ICS 해시 $($Plan.icsHash)"
  Write-Output "배포 소스 버전 $($Plan.sourceVersion)"
  if ($Plan.requiresDeleteConfirmation) {
    Write-Warning '대량 삭제 승인이 필요합니다.'
  }
  foreach ($changeType in 'created', 'updated', 'deleted') {
    foreach ($change in $Plan.changes.$changeType) {
      Write-Output "[$changeType] $($change.uid) $($change.summary)"
    }
  }
}

try {

if (-not (Test-Path -LiteralPath $claspScript -PathType Leaf)) {
  throw "clasp를 찾을 수 없습니다. 저장소에서 'npm ci'를 먼저 실행하세요."
}

if (-not (Test-Path -LiteralPath $claspProject -PathType Leaf)) {
  throw ".clasp.json을 찾을 수 없습니다. .clasp.json.example을 복사하고 Apps Script ID와 Google Cloud 프로젝트 ID를 입력하세요."
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  throw "Node.js를 찾을 수 없습니다. Node.js를 설치하고 PATH에 추가하세요."
}

if ($Action -eq 'Preview' -or $Action -eq 'Status') {
  $plan = Invoke-ClaspFunction -FunctionName 'previewJeonbuk'
  Assert-SyncCounts -Result $plan
  Write-PlanOutput -Plan $plan
  return
}

$preview = Invoke-ClaspFunction -FunctionName 'previewJeonbuk'
Assert-SyncCounts -Result $preview
if ($preview.requiresDeleteConfirmation -and -not $AllowLargeDelete) {
  Write-PlanOutput -Plan $preview
  throw '대량 삭제가 예정되어 적용하지 않았습니다. 내용을 확인한 뒤 -AllowLargeDelete를 명시하세요.'
}
$approvedHash = if ($ExpectedIcsHash) { $ExpectedIcsHash } else { $preview.icsHash }
$result = Invoke-ClaspFunction -FunctionName 'applyJeonbuk' -Parameters @($approvedHash, [bool]$AllowLargeDelete)
Assert-SyncCounts -Result $result
$originMainCommit = Get-OriginMainCommit -RepoRoot $repoRoot
Write-SyncStateFile -SyncStatePath $syncStatePath -CommitSha $originMainCommit -Result $result

if ($Json) {
  $result | ConvertTo-Json -Depth 10
} else {
  Write-Output '전북현대 일정 동기화 완료'
  Write-Output "추가 $($result.created)건"
  Write-Output "수정 $($result.updated)건"
  Write-Output "변경 없음 $($result.unchanged)건"
  Write-Output "삭제 $($result.deleted)건"
  Write-Output "ICS 해시 $($result.icsHash)"
  Write-Output "배포 소스 버전 $($result.sourceVersion)"
}
} catch {
  $syncError = $_
  if ($Action -eq 'Sync') {
    try {
      Add-SyncLogEntry -Status 'failed' -Details "error=$($syncError.Exception.Message)"
    } catch {
      Write-Warning "동기화 실패 이력을 기록하지 못했습니다: $($_.Exception.Message)"
    }
  }
  throw $syncError
}

try {
  Add-SyncLogEntry -Status 'success' -Details "created=$($result.created) updated=$($result.updated) unchanged=$($result.unchanged) deleted=$($result.deleted)"
} catch {
  Write-Warning "동기화 성공 이력을 기록하지 못했습니다: $($_.Exception.Message)"
}
