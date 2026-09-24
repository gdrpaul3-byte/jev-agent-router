import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';

/** No implicit environment search: hosts choose a key or one local file. */
export async function loadApiKey({ apiKey = '', envFile } = {}) {
  if (typeof apiKey !== 'string') throw new Error('JEV_CONFIG_INVALID');
  if (apiKey.trim()) return apiKey.trim();
  if (envFile === undefined) return '';
  let file;
  try {
    file = await open(envFile, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error();
    const env = parseEnv(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
    return (env.TYPESAFE_API_KEY ?? '').trim();
  } catch { throw new Error('JEV_CONFIG_READ_ERROR'); }
  finally { await file?.close().catch(() => {}); }
}
