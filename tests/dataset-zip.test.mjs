import test from 'node:test';
import assert from 'node:assert/strict';
import { readSystemTxt } from '../worker/dataset/zip.js';
function zipOne(name, content) {
  const enc = new TextEncoder(), n = enc.encode(name), d = enc.encode(content), b = new Uint8Array(30+n.length+d.length+46+n.length+22); let p=0;
  const w16=(o,v)=>{b[o]=v&255;b[o+1]=v>>8}; const w32=(o,v)=>{b[o]=v&255;b[o+1]=v>>8;b[o+2]=v>>16;b[o+3]=v>>24};
  w32(p,0x04034b50);w16(p+4,20);w16(p+8,0);w16(p+10,0);w32(p+18,d.length);w32(p+22,d.length);w16(p+26,n.length);w16(p+28,0);b.set(n,p+30);b.set(d,p+30+n.length);p+=30+n.length+d.length;
  w32(p,0x02014b50);w16(p+4,20);w16(p+6,20);w16(p+8,0);w16(p+10,0);w32(p+20,d.length);w32(p+24,d.length);w16(p+28,n.length);w16(p+30,0);w16(p+32,0);w32(p+42,0);b.set(n,p+46);p+=46+n.length;
  w32(p,0x06054b50);w16(p+8,1);w16(p+10,1);w32(p+12,46+n.length);w32(p+16,30+n.length+d.length); return b.buffer;
}
test('reads a bounded UTF-8 system txt from a zip', async()=>{ const txt=await readSystemTxt(zipOne('CBB.txt','1C#CBB#自然开叫\n'),'CBB'); assert.equal(txt,'1C#CBB#自然开叫\n'); });
test('rejects unexpected entries', async()=>{ await assert.rejects(()=>readSystemTxt(zipOne('evil.txt','x'),'CBB')); });
