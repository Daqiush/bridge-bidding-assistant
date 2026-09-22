import test from 'node:test';
import assert from 'node:assert/strict';
import { readSystemTxt } from '../worker/dataset/zip.js';
function zipMany(entries) {
  const enc = new TextEncoder();
  const locals = entries.map(([name,content])=>({n:enc.encode(name),d:enc.encode(content)}));
  const localSize=locals.reduce((n,e)=>n+30+e.n.length+e.d.length,0),centralSize=locals.reduce((n,e)=>n+46+e.n.length,0),b=new Uint8Array(localSize+centralSize+22);let p=0;
  const w16=(o,v)=>{b[o]=v&255;b[o+1]=v>>8}; const w32=(o,v)=>{b[o]=v&255;b[o+1]=v>>8;b[o+2]=v>>16;b[o+3]=v>>24};
  for(const e of locals){e.off=p;w32(p,0x04034b50);w16(p+4,20);w16(p+8,0);w16(p+10,0);w32(p+18,e.d.length);w32(p+22,e.d.length);w16(p+26,e.n.length);w16(p+28,0);b.set(e.n,p+30);b.set(e.d,p+30+e.n.length);p+=30+e.n.length+e.d.length;}
  const cdOff=p;for(const e of locals){w32(p,0x02014b50);w16(p+4,20);w16(p+6,20);w16(p+8,0);w16(p+10,0);w32(p+20,e.d.length);w32(p+24,e.d.length);w16(p+28,e.n.length);w16(p+30,0);w16(p+32,0);w32(p+42,e.off);b.set(e.n,p+46);p+=46+e.n.length;}
  w32(p,0x06054b50);w16(p+8,locals.length);w16(p+10,locals.length);w32(p+12,centralSize);w32(p+16,cdOff); return b.buffer;
}
test('reads a bounded UTF-8 system txt from a zip', async()=>{ const txt=await readSystemTxt(zipMany([['CBB.txt','1C#CBB#自然开叫\n']]),'CBB'); assert.equal(txt,'1C#CBB#自然开叫\n'); });
test('ignores safe archive metadata while extracting the named system file', async()=>{ const txt=await readSystemTxt(zipMany([['README.txt','metadata'],['CBB.txt','1C#CBB#自然开叫\n']]),'CBB'); assert.match(txt,/自然开叫/); });
test('extracts the real vendor filename when it contains the system code', async()=>{ const txt=await readSystemTxt(zipMany([['bidproductCN-cbb-260721.txt','1C#CBB#自然开叫\n']]),'CBB'); assert.match(txt,/自然开叫/); });
for (const [system,filename] of [['JQA','bidproductJQA-260721.txt'],['CBB','bidproductCN-cbb-260721.txt'],['NBS','bidproductNBS-260721.txt'],['ASY','bidproduct_ASY.txt']]) {
  test(`extracts the official ${system} archive filename`, async()=>{ const txt=await readSystemTxt(zipMany([[filename,`1C#${system}#自然开叫\n`]]),system); assert.match(txt,/自然开叫/); });
}
test('rejects an archive without the system file', async()=>{ await assert.rejects(()=>readSystemTxt(zipMany([['evil.txt','x']]),'CBB')); });
