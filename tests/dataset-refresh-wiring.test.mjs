import test from 'node:test';
import assert from 'node:assert/strict';
import { nextImportAction, nextImportWindow } from '../worker/dataset/refresh.js';

test('refresh advances incomplete systems before activating a generation', () => {
  assert.deepEqual(nextImportAction([
    { system: 'JQA', stage: 'complete' },
    { system: 'CBB', stage: 'import_chunks' },
  ]), { type: 'import', system: 'CBB', stage: 'import_chunks' });
  assert.deepEqual(nextImportAction([
    { system: 'JQA', stage: 'complete' },
    { system: 'CBB', stage: 'complete' },
    { system: 'NBS', stage: 'complete' },
    { system: 'ASY', stage: 'complete' },
  ]), { type: 'activate' });
});

test('imports a bounded 2000-line window without passing EOF', () => {
  assert.deepEqual(nextImportWindow(350, 5000), { start: 350, end: 2350 });
  assert.deepEqual(nextImportWindow(4500, 5000), { start: 4500, end: 5000 });
});
