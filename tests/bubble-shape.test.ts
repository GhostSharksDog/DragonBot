import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickBubbleShape, quickBubbleHit } from '../src/shared/bubble-shape';
import { petChatLauncherRect, pointInRoundedRect } from '../src/shared/pet-chat-launcher';

test('rounded rectangle corners pass through while content and the projecting tail remain clickable', () => {
  for (const [width, height] of [[320, 88], [320, 180], [320, 360], [224, 244], [80, 80]]) for (const headX of [-90, width + 90]) {
    const shape = createQuickBubbleShape(width, height, { x: headX, y: height - 44 });
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [-20, height / 2]]) assert.equal(quickBubbleHit(shape, x, y), false);
    const content = shape.content;
    for (const x of [content.x, content.x + content.width]) for (const y of [content.y, content.y + content.height]) assert(quickBubbleHit(shape, x, y), 'Text/buttons must fit inside the visible body');
    assert(!quickBubbleHit(shape, shape.body.x, shape.body.y));
    assert(quickBubbleHit(shape, shape.body.x + shape.body.radius, shape.body.y));
    const [a, tip, b] = shape.tail;
    assert(quickBubbleHit(shape, (a.x + tip.x + b.x) / 3, (a.y + tip.y + b.y) / 3), 'A click on the tail must stay in the bubble');
    assert.equal(tip.x < width / 2, headX < 0, 'Tail follows the character when placement changes side');
    assert.equal(quickBubbleHit(shape, Number.NaN, 10), false);
  }
});

test('chat launcher remains clickable and inside the pet window across supported scales', () => {
  for (const scale of [.65, 1, 1.6]) {
    const width = Math.round(200 * scale), height = Math.round(240 * scale);
    const rect = petChatLauncherRect(width, height);
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height);
    assert(pointInRoundedRect(rect, rect.x + rect.width / 2, rect.y + rect.height / 2));
    assert(!pointInRoundedRect(rect, rect.x, rect.y));
    assert(!pointInRoundedRect(rect, rect.x - 1, rect.y + 12));
  }
});
