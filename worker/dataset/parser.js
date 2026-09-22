const CALL = /^(?:P|X|XX|[1-7](?:C|D|H|S|N))$/;
export function normalizeSequence(value) {
  return String(value || '').trim().toUpperCase().replaceAll('NT', 'N').split('_').map((x) => x.trim()).filter(Boolean).join('_');
}
export function parseDatasetLine(line, expectedSystem, sourceOrder) {
  if (!line || !line.trim()) return null;
  const parts = line.split('#');
  if (parts.length < 3) return null;
  const sequence = normalizeSequence(parts[0]);
  const system = parts[1].trim().toUpperCase();
  const calls = sequence.split('_');
  if (system !== expectedSystem || !sequence || !calls.every((c) => CALL.test(c))) return null;
  const explanation = parts[2].trim();
  return { sequence, system, explanation, hasExplanation: explanation ? 1 : 0, isAlert: parts[3]?.trim() === 'Y' ? 1 : 0, sourceOrder };
}
export function parseDatasetText(text, system, startLine = 0, maxLines = Infinity) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const seen = new Set(), out = [];
  const end = Math.min(lines.length, startLine + maxLines);
  for (let i = startLine; i < end; i++) {
    const row = parseDatasetLine(lines[i], system, i + 1);
    if (row && !seen.has(row.sequence)) { seen.add(row.sequence); out.push(row); }
  }
  return out;
}
