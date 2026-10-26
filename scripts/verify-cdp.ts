import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserTools } from '../src/main/tools/browser';

async function main() {
  const directory = await mkdtemp(path.resolve('.local/cdp-060-'));
  let submits = 0, cookieSeen = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/submit') submits++;
    if (req.headers.cookie?.includes('dragonTest=present')) cookieSeen = true;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/login') res.setHeader('Set-Cookie', 'dragonTest=present; Max-Age=3600; SameSite=Lax; Path=/');
    res.end('<!doctype html><title>桌宠独立浏览器验收</title><h1>本机测试页面</h1><form action="/submit"><label>名称<input name="name"></label><button type="submit">提交测试</button></form><a href="/login">保存测试登录</a><p style="height:1800px">滚动区域</p>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const approvals: string[] = [];
  const config = { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', userDataDir: path.join(directory, 'browser-profile'), profileDirectory: 'Default' };
  const browser = new BrowserTools({ getGrant: () => ({ folders: [], origins: [origin], browserInput: true }), requestApproval: async input => { approvals.push(input.title); return false; }, onBrowserChange: () => {} }, { getConfig: async () => config });
  try {
    let page: any = await browser.call('pet_browser_navigate', { url: origin });
    const ref = (role: string, text: string) => page.untrustedPageContent.split('\n').find((line: string) => line.startsWith('- ' + role) && line.includes(text))?.match(/\[ref=(e\d+)\]/)?.[1];
    page = await browser.call('pet_browser_type', { revision: page.revision, ref: ref('textbox','名称'), text: '中文输入验收' });
    assert.match(page.untrustedPageContent, /中文输入验收/);
    await assert.rejects(browser.call('pet_browser_click', { revision: page.revision, ref: ref('button','提交测试') }), /拒绝/);
    assert.equal(submits, 0); assert.equal(approvals.length, 1);
    page = await browser.call('pet_browser_snapshot', {});
    const previous = { revision: page.revision, ref: ref('textbox','名称') };
    page = await browser.call('pet_browser_click', { revision: page.revision, ref: ref('link','保存测试登录') });
    assert.equal(page.url, origin + '/login', 'Link click navigates to the login fixture.');
    assert.equal(approvals.length, 1, 'Normal in-scope links need no approval.');
    await browser.call('pet_browser_scroll', { deltaY: 500 });
    const screenshot: any = await browser.call('pet_browser_screenshot', {});
    await writeFile(path.join(directory, 'browser.png'), Buffer.from(screenshot.screenshot.data, 'base64'));
    await browser.disconnect(); cookieSeen = false;
    await browser.call('pet_browser_navigate', { url: origin });
    assert.equal(cookieSeen, true, 'Persistent profile retains login cookie across restart.');
    await assert.rejects(browser.call('pet_browser_type', { ...previous, text: '过期操作' }), /过期/);
    await assert.rejects(browser.call('pet_browser_navigate', { url: 'https://example.com' }), /拒绝/);
    assert.equal(submits, 0);
    await writeFile(path.join(directory,'result.json'), JSON.stringify({ ok: true, extensionRequired: false, pipeOnly: true, cookiePersisted: cookieSeen, deniedSubmitCount: submits, checks: ['Chinese input', 'in-scope link', 'submit denial', 'screenshot', 'scroll', 'reconnect', 'stale reference', 'outside-origin denial'] }, null, 2));
    console.log(directory);
  } finally { await browser.dispose(); server.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
