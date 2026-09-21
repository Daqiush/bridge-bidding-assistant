export function validateSourceUrl(value, allowHosts = []) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname.length > 2048) throw new Error('invalid source url');
  if (allowHosts.length && !allowHosts.includes(u.hostname)) throw new Error('source host not allowed');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) throw new Error('non-standard port');
  return u;
}
export async function downloadBytes(url, { allowHosts = [], fetchImpl = fetch, timeoutMs = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
  let current = validateSourceUrl(url, allowHosts);
  for (let hop = 0; hop <= 3; hop++) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
    let r; try { r = await fetchImpl(current, { redirect: 'manual', signal: c.signal }); } finally { clearTimeout(t); }
    if ([301,302,303,307,308].includes(r.status)) { if (hop === 3) throw new Error('too many redirects'); current = validateSourceUrl(new URL(r.headers.get('location'), current).href, allowHosts); continue; }
    if (!r.ok || !r.body) throw new Error('download failed');
    const reader = r.body.getReader(), parts = []; let total = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) throw new Error('download too large'); parts.push(value); }
    const out = new Uint8Array(total); let p = 0; for (const part of parts) { out.set(part, p); p += part.byteLength; } return out;
  }
  throw new Error('download failed');
}
