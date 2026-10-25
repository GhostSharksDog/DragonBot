import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserSetupService, extensionState, PLAYWRIGHT_EXTENSION_ID, PLAYWRIGHT_EXTENSION_STORE } from '../src/main/browser-setup';
import { extensionTransportArguments, friendlyBrowserError } from '../src/main/tools/browser';
import { defaults } from '../src/main/settings';
import type { BrowserConnectionConfig, Settings } from '../src/shared/types';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dragon-chrome-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'chrome.exe'); const userData = path.join(directory, 'User Data');
  await writeFile(executable, 'test fixture; never executed'); await mkdir(userData);
  let settings: Settings = { ...structuredClone(defaults), chromeExecutablePath: executable, chromeUserDataDir: userData, chromeProfileDirectory: '' };
  const launches: { config: BrowserConnectionConfig; url: string }[] = []; const external: string[] = []; const statuses: string[] = [];
  const service = new BrowserSetupService({ getSettings: () => settings, updateSettings: patch => { settings = { ...settings, ...patch }; }, openExternal: async url => { external.push(url); }, onChange: state => { statuses.push(state.status); }, executableCandidates: [], launchChrome: async (config, url) => { launches.push({ config, url }); } });
  async function profiles(entries: { id: string; name: string; extension?: 'enabled' | 'disabled' | 'missing' | 'unknown' }[], lastUsed = 'Default') {
    await writeFile(path.join(userData, 'Local State'), JSON.stringify({ profile: { last_used: lastUsed, info_cache: Object.fromEntries(entries.map(item => [item.id, { name: item.name }])) } }));
    for (const item of entries) {
      const base = path.join(userData, item.id); await mkdir(base, { recursive: true });
      const extension = item.extension ?? 'missing';
      await writeFile(path.join(base, 'Preferences'), JSON.stringify({ extensions: { settings: extension === 'missing' ? {} : { [PLAYWRIGHT_EXTENSION_ID]: { state: extension === 'disabled' ? 0 : 1, disable_reasons: extension === 'disabled' ? [1] : [] } } } }));
      if (extension !== 'missing' && extension !== 'unknown') {
        const version = path.join(base, 'Extensions', PLAYWRIGHT_EXTENSION_ID, '0.4.0_0'); await mkdir(version, { recursive: true }); await writeFile(path.join(version, 'manifest.json'), '{}');
      }
    }
  }
  return { service, launches, external, statuses, executable, userData, profiles, settings: () => settings, patch: (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; } };
}

test('detects Chrome, default profile and enabled official extension without exposing local paths', async t => {
  const f = await fixture(t); await f.profiles([{ id: 'Default', name: '日常 Chrome', extension: 'enabled' }]);
  const state = await f.service.detect();
  assert.equal(state.status, 'ready'); assert.equal(state.canConnect, true); assert.equal(state.profiles[0].lastUsed, true);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(f.userData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(await f.service.getConnectionConfig(), { executablePath: f.executable, userDataDir: f.userData, profileDirectory: 'Default' });
  assert.deepEqual(f.statuses.slice(0, 2), ['detecting', 'detecting']);
});

test('missing Chrome offers official browser installation rather than starting any executable', async t => {
  const f = await fixture(t); f.patch({ chromeExecutablePath: '' });
  const state = await f.service.detect(); assert.equal(state.status, 'missing-browser'); assert.equal(state.canConnect, false);
  await f.service.install(); assert.deepEqual(f.external, ['https://www.google.com/chrome/']); assert.deepEqual(f.launches, []);
});

test('finds extension in another profile, persists selected user and passes exact daily-Chrome configuration', async t => {
  const f = await fixture(t); await f.profiles([{ id: 'Default', name: '个人' }, { id: 'Profile 1', name: '工作', extension: 'enabled' }]);
  assert.equal((await f.service.detect()).status, 'profile-mismatch');
  const selected = await f.service.select('Profile 1'); assert.equal(selected.status, 'ready'); assert.equal(selected.selectedProfileId, 'Profile 1');
  assert.equal(f.settings().chromeProfileDirectory, 'Profile 1');
  await f.service.install(); assert.equal(f.launches[0].config.profileDirectory, 'Profile 1'); assert.equal(f.launches[0].url, PLAYWRIGHT_EXTENSION_STORE);
  assert.deepEqual(await f.service.getConnectionConfig(), { executablePath: f.executable, userDataDir: f.userData, profileDirectory: 'Profile 1' });
  await assert.rejects(() => f.service.select('../Other'), /请选择/);
});

test('disabled extension opens selected user extension management and cannot connect until re-enabled', async t => {
  const f = await fixture(t); await f.profiles([{ id: 'Default', name: '个人', extension: 'disabled' }]);
  assert.equal((await f.service.detect()).status, 'extension-disabled');
  await assert.rejects(() => f.service.getConnectionConfig(), /停用/);
  await f.service.install(); assert.equal(f.launches[0].url, `chrome://extensions/?id=${PLAYWRIGHT_EXTENSION_ID}`);
  await f.profiles([{ id: 'Default', name: '个人', extension: 'enabled' }]);
  assert.equal((await f.service.detect()).status, 'ready');
});

test('missing extension opens official store in exact selected Chrome and re-detects after installation', async t => {
  const f = await fixture(t); await f.profiles([{ id: 'Default', name: '日常' }]);
  assert.equal((await f.service.detect()).status, 'missing-extension'); await f.service.install();
  assert.deepEqual(f.launches, [{ config: { executablePath: f.executable, userDataDir: f.userData, profileDirectory: 'Default' }, url: PLAYWRIGHT_EXTENSION_STORE }]);
  await f.profiles([{ id: 'Default', name: '日常', extension: 'enabled' }]); assert.equal((await f.service.detect()).canConnect, true);
});

test('unknown extension settings are explained and Chrome errors never expose tokens, paths or stack traces', async t => {
  const f = await fixture(t); await f.profiles([{ id: 'Default', name: '个人', extension: 'unknown' }]);
  assert.match((await f.service.detect()).message, /无法确定/);
  f.service.setConnectionState('connecting'); assert.equal(f.service.getSnapshot().status, 'awaiting-confirmation');
  f.service.setConnectionState('connected'); assert.equal(f.service.getSnapshot().status, 'connected');
  f.service.setConnectionState('disconnected'); assert.equal(f.service.getSnapshot().status, 'ready');
  f.service.setConnectionState('failed', 'transport token=super-secret C:\\Users\\private\\config.json');
  assert.doesNotMatch(f.service.getSnapshot().message, /super-secret|private|transport|config\.json/);
  assert.doesNotMatch(friendlyBrowserError(new Error('EACCES C:\\Users\\secret token=abc')), /secret|abc|EACCES/);
});

test('secure preferences disable flags take precedence and incomplete extension installs remain uncertain', () => {
  const value = (state: number, reasons: unknown) => ({ extensions: { settings: { [PLAYWRIGHT_EXTENSION_ID]: { state, disable_reasons: reasons } } } });
  assert.equal(extensionState(value(1, []), value(0, []), true), 'disabled');
  assert.equal(extensionState(value(1, 8), null, true), 'disabled');
  assert.equal(extensionState(value(1, []), null, false), 'unknown');
});

test('extension transport explicitly reuses configured executable, user data and profile', () => {
  const config = { executablePath: path.resolve('chrome.exe'), userDataDir: path.resolve('User Data'), profileDirectory: 'Profile 1' };
  const args = extensionTransportArguments('/packaged/mcp/cli.js', config);
  assert.deepEqual(args.slice(-6), ['--executable-path', config.executablePath, '--user-data-dir', config.userDataDir, '--profile-dir-name', 'Profile 1']);
  assert.ok(args.includes('--extension')); assert.ok(args.includes('--no-webmcp'));
  assert.throws(() => extensionTransportArguments('cli.js', { ...config, profileDirectory: '../Default' }), /配置无效/);
});
