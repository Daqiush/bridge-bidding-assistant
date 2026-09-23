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

test('page uses the requested concise Chinese status labels', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /副号/);
  assert.match(html, /正在查询…/);
  assert.doesNotMatch(html, /副数/);
  assert.doesNotMatch(html, /正在查询真实解释说明…/);
});

test('opponent auto-pass can append a pass without changing single-call undo', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /id="autoPass"/);
  assert.match(html, /if\(\$\('autoPass'\)\.checked&&b!=='P'\)bids\.push\('P'\)/);
  assert.match(html, /\$\('undo'\)\.onclick=\(\)=>\{bids\.pop\(\);render\(\)\}/);
});

test('calls use suit colors, display order, and a wrapped sequence trace', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /suit-C/);
  assert.match(html, /suit-D/);
  assert.match(html, /suit-H/);
  assert.match(html, /suit-S/);
  assert.match(html, /displaySuits=\['N','S','H','D','C'\]/);
  assert.match(html, /row\.slice\(1\)\.reverse\(\),row\[0\]/);
  assert.match(html, /trace\.id='sequenceTrace'/);
  assert.match(html, /bids\.slice\(i,i\+4\)/);
  assert.match(html, /groups\.join\(String\.fromCharCode\(10\)\)/);
  assert.match(html, /join\(String\.fromCharCode\(9\)\)/);
  assert.match(html, /activeSequence/);
  assert.match(html, /loadExplain=async sequence/);
  assert.match(html, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\) 40px/);
  assert.match(html, /suit-N\{color:#e7a6df !important\}/);
  assert.match(html, /#nextList strong/);
});

test('copy reports success and clipboard import restores calls', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /读取叫牌序列/);
  assert.match(html, /已复制/);
  assert.match(html, /navigator\.clipboard\.readText\(\)/);
  assert.match(html, /bids=parsed/);
});

test('next-step alert badges are blue', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /\.next \.alert-badge\{color:#1677ff\}/);
});

test('desktop next-step list is shortened while mobile remains unbounded', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {}, { waitUntil() {} });
  const html = await response.text();
  assert.match(html, /\.next\{display:grid;gap:9px;max-height:430px/);
  assert.match(html, /@media\(max-width:800px\)\{\.layout\{grid-template-columns:1fr\}\.next\{max-height:none\}\}/);
});
