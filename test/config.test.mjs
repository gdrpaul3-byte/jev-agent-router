import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadApiKey } from '../src/config.mjs';

test('explicit key wins and is trimmed without reading a file', async () => {
  assert.equal(await loadApiKey({ apiKey: ' local-secret ', envFile: 'missing' }), 'local-secret');
});

test('absent configuration does not discover unrelated keys', async () => {
  assert.equal(await loadApiKey(), '');
});

test('reads only the named key from an explicit UTF8 environment file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-config-'));
  try {
    const file = join(directory, '.env');
    await writeFile(file, '\uFEFF# local configuration\r\nOTHER_KEY=not-used\r\nTYPESAFE_API_KEY="test-secret"\r\n');
    assert.equal(await loadApiKey({ envFile: file }), 'test-secret');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configuration errors never echo paths or file content', async () => {
  await assert.rejects(loadApiKey({ envFile: 'private-secret-path/missing.env' }), error => {
    assert.equal(error.message, 'JEV_CONFIG_READ_ERROR');
    assert.equal(String(error).includes('private-secret'), false);
    return true;
  });
});
