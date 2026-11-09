import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);

export async function download(url) {
  if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Only HTTP(S) downloads allowed');
  const dir = await mkdtemp(join(tmpdir(), 'xmarks-download-'));
  try {
    const { stdout } = await exec('curl', ['--silent', '--show-error', '--fail', '--location', '--max-redirs', '3', '--proto', '=http,https', '--proto-redir', '=http,https', '--connect-timeout', '10', '--max-time', '45', '--max-filesize', '20971520', '--output', join(dir, 'body'), '--write-out', '%{content_type}', url], { timeout: 50000, maxBuffer: 1024 * 1024 });
    return { bytes: await readFile(join(dir, 'body')), mime: stdout.trim().split(';')[0] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
