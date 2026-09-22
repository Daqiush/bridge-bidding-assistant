import test from 'node:test';
import assert from 'node:assert/strict';
import { nextImportAction } from '../worker/dataset/refresh.js';

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
