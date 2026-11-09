import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('STATE_OR_CONFIG_INVALID: refusing to reset an unreadable file'); }
}
export async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function lock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const f = await open(path, 'wx', 0o600);
      await f.writeFile(JSON.stringify({ pid: process.pid })); await f.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await readJSON(path, null);
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('LOCK_INVALID: inspect lock file manually');
      try { process.kill(owner.pid, 0); } catch (err) {
        if (err.code === 'ESRCH') { await rm(path, { force: true }); continue; }
        throw err;
      }
      throw new Error('ALREADY_RUNNING: another listener owns this state directory');
    }
  }
  throw new Error('LOCK_UNAVAILABLE');
}
