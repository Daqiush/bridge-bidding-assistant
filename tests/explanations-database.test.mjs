import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

function dbWithRule() {
  return { prepare(sql) { return {
    bind() { return this; },
    async run() { return { meta: { changes: 1 } }; },
    async first() { return sql.includes('active_generation_id') ? { active_generation_id: 'g1' } : null; },
    async all() { return sql.includes('bidding_rules') ? { results: [{ sequence: '1C', explanation: '真实数据库说明', is_alert: 1 }] } : { results: [] }; },
  }; } };
}

test('batch explanation uses the active D1 generation without upstream fetch', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw new Error('must not call upstream'); };
  try {
    const request = new Request('https://site.test/api/explanations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequences: ['1C'], system: 'CBB', dealer: 'N', vul: 'None', teammode: 0 }) });
    const response = await worker.fetch(request, { DB: dbWithRule() }, { waitUntil() {} });
    const body = await response.json();
    assert.equal(body.results['1C'].explanation, '真实数据库说明');
    assert.equal(body.results['1C'].source, 'dataset');
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('batch explanation uses a completed system from an initializing generation', async () => {
  const calls = [];
  const DB = { prepare(sql) { return {
    bind(...values) { calls.push({ sql, values }); return this; },
    async run() { return { meta: { changes: 1 } }; },
    async first() { return sql.includes('dataset_imports') ? { generation_id: 'g-cbb-ready' } : null; },
    async all() { return sql.includes('bidding_rules') ? { results: [{ sequence: '1C', explanation: '已独立启用', is_alert: 0 }] } : { results: [] }; },
  }; } };
  const request = new Request('https://site.test/api/explanations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequences: ['1C'], system: 'CBB', dealer: 'N', vul: 'None', teammode: 0 }) });
  const response = await worker.fetch(request, { DB }, { waitUntil() {} });
  const body = await response.json();
  assert.equal(body.results['1C'].explanation, '已独立启用');
  assert.ok(calls.some((call) => call.sql.includes('bidding_rules') && call.values[0] === 'g-cbb-ready'));
});

test('batch explanation returns cached results immediately and leaves unresolved calls pending', async () => {
  const DB = { prepare(sql) { return {
    bind(...values) { this.values = values; return this; },
    async run() { return { meta: { changes: 1 } }; },
    async first() { return sql.includes('active_generation_id') ? { active_generation_id: null } : null; },
    async all() {
      if (!sql.includes('explanation_cache')) return { results: [] };
      const [firstKey] = JSON.parse(this.values[0]);
      return { results: [{ cache_key: firstKey, explanation: '已缓存说明', is_alert: 0 }] };
    },
  }; } };
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw new Error('must not fetch upstream in a batch'); };
  try {
    const request = new Request('https://site.test/api/explanations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequences: ['1C', '1D'], system: 'CBB', dealer: 'N', vul: 'None', teammode: 0 }) });
    const response = await worker.fetch(request, { DB }, { waitUntil() {} });
    const body = await response.json();
    assert.equal(body.results['1C'].explanation, '已缓存说明');
    assert.deepEqual(body.pending, ['1D']);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
