Set-StrictMode -Version Latest

function Get-OriginMainCommit {
  param(
    [Parameter(Mandatory)]
    [string]$RepoRoot
  )

  $commitOutput = & git -C $RepoRoot rev-parse --verify origin/main 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "origin/main commit을 확인하지 못했습니다: $($commitOutput -join ' ')"
  }

  $commitSha = ($commitOutput | Select-Object -Last 1).Trim()
  if ($commitSha -notmatch '^[0-9a-f]{40}$') {
    throw "origin/main commit SHA가 올바르지 않습니다: $commitSha"
  }
  return $commitSha
}

function Write-SyncStateFile {
  param(
    [Parameter(Mandatory)]
    [string]$SyncStatePath,

    [Parameter(Mandatory)]
    [string]$CommitSha,

    [Parameter(Mandatory)]
    [object]$Result
  )

  if ($CommitSha -notmatch '^[0-9a-f]{40}$') {
    throw "동기화 상태에 기록할 commit SHA가 올바르지 않습니다: $CommitSha"
  }
  if ($Result.icsHash -isnot [string] -or $Result.icsHash -notmatch '^[0-9a-f]{64}$') {
    throw '동기화 상태에 기록할 ICS 해시가 올바르지 않습니다.'
  }
  if ($Result.sourceVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($Result.sourceVersion)) {
    throw '동기화 상태에 기록할 소스 버전이 없습니다.'
  }

  $state = [ordered]@{
    lastSyncedCommit = $CommitSha
    syncedAt = [DateTimeOffset]::Now.ToString('o')
    icsHash = $Result.icsHash
    sourceVersion = $Result.sourceVersion
  }
  $stateJson = $state | ConvertTo-Json
  $temporaryPath = "$SyncStatePath.tmp"

  try {
    [IO.File]::WriteAllText($temporaryPath, "$stateJson`r`n", [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $SyncStatePath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}
