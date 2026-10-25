import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickBubbleShape, quickBubbleHit } from '../src/shared/bubble-shape';

test('ellipse corners pass through while the full content and the projecting tail remain clickable', () => {
  for (const [width, height] of [[320, 180], [320, 360], [224, 244]]) for (const headX of [-90, width + 90]) {
    const shape = createQuickBubbleShape(width, height, { x: headX, y: height - 44 });
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [-20, height / 2]]) assert.equal(quickBubbleHit(shape, x, y), false);
    const content = shape.content;
    for (const x of [content.x, content.x + content.width]) for (const y of [content.y, content.y + content.height]) assert(quickBubbleHit(shape, x, y), 'Text/buttons must fit inside the visible ellipse');
    const [a, tip, b] = shape.tail;
    assert(quickBubbleHit(shape, (a.x + tip.x + b.x) / 3, (a.y + tip.y + b.y) / 3), 'A click on the tail must stay in the bubble');
    assert.equal(tip.x < width / 2, headX < 0, 'Tail follows the character when placement changes side');
    assert.equal(quickBubbleHit(shape, Number.NaN, 10), false);
  }
});
