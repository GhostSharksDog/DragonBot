import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/main/settings';

test('website access, input permission and per-model effort persist while folder grants expire', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dragon-settings-'));
  try {
    const store = new SettingsStore(directory), folder = path.resolve(directory, 'task-files');
    store.update({ grant: { folders: [folder], origins: ['https://example.com/path', 'https://example.org:8443'], browserInput: true }, reasoningByModel: { 'model-a': 'high', 'model-b': 'medium' } });
    assert.deepEqual(store.value.grant.folders, [folder], 'Current task retains its folder access');
    const next = new SettingsStore(directory);
    assert.deepEqual(next.value.grant, { folders: [], origins: ['https://example.com', 'https://example.org:8443'], browserInput: true });
    assert.deepEqual(next.value.reasoningByModel, { 'model-a': 'high', 'model-b': 'medium' });
    next.update({ scale: 1.15 });
    const persisted = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
    assert.deepEqual(persisted.grant, next.value.grant, 'Unrelated settings changes must not erase websites');
    next.update({ grant: { folders: [], origins: ['https://example.org:8443'], browserInput: false }, reasoningByModel: { 'model-b': 'medium' } });
    const final = new SettingsStore(directory);
    assert.deepEqual(final.value.grant, { folders: [], origins: ['https://example.org:8443'], browserInput: false });
    assert.deepEqual(final.value.reasoningByModel, { 'model-b': 'medium' }, 'Choosing default clears the previous explicit model setting');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
