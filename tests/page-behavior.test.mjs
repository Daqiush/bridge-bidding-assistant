import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

test('suggestions prefetch real explanations and commit the clicked bid', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /fetch\('\/api\/explanations'/);
  assert.match(html, /onclick=\(\)=>add\(e\.dataset\.next\)/);
  assert.doesNotMatch(html, /<small>'\+explain\(b,bids\.length\+1\)/);
});

test('prefetched explanations are reused for suggestion and history clicks', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /const explanationCache=new Map\(\)/);
  assert.match(html, /function rememberExplanation\(/);
  assert.match(html, /const cached=explanationCache\.get\(/);
  assert.match(html, /data\.results\?\.\[item\.sequence\]/);
  assert.match(html, /for\(const sequence of data\.pending\|\|\[\]\)/);
  assert.match(html, /rememberExplanation\(context,sequence,result\)/);
});

test('page renders the required attribution and accessible alert badge', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /<footer>北京析构整环桥牌俱乐部出品<\/footer>/);
  assert.match(html, /<strong class="alert-badge" aria-label="ALERT">🅰︎<\/strong>/);
});
