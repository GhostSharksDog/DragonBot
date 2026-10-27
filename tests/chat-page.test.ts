import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { readChatPage, isChatUrl } from '../src/main/chat/page';
test('accepts the new-conversation URL used by ChatGPT without accepting auth or other hosts',()=>{
  assert(isChatUrl('https://chatgpt.com/c/local-chatgpt%3A9e9a59c5-b4ac-46ad-8294-0b593481b4d8'));
  assert(isChatUrl('https://chatgpt.com/c/local-chatgpt:9e9a59c5-b4ac-46ad-8294-0b593481b4d8'));
  assert(!isChatUrl('https://chatgpt.com/auth/login'));assert(!isChatUrl('https://example.com/c/test'));
});
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('Chat DOM reader preserves paragraph text, identifies high and message IDs, rejects auth pages', {skip:!existsSync(chrome)},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<button aria-label="打开个人资料菜单"></button><button aria-pressed="true">聊天</button><button aria-pressed="false">工作</button><button data-composer-navigation-target="reasoning" data-selected-reasoning-effort="high">High</button><div contenteditable="true" role="textbox"><p>第一段</p><p><br class="ProseMirror-trailingBreak"></p><p>第三段</p></div><div data-chatgpt-conversation-selection-target="fixture"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="user-id"><div data-user-message-bubble>测试消息</div></div><div data-chatgpt-search-unit-key="turn:1:assistant" data-chatgpt-search-message-ids="assistant-id assistant-id"><div data-markdown-text-style="assistant-message">测试回复</div></div></div></div>`}));
    await page.goto('https://chatgpt.com/c/fixture');
    const expression=`(() => {const __name=value=>value;return (${readChatPage.toString()})();})()`;
    const state=await page.evaluate(expression) as ReturnType<typeof readChatPage>;
    assert.equal(state.draft,'第一段\n\n第三段');assert.equal(state.mode,'chat');assert.equal(state.effort,'high');assert.equal(state.loggedIn,true);
    assert.deepEqual(state.messages.map(m=>[m.id,m.role,m.text,m.complete]),[['user-id','user','测试消息',true],['assistant-id','assistant','测试回复',true]]);
    await page.goto('https://accounts.google.com/login?secret=not-read');
    const auth=await page.evaluate(expression) as ReturnType<typeof readChatPage>;
    assert.equal(auth.loggedIn,false);assert.equal(auth.draft,'');assert.deepEqual(auth.messages,[]);assert(!auth.url.includes('secret'));
  }finally{await browser.close();}
});
