const te = new TextDecoder("utf-8", { fatal: true });
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const text = (b, o, n) => te.decode(b.slice(o, o + n));
function safeName(name) { return name && name.length <= 256 && !name.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(name) && !name.split("/").includes(".."); }
function isSystemTxt(name, system) {
  const base = name.split("/").at(-1);
  if (!base?.toLowerCase().endsWith(".txt")) return false;
  const stem = base.slice(0, -4).toLowerCase();
  const code = system.toLowerCase();
  if (stem.split(/[^a-z0-9]+/).includes(code)) return true;
  return new RegExp(`^bidproduct(?:cn[-_])?[-_]?${code}(?:[-_].*)?$`).test(stem);
}
async function inflate(raw) {
  const ds = new DecompressionStream("deflate-raw");
  const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
  if (out.byteLength > 16 * 1024 * 1024) throw new Error("zip entry too large");
  return new Uint8Array(out);
}
export async function readSystemTxt(input, system) {
  const bytes = new Uint8Array(await new Response(input).arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("zip too large");
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("invalid zip");
  const count = u16(bytes, eocd + 10), cdSize = u32(bytes, eocd + 12), cdOff = u32(bytes, eocd + 16);
  if (count > 8 || cdSize > 64 * 1024 || cdOff + cdSize > bytes.length) throw new Error("zip limits exceeded");
  let p = cdOff, wanted;
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("invalid central directory");
    const flags = u16(bytes, p + 8), method = u16(bytes, p + 10), comp = u32(bytes, p + 20), size = u32(bytes, p + 24);
    const nlen = u16(bytes, p + 28), xlen = u16(bytes, p + 30), clen = u16(bytes, p + 32), name = text(bytes, p + 46, nlen);
    if (!safeName(name) || flags & 1 || ![0, 8].includes(method)) throw new Error("unsupported zip entry");
    const local = u32(bytes, p + 42); if (name.endsWith("/")) { p += 46 + nlen + xlen + clen; continue; }
    if (!isSystemTxt(name, system)) { p += 46 + nlen + xlen + clen; continue; }
    if (wanted) throw new Error("multiple system files");
    if (size > 16 * 1024 * 1024 || local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new Error("invalid entry");
    const ln = u16(bytes, local + 26), lx = u16(bytes, local + 28), start = local + 30 + ln + lx;
    const raw = bytes.slice(start, start + comp); if (raw.length !== comp) throw new Error("truncated entry");
    wanted = method === 0 ? raw : await inflate(raw);
    p += 46 + nlen + xlen + clen;
  }
  if (!wanted) throw new Error("system file missing");
  return te.decode(wanted);
}
