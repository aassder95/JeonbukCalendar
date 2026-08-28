const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'run-sync-state-fixture.ps1');
const windowsOnly = { skip: process.platform !== 'win32' };

function runFixture(outputPath, extraArguments = []) {
  return spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fixturePath,
    '-OutputPath',
    outputPath,
    ...extraArguments,
  ], { cwd: repoRoot, encoding: 'utf8' });
}

test('sync state is written atomically with the successful commit and result metadata', windowsOnly, () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeonbuk-sync-state-'));
  const outputPath = path.join(temporaryDirectory, '.sync-state.json');

  try {
    const result = runFixture(outputPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(`${outputPath}.tmp`), false);

    const state = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(state.lastSyncedCommit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(state.icsHash, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(state.sourceVersion, 'test-version');
    assert.ok(Number.isFinite(Date.parse(state.syncedAt)));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('invalid sync state input does not create or replace the state file', windowsOnly, () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeonbuk-sync-state-'));
  const outputPath = path.join(temporaryDirectory, '.sync-state.json');
  const original = '{"preserved":true}\n';
  fs.writeFileSync(outputPath, original, 'utf8');

  try {
    const result = runFixture(outputPath, ['-InvalidCommit']);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
    assert.equal(fs.existsSync(`${outputPath}.tmp`), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
