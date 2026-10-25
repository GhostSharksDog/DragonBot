import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolHost } from '../src/main/tools';
test('assistant can discover the exact task scope, and stopped tasks cannot read it', async () => {
  let task: string | null = 'turn-current';
  const grant = { folders: ['E:\\Projects\\example'], origins: ['https://example.com'], browserInput: true };
  const host = new ToolHost({ getGrant: () => grant, getTaskId: () => task, requestApproval: async () => false, onBrowserChange: () => {} });
  try {
    const result = await host.call('pet_task_scope', {});
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse((result.contentItems[0] as { text: string }).text), grant);
    task = null;
    assert.equal((await host.call('pet_task_scope', {})).success, false);
  } finally { await host.dispose(); }
});
