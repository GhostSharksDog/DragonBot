import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Inspect alpha geometry only. Generated PNG pixels are never changed or re-encoded.
const files = ['atlas-front-v2.png', 'atlas-expressions-v2.png', 'atlas-motion-v2.png'];
const cuts = [[0, 316, 632, 945, 1254], [0, 316, 629, 939, 1254], [0, 341, 633, 960, 1254]];
const directory = path.resolve('assets/skins/silver-dragon');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  const reports = {};
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex], bytes = await fs.readFile(path.join(directory, file));
    const result = await page.evaluate(async ({ url, rows }) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const regions = [];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        const motionCuts = [[0, 315, 627, 942, 1254], [0, 319, 635, 950, 1254], [0, 346, 661, 971, 1254], [0, 325, 636, 950, 1254]];
        const columnCuts = rows[1] === 341 ? motionCuts[row] : [0, 314, 628, 942, 1254];
        const x0 = columnCuts[col], x1 = columnCuts[col + 1], y0 = rows[row], y1 = rows[row + 1];
        const w = x1 - x0, h = y1 - y0, seen = new Uint8Array(w * h), groups = [];
        for (let p = 0; p < seen.length; p++) {
          if (seen[p]) continue;
          seen[p] = 1;
          if (data[((y0 + Math.floor(p / w)) * image.width + x0 + p % w) * 4 + 3] < 96) continue;
          const queue = [p]; let head = 0, minX = w, minY = h, maxX = 0, maxY = 0;
          while (head < queue.length) {
            const next = queue[head++], x = next % w, y = Math.floor(next / w);
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const index = ny * w + nx;
              if (seen[index]) continue;
              seen[index] = 1;
              if (data[((y0 + ny) * image.width + x0 + nx) * 4 + 3] >= 96) queue.push(index);
            }
          }
          groups.push({ count: queue.length, minX, minY, maxX, maxY });
        }
        groups.sort((a, b) => b.count - a.count);
        const substantial = groups.filter(g => g.count >= Math.max(120, groups[0].count * .008));
        const left = Math.max(0, Math.min(...substantial.map(g => g.minX)) - 2), top = Math.max(0, Math.min(...substantial.map(g => g.minY)) - 2);
        const right = Math.min(w, Math.max(...substantial.map(g => g.maxX)) + 3), bottom = Math.min(h, Math.max(...substantial.map(g => g.maxY)) + 3);
        regions.push({ x: x0 + left, y: y0 + top, width: right - left, height: bottom - top });
      }
      let empty = 0; for (let i = 3; i < data.length; i += 4) if (data[i] === 0) empty++;
      return { sourceWidth: image.width, sourceHeight: image.height, transparentFraction: empty / (image.width * image.height), regions };
    }, { url: 'data:image/png;base64,' + bytes.toString('base64'), rows: cuts[fileIndex] });
    reports[file] = result;
    console.log(file, JSON.stringify({ width: result.sourceWidth, height: result.sourceHeight, transparentFraction: result.transparentFraction, regions: result.regions }));
  }
  await fs.writeFile('docs/imagegen/atlas-geometry.json', JSON.stringify(reports, null, 2));
} finally { await browser.close(); }
