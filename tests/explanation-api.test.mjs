import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

const env = {
  XINRUI_SESSION_ID: "test-session",
  XINRUI_UID: "370397",
  XINRUI_VERSION: "1.0.0",
  XINRUI_BASE_URL: "https://example.test",
};

const request = (body) => new Request("https://site.test/api/explain", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("explanation API returns a real upstream explanation", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, init) => {
    upstreamBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ rcode: "0000", content: "15–17点，均衡牌型", isalert: "Y" }));
  };
  try {
    const response = await worker.fetch(request({ sequence: "1N", system: "CBB", dealer: "N", vul: "None", teammode: 0 }), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "found", explanation: "15–17点，均衡牌型", isAlert: true, source: "upstream" });
    assert.equal(upstreamBody.bidsystem, "CBB,CBB");
    assert.equal(upstreamBody.sessionid, "test-session");
  } finally { globalThis.fetch = originalFetch; }
});

test("explanation API rejects an invalid call before contacting upstream", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(); };
  try {
    const response = await worker.fetch(request({ sequence: "1Z", system: "CBB", dealer: "N", vul: "None", teammode: 0 }), env, {});
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("explanation API does not expose upstream errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("private upstream detail"); };
  try {
    const response = await worker.fetch(request({ sequence: "1C", system: "JQA", dealer: "E", vul: "NS", teammode: 1 }), env, {});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable", message: "说明服务暂时不可用，请稍后重试。" });
  } finally { globalThis.fetch = originalFetch; }
});

function cacheDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sql.includes('active_generation_id') ? { active_generation_id: null } : null; },
        async all() {
          if (!sql.includes('explanation_cache')) return { results: [] };
          const keys = JSON.parse(args[0]);
          return { results: keys.map((key) => rows.get(key)).filter(Boolean) };
        },
        async run() {
          if (sql.includes('INTO explanation_cache')) rows.set(args[0], { cache_key: args[0], explanation: args[1], is_alert: args[2], expires_at: args[3] });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

test("successful upstream explanations are cached for six hours", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ rcode: "0000", content: "缓存说明", isalert: "N" }));
  };
  try {
    const DB = cacheDb();
    const cachedEnv = { ...env, DB };
    const input = { sequence: "1N", system: "CBB", dealer: "N", vul: "None", teammode: 0 };
    const first = await worker.fetch(request(input), cachedEnv, {});
    assert.equal((await first.json()).source, "upstream");
    const second = await worker.fetch(request(input), cachedEnv, {});
    const secondBody = await second.json();
    assert.equal(secondBody.source, "cache");
    assert.equal(secondBody.explanation, "缓存说明");
    assert.equal(upstreamCalls, 1);
    assert.equal(DB.rows.size, 1);
  } finally { globalThis.fetch = originalFetch; }
});
