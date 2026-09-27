import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// 2.x → 3.x 升级前的一次性备份。
// 3.x 第一次读到旧状态（schemaVersion < 9）会把它改写成新格式，改完 2.x 就读不回去了。
// Railway 这类平台的存储卷不一定有快照可用，所以在动它之前，把状态目录里的文件
// 原样拷一份到同一个卷的 pre-3.3-backup/ 下。已经有这个目录就不再碰，只备份一次。
export const UPGRADE_BACKUP_DIR = 'pre-3.3-backup';
const CURRENT_SCHEMA = 9;

export async function backupBeforeUpgrade(statePath, log = () => {}) {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch { return { backedUp: false, reason: 'no_state' }; }
  const schema = Number(state?.schemaVersion) || 0;
  if (schema >= CURRENT_SCHEMA) return { backedUp: false, reason: 'already_current' };

  const dir = dirname(statePath);
  const target = join(dir, UPGRADE_BACKUP_DIR);
  try { await stat(target); return { backedUp: false, reason: 'backup_exists' }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  await mkdir(target, { recursive: true });
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    await copyFile(join(dir, entry.name), join(target, entry.name));
    files.push(entry.name);
  }
  log('upgrade_backup_created', { fromSchema: schema, dir: target, files });
  return { backedUp: true, dir: target, files };
}
