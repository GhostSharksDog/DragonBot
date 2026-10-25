import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { QuickOutsideClickMonitor, parseMouseHelperLine, rawMouseHelperPath, shouldDismissQuickClick } from '../src/main/quick-outside-click';

class HelperProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kills = 0;
  kill() { ++this.kills; return true; }
  ready() { this.stdout.write('{"type":"ready"}\n'); }
  down(x = 12, y = -45) { this.stdout.write(`{"type":"mouse-down","button":"left","x":${x},"y":${y}}\n`); }
  process() { return this as unknown as ChildProcessWithoutNullStreams; }
}

test('only valid button-down packets leave the process boundary; movement and key packets are ignored', () => {
  assert.deepEqual(parseMouseHelperLine('{"type":"mouse-down","button":"left","x":-1200,"y":900}'), { type: 'mouse-down', button: 'left', x: -1200, y: 900 });
  for (const line of ['', 'broken', 'null', '{"type":"mouse-move","button":"left","x":0,"y":0}', '{"type":"key-down","button":"left","x":0,"y":0}', '{"type":"mouse-down","button":"left","x":0.5,"y":0}', '{"type":"mouse-down","button":"keyboard","x":0,"y":0}', '{"type":"mouse-down","button":"left","x":2147483648,"y":0}']) assert.equal(parseMouseHelperLine(line), null);
});

test('helper exists only while quick is visible; repeated resize/show does not create another process', () => {
  const processes: HelperProcess[] = [];
  const events: unknown[] = [];
  const failures: string[] = [];
  const monitor = new QuickOutsideClickMonitor({ helperPath: 'helper.exe', platform: 'win32', launch: () => { const child = new HelperProcess(); processes.push(child); return child.process(); }, onMouseDown: event => events.push(event), onUnavailable: message => failures.push(message) });
  monitor.setQuickVisible(false);
  assert.equal(processes.length, 0);
  monitor.setQuickVisible(true);
  monitor.setQuickVisible(true);
  assert.equal(processes.length, 1);
  processes[0].down();
  assert.equal(events.length, 0, 'no packets before handshake');
  processes[0].ready();
  assert.equal(monitor.isMonitoring, true);
  processes[0].down();
  assert.deepEqual(events, [{ button: 'left', x: 12, y: -45 }]);
  monitor.setQuickVisible(false);
  assert.equal(monitor.isMonitoring, false);
  assert.equal(processes[0].kills, 1);
  assert.equal(processes[0].stdin.writableEnded, true);
  processes[0].down();
  processes[0].emit('exit', 0);
  assert.equal(events.length, 1);
  assert.deepEqual(failures, []);
  monitor.setQuickVisible(true);
  assert.equal(processes.length, 2, 'show starts a fresh registration');
  processes[0].ready();
  assert.equal(monitor.isMonitoring, false, 'old helper cannot mark replacement ready');
  processes[1].ready();
  monitor.dispose();
  monitor.setQuickVisible(true);
  assert.equal(processes.length, 2);
  assert.equal(processes[1].kills, 1);
});

test('quick external double click dismisses once; pet and bubble double clicks never trigger dismissal', () => {
  const child = new HelperProcess();
  let mode: 'quick' | 'hidden' = 'quick';
  let target: 'pet' | 'bubble' | 'outside' = 'pet';
  let dismissed = 0;
  const monitor = new QuickOutsideClickMonitor({ helperPath: 'helper.exe', platform: 'win32', launch: () => child.process(), onUnavailable: () => assert.fail('unexpected failure'), onMouseDown: () => { if (shouldDismissQuickClick(mode, target)) { ++dismissed; mode = 'hidden'; monitor.setQuickVisible(false); } } });
  monitor.setQuickVisible(true); child.ready();
  child.down(); child.down();
  assert.equal(dismissed, 0, 'pet handles its own toggle without native blur hide/reopen');
  target = 'bubble'; child.down(); child.down();
  assert.equal(dismissed, 0);
  target = 'outside';
  child.stdout.write('{"type":"mouse-down","button":"left","x":1,"y":2}\n{"type":"mouse-down","button":"left","x":1,"y":2}\n');
  assert.equal(dismissed, 1, 'queued second click cannot fire after hiding');
  for (const hiddenMode of ['hidden', 'panel'] as const) assert.equal(shouldDismissQuickClick(hiddenMode, 'outside'), false);
  monitor.dispose();
});

test('split lines preserve negative physical coordinates and errors fall back once without retries', () => {
  const child = new HelperProcess();
  const events: unknown[] = [], failures: string[] = [];
  let launches = 0;
  const monitor = new QuickOutsideClickMonitor({ helperPath: 'helper.exe', platform: 'win32', launch: () => { ++launches; return child.process(); }, onMouseDown: event => events.push(event), onUnavailable: message => failures.push(message) });
  monitor.setQuickVisible(true);
  child.stdout.write('{"type":"rea'); child.stdout.write('dy"}\n{"type":"mouse-down","button":"right","x":-4096,'); child.stdout.write('"y":-1200}\n');
  assert.deepEqual(events, [{ button: 'right', x: -4096, y: -1200 }]);
  child.emit('error', new Error('sensitive-local-path'));
  child.emit('exit', 1);
  child.down();
  assert.equal(failures.length, 1);
  assert.ok(!failures[0].includes('sensitive-local-path'));
  assert.equal(launches, 1);
  assert.equal(events.length, 1);
  assert.equal(monitor.isMonitoring, false);
  monitor.dispose();
});

test('startup timeout and missing executable use fallback; packaged helper uses unpacked path', async () => {
  const child = new HelperProcess();
  const failures: string[] = [];
  const monitor = new QuickOutsideClickMonitor({ helperPath: 'helper.exe', platform: 'win32', startupTimeoutMs: 5, launch: () => child.process(), onMouseDown: () => assert.fail('not ready'), onUnavailable: message => failures.push(message) });
  monitor.setQuickVisible(true);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(failures.length, 1);
  assert.equal(child.kills, 1);
  monitor.dispose();
  const absent = new QuickOutsideClickMonitor({ helperPath: 'missing.exe', platform: 'win32', launch: () => { throw new Error('ENOENT'); }, onMouseDown: () => {}, onUnavailable: message => failures.push(message) });
  absent.setQuickVisible(true); absent.dispose();
  assert.equal(failures.length, 2);
  assert.match(rawMouseHelperPath('C:\\app\\resources\\app.asar'), /app\.asar\.unpacked[\\/]dist[\\/]native[\\/]raw-mouse\.exe$/);
  assert.match(rawMouseHelperPath('E:\\Projects\\dragon-pet'), /dragon-pet[\\/]dist[\\/]native[\\/]raw-mouse\.exe$/);
});
