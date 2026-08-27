[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = $PSScriptRoot
$claspScript = Join-Path $repoRoot 'node_modules\@google\clasp\build\src\index.js'
$claspProject = Join-Path $repoRoot '.clasp.json'

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

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodeCommand.Source
$startInfo.Arguments = "`"$claspScript`" --project `"$claspProject`" --json run-function syncJeonbuk --nondev"
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

$standardOutput = $process.StandardOutput.ReadToEnd()
$standardError = $process.StandardError.ReadToEnd()
$process.WaitForExit()
$exitCode = $process.ExitCode
$outputText = $standardOutput.Trim()

if ($exitCode -ne 0) {
  $errorText = $standardError.Trim()
  throw "Apps Script 실행에 실패했습니다. (종료 코드: $exitCode)`n$errorText`n$outputText"
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
$result = $responseProperty.Value

foreach ($propertyName in 'created', 'updated', 'unchanged', 'deleted') {
  $property = $result.PSObject.Properties[$propertyName]
  if ($null -eq $property -or $property.Value -isnot [long] -and $property.Value -isnot [int]) {
    throw "Apps Script 응답에 정수형 '$propertyName' 값이 없습니다.`n$outputText"
  }
  if ($property.Value -lt 0) {
    throw "Apps Script 응답의 '$propertyName' 값이 음수입니다.`n$outputText"
  }
}

Write-Output '전북현대 일정 동기화 완료'
Write-Output "추가 $($result.created)건"
Write-Output "수정 $($result.updated)건"
Write-Output "변경 없음 $($result.unchanged)건"
Write-Output "삭제 $($result.deleted)건"
