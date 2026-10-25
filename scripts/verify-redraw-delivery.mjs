import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { inspectAnimatedWebp, inspectGif } from './export-redraw-sequences.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const directory = path.resolve(argument('--dir') ?? path.join(project, 'release/animation-redraw-v1'));
const ffmpeg = argument('--ffmpeg') ?? 'E:/Apps/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const contains = (base, target) => { const value = path.relative(base, target); return value === '' || value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value); };
const resolveEntry = name => { assert(typeof name === 'string' && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..')); const result = path.resolve(directory, name); assert(contains(directory, result)); return result; };
assert(contains(await fs.realpath(project), await fs.realpath(directory)));
await fs.mkdir(path.join(project, '.local'), { recursive: true });
const explicitReport = argument('--report') ? path.resolve(argument('--report')) : null;
if (explicitReport) { assert(contains(path.join(project, 'release'), explicitReport) || contains(path.join(project, '.local'), explicitReport)); assert(!contains(directory, explicitReport), 'Final archive evidence must stay outside the package to avoid self-reference.'); }
const evidenceDirectory = explicitReport ? null : await fs.mkdtemp(path.join(project, '.local/redraw-delivery-check-'));
const report = { ok: false, deliveryState: 'review-candidate', geometryFormatPassed: false, gaitStrictlyPassed: false, thinkingSourceFrames: 20, thinkingHoldFrames: 4, directory, sources: [], animations: [], pngCount: 0, archive: null, errors: [] };

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(bytes.toString('ascii', 12, 16), 'IHDR'); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}
async function decodeFrames(input, gif = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...(gif ? ['-ignore_loop', '1'] : ['-framerate', '12', '-start_number', '1']), '-i', input, '-frames:v', '24', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let error = ''; child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => { error = (error + data).slice(-2000); }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Image decode (${code}): ${error}`)));
  });
}
async function verifyArchive(file) {
  const zip = await fs.readFile(file); let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0, 'ZIP end directory is missing.'); const count = zip.readUInt16LE(end + 10), size = zip.readUInt32LE(end + 12), offset = zip.readUInt32LE(end + 16); assert.equal(offset + size, end);
  const archived = new Set(); let cursor = offset;
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50); const method = zip.readUInt16LE(cursor + 10), checksum = zip.readUInt32LE(cursor + 16), compressedSize = zip.readUInt32LE(cursor + 20), decodedSize = zip.readUInt32LE(cursor + 24), nameLength = zip.readUInt16LE(cursor + 28), extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32), local = zip.readUInt32LE(cursor + 42), name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert(!archived.has(name), 'Duplicate ZIP filename.'); archived.add(name); assert.equal(zip.readUInt32LE(local), 0x04034b50); const localNameLength = zip.readUInt16LE(local + 26), localExtraLength = zip.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtraLength;
    assert.equal(zip.toString('utf8', local + 30, local + 30 + localNameLength), name); assert.equal(zip.readUInt16LE(local + 8), method); const encoded = zip.subarray(start, start + compressedSize); assert([0, 8].includes(method)); const bytes = method === 0 ? encoded : inflateRawSync(encoded); assert.equal(bytes.length, decodedSize); assert.equal(crc32(bytes), checksum, `ZIP CRC mismatch: ${name}`);
    const original = await fs.readFile(resolveEntry(name)); assert.equal(sha(bytes), sha(original), `ZIP content differs: ${name}`); cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end); const unpacked = [];
  async function walk(root) { for (const entry of await fs.readdir(root, { withFileTypes: true })) { assert(!entry.isSymbolicLink()); const target = path.join(root, entry.name); if (entry.isDirectory()) await walk(target); else if (entry.isFile() && target !== file) unpacked.push(path.relative(directory, target).replaceAll('\\', '/')); } }
  await walk(directory); assert.deepEqual([...archived].sort(), unpacked.sort(), 'ZIP must contain every delivery file except itself.'); return { files: count, bytes: zip.length, sha256: sha(zip), everyEntryCrcVerified: true, everyEntryShaMatchesDirectory: true, containsAllDeliveryFiles: true };
}

try {
  const manifest = JSON.parse(await fs.readFile(resolveEntry('manifest.json'), 'utf8')); assert.equal(manifest.transparencyEncoding.mode, 'preserve-source-alpha'); assert.equal(manifest.sourcePngUnchanged, true); assert.equal(manifest.commonCanvas.width, 272); assert.equal(manifest.commonCanvas.height, 272); assert.equal(manifest.padding, 8);
  try {
    const quality = JSON.parse(await fs.readFile(resolveEntry('quality-status.json'), 'utf8')); assert.equal(quality.status, 'review-candidate'); assert.equal(quality.allRequestedVisualCriteriaAccepted, false); assert.equal(manifest.status, 'review-candidate'); assert.equal(manifest.allRequestedVisualCriteriaAccepted, false); assert.equal(manifest.qualityStatus, 'quality-status.json'); assert.equal(quality.thinking.uniqueSourceFrames, 20); assert.equal(quality.thinking.repeatedHoldFrames, 4); assert.equal(quality.runningLeft.strictGaitAccepted, false); assert.equal(quality.geometryAndFormats.sourcePngUnchanged, true); assert.equal(quality.geometryAndFormats.bodyPartsComposited, false); assert.equal(quality.geometryAndFormats.perFrameShapeScaling, false);
    const required = ['README.md', 'prompts/thinking-v5.json', 'prompts/running-left-v3.json', 'references/appearance-master.png', 'references/thinking-motion-only.png', 'references/thinking-pose-guide.png', 'references/running-left-strong-pose-guide.png']; for (const file of required) assert((await fs.stat(resolveEntry(file))).isFile()); report.qualityStatusMatched = true; report.promptAndReferenceFilesIncluded = required;
  } catch (error) { if (error.code !== 'ENOENT' || await fs.stat(resolveEntry('quality-status.json')).then(() => true, () => false)) throw error; report.qualityStatusMatched = false; }
  const sources = new Map();
  for (const source of manifest.sources) { const bytes = await fs.readFile(resolveEntry(source.savedSource)), hash = sha(bytes); assert.equal(hash, source.sha256); sources.set(source.id, source); report.sources.push({ id: source.id, file: source.savedSource, sha256: hash, dimensions: pngSize(bytes) }); }
  assert.deepEqual(JSON.parse(await fs.readFile(resolveEntry('playback-order.json'), 'utf8')), manifest.playbackOrder); assert.deepEqual(JSON.parse(await fs.readFile(resolveEntry('translations.json'), 'utf8')), manifest.translations); assert.deepEqual(JSON.parse(await fs.readFile(resolveEntry('whole-character-source-rects.json'), 'utf8')), manifest.wholeCharacterSourceRects);
  assert.equal(manifest.translations.sourceSha256, sources.get('thinking').sha256); assert.equal(manifest.wholeCharacterSourceRects.sources['running-left'].sourceSha256, sources.get('running-left').sha256);
  assert.deepEqual(manifest.animations.map(action => action.id), ['thinking', 'running-left', 'running-right']); const rgbaFrames = new Map(); let palette;
  for (const action of manifest.animations) {
    assert.equal(action.frames.length, 24); assert.equal(action.outputMapping.length, 24); const originalId = action.id === 'running-right' ? 'running-left' : action.id, order = manifest.playbackOrder.actions[originalId]?.sourceIndices ?? Array.from({ length: 24 }, (_, index) => index + 1), seen = new Map();
    assert.deepEqual(action.outputMapping.map(frame => frame.sourceFrame), order); assert.equal(new Set(order).size, action.uniqueSourceFrames); let held = 0;
    for (let index = 0; index < 24; index++) {
      const bytes = await fs.readFile(resolveEntry(action.frames[index])), size = pngSize(bytes); assert.equal(size.width, 272); assert.equal(size.height, 272); assert.equal(size.colorType, 6); report.pngCount++;
      const frame = action.outputMapping[index]; assert.equal(frame.outputFrame, index + 1); assert.equal(frame.sourceIndex0, frame.sourceFrame - 1); assert.equal(frame.duplicatedHold, seen.has(frame.sourceFrame));
      if (frame.duplicatedHold) { assert(frame.holdReason?.trim()); assert(bytes.equals(seen.get(frame.sourceFrame)), 'Held source frame must have identical PNG bytes.'); held++; } else seen.set(frame.sourceFrame, bytes);
      const placement = manifest.wholeCharacterSourceRects.sources[originalId]?.frames[frame.sourceIndex0];
      if (placement) { assert.deepEqual(frame.sourceRect, placement.sourceRect); assert.deepEqual(frame.destination, placement.destination); assert.equal(frame.sourceExtraction, 'reviewed-whole-character-rectangle'); } else { assert.equal(frame.sourceExtraction, 'strict-uniform-grid-cell'); const offset = manifest.translations.frames[originalId][frame.sourceIndex0]; assert.deepEqual(frame.sourceRect, { x: frame.sourceIndex0 % 6 * 256, y: Math.floor(frame.sourceIndex0 / 6) * 256, width: 256, height: 256 }); assert.deepEqual(frame.destination, { x: 8 + offset.x, y: 8 + offset.y }); }
      assert.deepEqual(frame.fullCharacterTranslation, { x: frame.destination.x - frame.sourceRect.x, y: frame.destination.y - frame.sourceRect.y }); assert.equal(frame.mirroredAfterPlacement, action.id === 'running-right');
    }
    assert.equal(held, action.duplicateHoldFrames); if (action.id === 'thinking') { assert.equal(action.uniqueSourceFrames, 20); assert.equal(held, 4); assert(!order.includes(15)); } else { assert.equal(action.uniqueSourceFrames, 24); assert.equal(held, 0); }
    const gif = inspectGif(await fs.readFile(resolveEntry(action.gif))), webp = inspectAnimatedWebp(await fs.readFile(resolveEntry(action.webp))), duration = action.id === 'thinking' ? 2000 : 1800;
    assert.equal(gif.width, 272); assert.equal(gif.height, 272); assert.equal(gif.frames.length, 24); assert.equal(gif.frames.reduce((sum, frame) => sum + frame.delay * 10, 0), duration); assert.equal(gif.locals.length, 0); assert.equal(gif.loopCount, 0); assert(gif.frames.every(frame => frame.transparent)); assert.deepEqual(gif.frames.map(frame => frame.delay), action.gifDurationsCs); if (palette) assert.equal(gif.paletteSha256, palette); palette = gif.paletteSha256;
    assert.equal(webp.width, 272); assert.equal(webp.height, 272); assert.equal(webp.frames, 24); assert.equal(webp.totalMs, duration); assert(webp.lossless && webp.alpha); assert.equal(webp.loopCount, 0); assert.deepEqual(webp.durationsMs, action.frameDurationsMs);
    const [pngRgba, gifRgba] = await Promise.all([decodeFrames(path.join(directory, action.id, 'frame-%02d.png')), decodeFrames(resolveEntry(action.gif), true)]); assert.equal(pngRgba.length, 272 * 272 * 4 * 24); assert.equal(gifRgba.length, pngRgba.length); for (let pixel = 3; pixel < pngRgba.length; pixel += 4) assert.equal(gifRgba[pixel], pngRgba[pixel] >= 128 ? 255 : 0, 'GIF transparency/disposal changed.'); rgbaFrames.set(action.id, pngRgba);
    report.animations.push({ id: action.id, playbackFrames: 24, sourceFrames: action.uniqueSourceFrames, duplicatedHoldFrames: held, width: 272, height: 272, gifMs: duration, webpMs: webp.totalMs, sourceRecordsMatched: true, gifDecodedAlphaMatched: true, webpLosslessPayloads: true });
  }
  const left = rgbaFrames.get('running-left'), right = rgbaFrames.get('running-right'); for (let pixel = 0; pixel < left.length; pixel += 4) { const x = pixel / 4 % 272, other = pixel + (271 - 2 * x) * 4; assert(left[pixel] === right[other] && left[pixel + 1] === right[other + 1] && left[pixel + 2] === right[other + 2] && left[pixel + 3] === right[other + 3]); }
  assert.equal(report.pngCount, 72); report.rightRunExactRgbaMirror = true; report.archive = await verifyArchive(resolveEntry('animation-redraw-v1.zip')); report.geometryFormatPassed = true; report.ok = true;
} catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
const result = explicitReport ?? path.join(evidenceDirectory, 'result.json'); await fs.mkdir(path.dirname(result), { recursive: true }); await fs.writeFile(result, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, evidenceFile: result }, null, 2));
