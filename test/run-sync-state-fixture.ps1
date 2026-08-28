param(
  [Parameter(Mandatory)]
  [string]$OutputPath,

  [switch]$InvalidCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\sync-state.ps1')

$result = [pscustomobject]@{
  icsHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  sourceVersion = 'test-version'
}
$commitSha = if ($InvalidCommit) { 'invalid' } else { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }

Write-SyncStateFile -SyncStatePath $OutputPath -CommitSha $commitSha -Result $result
