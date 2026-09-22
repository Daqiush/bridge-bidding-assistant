import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatasetText } from '../worker/dataset/parser.js';

test('parses the first valid rule for each normalized sequence', () => {
  const rows = parseDatasetText('1c#CBB#自然开叫#Y\n1C#CBB#重复说明#\nP#CBB#不叫#\n', 'CBB');
  assert.deepEqual(rows, [
    { sequence: '1C', system: 'CBB', explanation: '自然开叫', hasExplanation: 1, isAlert: 1, sourceOrder: 1 },
    { sequence: 'P', system: 'CBB', explanation: '不叫', hasExplanation: 1, isAlert: 0, sourceOrder: 3 },
  ]);
});
