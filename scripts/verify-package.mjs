import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const argument = name => { const index = process.argv.indexOf(name); if (index === -1) return null; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`); return value; };
const checkBackend = process.argv.includes('--backend');
const withTurn = process.argv.includes('--turn');
const codexHome = argument('--codex-home');
if (withTurn && !checkBackend) throw new Error('--turn requires --backend.');
if (checkBackend && (!codexHome || !path.isAbsolute(codexHome))) throw new Error('--backend requires --codex-home with the actual user\'s absolute Codex home.');
const executable = path.resolve(argument('--executable') ?? 'release/win-unpacked/龙娘桌宠.exe');
const appVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const expectedKind = argument('--expected-skin-kind') ?? 'frames'; assert(['frames', 'rig'].includes(expectedKind));
const expectedManifestPath = argument('--skin-manifest') ?? (expectedKind === 'frames' ? 'assets/skins/silver-dragon-frames/skin.json' : 'assets/skins/silver-dragon-rig/skin.json');
const expectedManifest = expectedManifestPath ? JSON.parse(await readFile(path.resolve(expectedManifestPath), 'utf8')) : null;
const expectedSkinName = argument('--expected-skin-name') ?? expectedManifest?.name ?? (expectedKind === 'frames' ? '银白龙娘 · 逐帧' : '银白龙娘 · 连续动画');
const countFrames = animation => animation?.atlas?.indices?.length ?? animation?.frames?.length ?? 0;
if (expectedManifest && expectedKind === 'frames') { assert(!expectedManifest.rig); for (const action of ['idle', 'thinking']) assert.equal(countFrames(expectedManifest.animations[action]), 24, `${action} has 24 playback frames; repeated sources are allowed`); }
const resources = path.join(path.dirname(executable), 'resources');
for (const helper of ['raw-mouse.exe', 'desktop-chat.exe']) await stat(path.join(resources, 'app.asar.unpacked/dist/native', helper));
const dataDir = path.resolve('.local/package-check-' + Date.now());
await mkdir(dataDir, { recursive: true });
const env = { ...process.env, DRAGON_PET_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['--smoke-test'], { env, stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => child.kill(), 20000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
clearTimeout(timer); assert.equal(code, 0, 'packaged app starts and exits cleanly');
const startup = JSON.parse(await readFile(path.join(dataDir, 'smoke-result.json'), 'utf8'));
assert.equal(startup.ok, true); assert.equal(startup.windows, 2); assert.equal(startup.bridge, 'function');
assert.equal(startup.skinMissing, false); assert.equal(startup.spriteLoaded, true); assert(startup.skinName?.trim());
if (expectedSkinName) assert.equal(startup.skinName, expectedSkinName);
assert.equal(startup.version, appVersion);
assert.equal(startup.skinKind, expectedKind);
if (expectedKind === 'frames') {
  for (const action of ['idle', 'thinking']) assert.equal(startup.animationFrameCounts?.[action], 24, `Packaged ${action} must expose 24 playback frames, including repeated holds`);
  if (expectedSkinName === '银白龙娘 · 逐帧') assert.equal(startup.roamingAnimation, null, 'No approved roaming animation: the new default must not slide an idle image around');
} else {
  assert.deepEqual([...startup.rigViews].sort(), ['front', 'left', 'right']);
  assert(startup.rigLayers.every(count => count >= 16), 'Each direction uses the fixed, independently driven body parts');
}
assert.equal(startup.bubbleMode, 'hidden', 'Startup only displays the pet');
const cli = path.join(resources, 'app.asar.unpacked/node_modules/@playwright/mcp/cli.js');
await stat(cli);
const transport = new StdioClientTransport({ command: executable, args: [cli, '--extension', '--codegen', 'none'], env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' });
const client = new Client({ name: 'dragon-pet-package-check', version: appVersion }, { capabilities: {} });
try {
  await client.connect(transport);
  const response = await client.listTools();
  assert.ok(response.tools.some(t => t.name === 'browser_snapshot'));
  assert.ok(response.tools.some(t => t.name === 'browser_click'));
  const result = { packagedStartup: startup, expectedSkin: { kind: expectedKind, name: expectedSkinName, manifest: expectedManifestPath }, packagedBrowserTools: response.tools.length, noBrowserOpened: true, executable, backend: null };
  if (checkBackend) {
    const probe = path.join(resources, 'app.asar/dist/main/backend-probe.cjs');
    const args = [probe, '--codex-home', codexHome];
    if (process.argv.includes('--expect-signed-in')) args.push('--expect-signed-in');
    if (withTurn) args.push('--turn');
    for (const flag of ['--model', '--timeout-ms']) { const value = argument(flag); if (value !== null) args.push(flag, value); }
    const turnTimeout = Number(argument('--timeout-ms') ?? 180000);
    if (!Number.isFinite(turnTimeout) || turnTimeout < 1000 || turnTimeout > 300000) throw new Error('Invalid --timeout-ms.');
    let stdout = '', stderr = '';
    const backendChild = spawn(executable, args, { cwd: process.cwd(), windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    backendChild.stdout.setEncoding('utf8'); backendChild.stderr.setEncoding('utf8');
    backendChild.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-32768); process.stdout.write(chunk); });
    backendChild.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); process.stderr.write(chunk); });
    let expired = false;
    const backendTimer = setTimeout(() => { expired = true; backendChild.kill(); }, withTurn ? turnTimeout + 60000 : 60000);
    let backendCode;
    try { backendCode = await new Promise((resolve, reject) => { backendChild.once('error', reject); backendChild.once('exit', resolve); }); }
    finally { clearTimeout(backendTimer); }
    if (expired) throw new Error('Packaged backend probe timed out.');
    assert.equal(backendCode, 0, `Packaged backend failed: ${stderr || 'see output above'}`);
    const summary = stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).findLast(value => value?.ok === true && value?.codexHome);
    assert(summary, 'Packaged backend did not return a successful summary.');
    assert.equal(summary.authFlowsStarted, 0); assert.equal(summary.globalConfigUnchanged, true); assert.equal(summary.maxConcurrentBackends, 1); assert.equal(summary.crashRecovery, true);
    if (withTurn) { assert.equal(summary.inferenceTurns, 1); assert(summary.questions > 0); assert(summary.approvals > 0); assert.equal(summary.streamed, true); }
    else assert.equal(summary.inferenceTurns, 0);
    result.backend = summary;
  }
  await writeFile(path.join(dataDir, 'package-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidenceFile: path.join(dataDir, 'package-verification.json') }));
} finally { await client.close(); }
