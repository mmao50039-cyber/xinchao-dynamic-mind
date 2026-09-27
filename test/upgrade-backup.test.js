import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupBeforeUpgrade, UPGRADE_BACKUP_DIR } from '../src/upgrade-backup.js';

async function stateDir(schemaVersion) {
  const dir = await mkdtemp(join(tmpdir(), 'xinchao-upgrade-'));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion, revision: 42 }));
  await writeFile(join(dir, 'transitions.jsonl'), '{"a":1}\n');
  return dir;
}

test('2.x 状态在升级前被原样备份一次', async () => {
  const dir = await stateDir(7);
  const first = await backupBeforeUpgrade(join(dir, 'state.json'));
  assert.equal(first.backedUp, true);
  const backup = join(dir, UPGRADE_BACKUP_DIR);
  assert.deepEqual((await readdir(backup)).sort(), ['state.json', 'transitions.jsonl']);
  assert.equal(JSON.parse(await readFile(join(backup, 'state.json'), 'utf8')).revision, 42);

  // 备份目录已在：不覆盖（哪怕状态又被改过）
  await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, revision: 99 }));
  const second = await backupBeforeUpgrade(join(dir, 'state.json'));
  assert.equal(second.reason, 'backup_exists');
  assert.equal(JSON.parse(await readFile(join(backup, 'state.json'), 'utf8')).revision, 42);
});

test('已是新格式或没有状态文件时什么都不做', async () => {
  const dir = await stateDir(9);
  assert.equal((await backupBeforeUpgrade(join(dir, 'state.json'))).reason, 'already_current');
  assert.equal((await backupBeforeUpgrade(join(dir, 'missing.json'))).reason, 'no_state');
  assert.ok(!(await readdir(dir)).includes(UPGRADE_BACKUP_DIR));
});
