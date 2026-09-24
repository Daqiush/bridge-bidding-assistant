import { downloadBytes } from './download.js';
import { readSystemTxt } from './zip.js';
import { parseDatasetText } from './parser.js';

const SYSTEMS = ['JQA', 'CBB', 'NBS', 'ASY'];
const URL_KEYS = { JQA: 'jqaurl', CBB: 'cbburl', NBS: 'nbsurl', ASY: 'asyurl' };
const SIX_HOURS = 6 * 60 * 60 * 1000;

export function nextImportAction(imports) {
  const next = imports.find((x) => x.stage !== 'complete');
  return next ? { type: 'import', system: next.system, stage: next.stage } : { type: 'activate' };
}
export function nextImportWindow(start, totalLines) {
  return { start, end: Math.min(totalLines, start + 2000) };
}
export function sourceVersionFingerprint(sources) {
  return [...SYSTEMS].sort().map((system) => {
    const path = new URL(sources[system]).pathname;
    const filename = decodeURIComponent(path.split('/').filter(Boolean).at(-1) || '');
    return `${system}:${filename}`;
  }).join('|');
}
export function changedSystems(previousFingerprint, currentFingerprint) {
  if (!previousFingerprint) return [...SYSTEMS];
  const previous = Object.fromEntries(previousFingerprint.split('|').map((part) => {
    const [system, ...version] = part.split(':');
    return [system, version.join(':')];
  }));
  const current = Object.fromEntries(currentFingerprint.split('|').map((part) => {
    const [system, ...version] = part.split(':');
    return [system, version.join(':')];
  }));
  return SYSTEMS.filter((system) => previous[system] !== current[system]);
}
async function getAll(stmt) { const r = await stmt.all(); return r.results || []; }
async function putJson(bucket, key, value) { await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }); }
async function readText(object) { return typeof object.text === 'function' ? object.text() : new TextDecoder().decode(await object.arrayBuffer()); }
async function sourceList(env) {
  const base = String(env.XINRUI_BASE_URL || 'https://www.xinruibridge.com').replace(/\/$/, '');
  const r = await fetch(`${base}/bs/bid/source`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ sessionid: env.XINRUI_SESSION_ID, type: 1, uid: Number(env.XINRUI_UID), version: env.XINRUI_VERSION }) });
  if (!r.ok) throw new Error('source_http');
  const data = await r.json();
  if (data?.rcode !== '0000' || !SYSTEMS.every((s) => typeof data[URL_KEYS[s]] === 'string')) throw new Error('source_payload');
  const sources = Object.fromEntries(SYSTEMS.map((s) => [s, data[URL_KEYS[s]]]));
  return { sources, fingerprint: sourceVersionFingerprint(sources) };
}
async function copyUnchangedSystem(env, generation, activeGeneration, system) {
  await env.DB.prepare(`INSERT INTO bidding_rules (generation_id,system,sequence,explanation,has_explanation,is_alert,source_order)
    SELECT ?1,system,sequence,explanation,has_explanation,is_alert,source_order
    FROM bidding_rules WHERE generation_id=?2 AND system=?3`).bind(generation, activeGeneration, system).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM bidding_rules WHERE generation_id=?1 AND system=?2').bind(generation, system).first();
  if (!count?.n) throw new Error('copy_empty_system');
  await env.DB.prepare("INSERT INTO dataset_imports (generation_id,system,stage,valid_count,final_count) VALUES (?1,?2,'complete',?3,?3)").bind(generation, system, count.n).run();
}
async function createGeneration(env, now, source, systemsToImport, activeGeneration) {
  const id = `g${now}-${crypto.randomUUID().slice(0, 8)}`;
  const { sources, fingerprint } = source;
  await putJson(env.STAGING, `staging/${id}/sources.json`, sources);
  await env.DB.prepare('INSERT INTO dataset_generations (generation_id,status,source_fingerprint,created_at,updated_at,lease_token) VALUES (?1,\'staging\',?2,?3,?3,0)').bind(id, fingerprint, now).run();
  for (const system of SYSTEMS) {
    if (systemsToImport.includes(system)) await env.DB.prepare('INSERT INTO dataset_imports (generation_id,system,stage) VALUES (?1,?2,\'download_zip\')').bind(id, system).run();
    else await copyUnchangedSystem(env, id, activeGeneration, system);
  }
  return id;
}
async function importChunk(env, generation, row) {
  const object = await env.STAGING.get(row.txt_key); if (!object) throw new Error('txt_missing');
  const txt = await readText(object), lines = txt.replace(/^\uFEFF/, '').split(/\r?\n/);
  const window = nextImportWindow(row.line_no, lines.length);
  const records = parseDatasetText(txt, row.system, window.start, window.end - window.start);
  if (records.length) {
    const sql = `INSERT OR IGNORE INTO bidding_rules (generation_id,system,sequence,explanation,has_explanation,is_alert,source_order)
      SELECT ?1,json_extract(value,'$.system'),json_extract(value,'$.sequence'),json_extract(value,'$.explanation'),json_extract(value,'$.hasExplanation'),json_extract(value,'$.isAlert'),json_extract(value,'$.sourceOrder') FROM json_each(?2)`;
    await env.DB.prepare(sql).bind(generation, JSON.stringify(records)).run();
  }
  const nextLine = window.end, done = nextLine >= lines.length;
  await env.DB.prepare(`UPDATE dataset_imports SET line_no=?3, valid_count=valid_count+?4, stage=?5 WHERE generation_id=?1 AND system=?2`).bind(generation, row.system, nextLine, records.length, done ? 'validate_system' : 'import_chunks').run();
}
async function processImport(env, generation, row) {
  const baseKey = `staging/${generation}/${row.system}`;
  if (row.stage === 'download_zip') {
    const sourcesObject = await env.STAGING.get(`staging/${generation}/sources.json`); if (!sourcesObject) throw new Error('sources_missing');
    const sources = JSON.parse(await readText(sourcesObject)), u = new URL(sources[row.system]);
    const bytes = await downloadBytes(u.href, { allowHosts: [u.hostname] });
    await env.STAGING.put(`${baseKey}.zip`, bytes);
    await env.DB.prepare('UPDATE dataset_imports SET stage=\'extract_txt\',zip_key=?3 WHERE generation_id=?1 AND system=?2').bind(generation, row.system, `${baseKey}.zip`).run();
  } else if (row.stage === 'extract_txt') {
    const zip = await env.STAGING.get(row.zip_key); if (!zip) throw new Error('zip_missing');
    const txt = await readSystemTxt(await zip.arrayBuffer(), row.system);
    await env.STAGING.put(`${baseKey}.txt`, txt, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    await env.STAGING.delete(row.zip_key);
    await env.DB.prepare('UPDATE dataset_imports SET stage=\'import_chunks\',txt_key=?3 WHERE generation_id=?1 AND system=?2').bind(generation, row.system, `${baseKey}.txt`).run();
  } else if (row.stage === 'import_chunks') await importChunk(env, generation, row);
  else if (row.stage === 'validate_system') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM bidding_rules WHERE generation_id=?1 AND system=?2').bind(generation, row.system).first();
    if (!count?.n) throw new Error('empty_system');
    if (row.txt_key) await env.STAGING.delete(row.txt_key);
    await env.DB.prepare('UPDATE dataset_imports SET stage=\'complete\',final_count=?3 WHERE generation_id=?1 AND system=?2').bind(generation, row.system, count.n).run();
  }
}
async function claim(db, now) {
  const owner = crypto.randomUUID();
  const r = await db.prepare('UPDATE dataset_state SET lease_owner=?1,lease_until=?2,lease_token=lease_token+1 WHERE id=1 AND (lease_until IS NULL OR lease_until<=?3)').bind(owner, now + 25000, now).run();
  return r.meta?.changes === 1 ? owner : null;
}
export async function advanceRefresh(env, now = Date.now()) {
  if (!env?.DB || !env?.STAGING || !env.XINRUI_SESSION_ID || !env.XINRUI_UID || !env.XINRUI_VERSION) return { status: 'disabled' };
  const owner = await claim(env.DB, now); if (!owner) return { status: 'busy' };
  try {
    const state = await env.DB.prepare('SELECT * FROM dataset_state WHERE id=1').first();
    let gen = await env.DB.prepare("SELECT generation_id,source_fingerprint FROM dataset_generations WHERE status='staging' ORDER BY created_at DESC LIMIT 1").first();
    if (gen && !gen.source_fingerprint) {
      const savedSources = await env.STAGING.get(`staging/${gen.generation_id}/sources.json`);
      if (savedSources) {
        const fingerprint = sourceVersionFingerprint(JSON.parse(await readText(savedSources)));
        await env.DB.prepare('UPDATE dataset_generations SET source_fingerprint=?2 WHERE generation_id=?1').bind(gen.generation_id, fingerprint).run();
        gen = { ...gen, source_fingerprint: fingerprint };
      }
    }
    if (!gen && (!state?.last_checked_at || now - state.last_checked_at >= SIX_HOURS)) {
      const source = await sourceList(env);
      const active = state?.active_generation_id ? await env.DB.prepare('SELECT source_fingerprint FROM dataset_generations WHERE generation_id=?1').bind(state.active_generation_id).first() : null;
      await env.DB.prepare('UPDATE dataset_state SET last_checked_at=?1,retry_after=NULL WHERE id=1').bind(now).run();
      const systemsToImport = changedSystems(active?.source_fingerprint, source.fingerprint);
      if (!systemsToImport.length) return { status: 'unchanged' };
      gen = { generation_id: await createGeneration(env, now, source, systemsToImport, state?.active_generation_id) };
    }
    if (!gen) return { status: 'fresh' };
    const imports = await getAll(env.DB.prepare('SELECT * FROM dataset_imports WHERE generation_id=?1 ORDER BY CASE system WHEN \'JQA\' THEN 1 WHEN \'CBB\' THEN 2 WHEN \'NBS\' THEN 3 ELSE 4 END').bind(gen.generation_id));
    const action = nextImportAction(imports);
    if (action.type === 'activate') {
      await env.DB.prepare("UPDATE dataset_generations SET status='previous' WHERE generation_id=?1").bind(state?.active_generation_id || '').run();
      await env.DB.prepare("UPDATE dataset_generations SET status='active',updated_at=?2 WHERE generation_id=?1").bind(gen.generation_id, now).run();
      await env.DB.prepare('UPDATE dataset_state SET previous_generation_id=active_generation_id,active_generation_id=?1,last_success_at=?2,last_checked_at=?2,retry_after=NULL WHERE id=1').bind(gen.generation_id, now).run();
      await env.STAGING.delete(`staging/${gen.generation_id}/sources.json`);
      return { status: 'activated' };
    }
    await processImport(env, gen.generation_id, imports.find((x) => x.system === action.system));
    return { status: action.stage, system: action.system };
  } catch (error) {
    await env.DB.prepare('UPDATE dataset_state SET retry_after=?1 WHERE id=1').bind(now + 15 * 60 * 1000).run().catch(() => {});
    console.error('dataset_refresh', error instanceof Error ? error.message : 'unknown');
    return { status: 'failed' };
  } finally {
    await env.DB.prepare('UPDATE dataset_state SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=?1').bind(owner).run().catch(() => {});
  }
}
export async function runRefreshBurst(env, steps = 8) {
  for (let i = 0; i < steps; i++) { const r = await advanceRefresh(env); if (['disabled','busy','fresh','unchanged','failed','activated'].includes(r.status)) break; }
}
export async function datasetStatus(env) {
  if (!env?.DB) return { status: 'unavailable', dataAvailable: false, nextPollSeconds: 10, lastUpdatedAt: null };
  const state = await env.DB.prepare('SELECT active_generation_id,last_success_at,retry_after FROM dataset_state WHERE id=1').first();
  const staging = await env.DB.prepare("SELECT generation_id FROM dataset_generations WHERE status='staging' LIMIT 1").first();
  let available = null;
  try {
    available = await env.DB.prepare(`SELECT 1
      FROM dataset_imports imports
      JOIN dataset_generations generations ON generations.generation_id=imports.generation_id
      WHERE imports.stage='complete' AND generations.status IN ('staging','active') LIMIT 1`).first();
  } catch { /* A legacy database without import metadata has no partial availability. */ }
  const dataAvailable = !!available || !!state?.active_generation_id;
  return { status: staging ? (dataAvailable ? 'refreshing' : 'initializing') : 'idle', dataAvailable, nextPollSeconds: staging ? 2 : 30, lastUpdatedAt: state?.last_success_at ? new Date(state.last_success_at).toISOString() : null };
}
