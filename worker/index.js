import { runRefreshBurst, datasetStatus } from './dataset/refresh.js';

const SUITS = ['C','D','H','S','N'];
const SYSTEMS = { JQA:'新睿精确', CBB:'新睿二盖一', NBS:'简易二盖一', ASY:'黄卡' };
const VUL_CYCLE = ['None','NS','EW','All','NS','EW','All','None','EW','All','None','NS','All','None','NS','EW'];
const CALL = /^(?:P|X|XX|[1-7](?:C|D|H|S|N))$/;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export function boardInfo(board) { return { dealer:['N','E','S','W'][(board-1)%4], vul:VUL_CYCLE[(board-1)%16] }; }
const json = (body, status=200, extra={}) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...extra } });

async function ensureDatasetState(env) {
  if (!env?.DB?.prepare) return;
  await env.DB.prepare('INSERT OR IGNORE INTO dataset_state (id,lease_token,next_step_not_before) VALUES (1,0,0)').run();
}
function validInput(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(SYSTEMS, value.system) || !['N','E','S','W'].includes(value.dealer) || !['None','NS','EW','All'].includes(value.vul) || ![0,1].includes(value.teammode)) return false;
  return typeof value.sequence === 'string' && value.sequence.length > 0 && value.sequence.length <= 1024 && value.sequence.toUpperCase().split('_').every((x)=>CALL.test(x));
}
async function activeGeneration(db) { try { return (await db.prepare('SELECT active_generation_id FROM dataset_state WHERE id=1').first())?.active_generation_id || null; } catch { return null; } }
async function queryRules(db, generation, system, sequences) {
  if (!db || !generation || !sequences.length) return {};
  const r = await db.prepare("SELECT sequence,explanation,is_alert FROM bidding_rules WHERE generation_id=?1 AND system=?2 AND has_explanation=1 AND sequence IN (SELECT value FROM json_each(?3))").bind(generation, system, JSON.stringify(sequences)).all();
  return Object.fromEntries((r.results||[]).map((x)=>[x.sequence,{ status:'found', explanation:x.explanation, isAlert:!!x.is_alert, source:'dataset' }]));
}
function explanationCacheKey(input, sequence, env) {
  return JSON.stringify([input.system,input.dealer,input.vul,input.teammode,sequence,String(env?.XINRUI_VERSION||''),1]);
}
async function queryExplanationCache(db, env, input, sequences) {
  if (!db || !sequences.length) return {};
  const keyed=sequences.map((sequence)=>({sequence,key:explanationCacheKey(input,sequence,env)}));
  try {
    const r=await db.prepare("SELECT cache_key,explanation,is_alert FROM explanation_cache WHERE cache_key IN (SELECT value FROM json_each(?1)) AND expires_at>?2").bind(JSON.stringify(keyed.map((x)=>x.key)),Date.now()).all();
    const byKey=Object.fromEntries((r.results||[]).map((x)=>[x.cache_key,x]));
    return Object.fromEntries(keyed.filter((x)=>byKey[x.key]).map((x)=>[x.sequence,{status:'found',explanation:byKey[x.key].explanation,isAlert:!!byKey[x.key].is_alert,source:'cache'}]));
  } catch { return {}; }
}
async function writeExplanationCache(db, env, input, sequence, result) {
  if (!db || result?.status!=='found') return;
  const now=Date.now();
  try {
    await db.prepare("INSERT INTO explanation_cache (cache_key,explanation,is_alert,expires_at,created_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(cache_key) DO UPDATE SET explanation=excluded.explanation,is_alert=excluded.is_alert,expires_at=excluded.expires_at,created_at=excluded.created_at").bind(explanationCacheKey(input,sequence,env),result.explanation,result.isAlert?1:0,now+CACHE_TTL_MS,now).run();
  } catch { console.error('explanation_cache_write'); }
}
async function upstreamExplain(input, env) {
  if (!env?.XINRUI_SESSION_ID || !env?.XINRUI_UID || !env?.XINRUI_VERSION) return { status:'unavailable', message:'说明服务暂时不可用，请稍后重试。' };
  const c = new AbortController(), timer = setTimeout(()=>c.abort(),8000);
  try {
    const base=String(env.XINRUI_BASE_URL||'https://www.xinruibridge.com').replace(/\/$/,'');
    const r=await fetch(`${base}/bidcomment`,{method:'POST',headers:{'content-type':'application/json; charset=utf-8','user-agent':'BridgeBiddingWeb/1.0'},body:JSON.stringify({bid:input.sequence.toUpperCase(),bidsystem:`${input.system},${input.system}`,dealer:input.dealer,lang:1,sessionid:env.XINRUI_SESSION_ID,teammode:input.teammode,uid:Number(env.XINRUI_UID),version:env.XINRUI_VERSION,vul:input.vul}),signal:c.signal});
    if(!r.ok) throw new Error('upstream'); const data=await r.json();
    if(data?.rcode==='0000'&&typeof data.content==='string'&&data.content.trim()) return {status:'found',explanation:data.content.trim(),isAlert:data.isalert==='Y',source:'upstream'};
    return {status:'missing',message:'暂无该叫牌序列的说明。'};
  } catch { return {status:'unavailable',message:'说明服务暂时不可用，请稍后重试。'}; } finally { clearTimeout(timer); }
}
async function explainOne(input, env) {
  const sequence=input.sequence.toUpperCase(), generation=env?.DB?await activeGeneration(env.DB):null;
  const hit=generation?(await queryRules(env.DB,generation,input.system,[sequence]))[sequence]:null;
  if(hit)return hit;
  const cached=(await queryExplanationCache(env?.DB,env,input,[sequence]))[sequence];
  if(cached)return cached;
  const result=await upstreamExplain({...input,sequence},env);
  await writeExplanationCache(env?.DB,env,input,sequence,result);
  return result;
}
async function handleExplain(request,env) {
  let input; try{input=await request.json();}catch{return json({status:'invalid',message:'请求格式不正确。'},400);}
  if(!validInput(input)) return json({status:'invalid',message:'叫牌序列或设置不正确。'},400);
  const result=await explainOne(input,env); return json(result,result.status==='missing'?404:result.status==='unavailable'?503:200);
}
async function handleExplanations(request,env) {
  let input; try{input=await request.json();}catch{return json({status:'invalid',message:'请求格式不正确。'},400);}
  if(!input||!Array.isArray(input.sequences)||input.sequences.length<1||input.sequences.length>40||!input.sequences.every((s)=>validInput({...input,sequence:s}))) return json({status:'invalid',message:'叫牌序列不正确。'},400);
  const sequences=[...new Set(input.sequences.map((s)=>s.toUpperCase()))],generation=env?.DB?await activeGeneration(env.DB):null;
  const results=generation?await queryRules(env.DB,generation,input.system,sequences):{};
  Object.assign(results,await queryExplanationCache(env?.DB,env,input,sequences.filter((s)=>!results[s])));
  const missing=sequences.filter((s)=>!results[s]);
  return json({status:'ok',results,pending:missing});
}

function page(){return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>桥牌叫牌助手</title><style>
:root{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#17221b;background:#f4f7f2}*{box-sizing:border-box}body{margin:0}header{padding:25px max(20px,calc((100% - 1180px)/2));background:#173b2c;color:#fff}header h1{margin:0;font-size:28px}.shell{max-width:1180px;margin:24px auto;padding:0 20px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.toolbar label{font-size:13px;color:#55705c;display:grid;gap:4px}.toolbar select,.toolbar input,.toolbar button{border:1px solid #c3d4c4;border-radius:10px;background:white;padding:10px 12px;font:inherit}.toolbar button{cursor:pointer}.toolbar .primary{background:#1b6a43;color:white}.layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(310px,.75fr);gap:18px;margin-top:18px}.card{background:#fff;border:1px solid #dce7dc;border-radius:18px;box-shadow:0 8px 24px #173b2c0b;padding:18px}.meta{display:flex;justify-content:space-between;margin-bottom:14px}.sequence{min-height:118px;background:#f7faf6;border-radius:12px;padding:12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.seat{text-align:center;color:#2f7c43;font-weight:700}.seat.vul{color:#bd3838}.bid{min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:#f0f5ef;border:1px solid #e1eae0}.bid.click{cursor:pointer}.board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr)) 40px;gap:7px;margin-top:16px}.level{display:grid;place-items:center;color:#698071;font-weight:700}.bidbtn,.special button{cursor:pointer;border:1px solid #d1dfd1;background:#fff;border-radius:10px;padding:11px 5px;font-size:16px}.bidbtn:disabled,.special button:disabled{opacity:.3}.bidbtn.red{color:#c03939}.special{display:grid;grid-template-columns:2fr 1fr 1fr;gap:7px;margin-top:10px}.next{display:grid;gap:9px;max-height:560px;overflow:auto}.next button{text-align:left;border:1px solid #dce7dc;background:#fbfdfb;border-radius:12px;padding:11px;cursor:pointer}.next button:disabled{opacity:.55}.next strong{display:inline-block;min-width:65px;color:#175d3c}.next small{color:#58705d;line-height:1.45}.explain{min-height:116px;line-height:1.65}.alert-badge{margin-left:5px}.done{color:#1b6a43}.dataset{font-size:12px;color:#698071}footer{max-width:1180px;margin:18px auto 30px;text-align:center;color:#6b7b70}@media(max-width:800px){.layout{grid-template-columns:1fr}.next{max-height:none}}
</style></head><body><header><h1>桥牌叫牌助手</h1></header><main class="shell"><div class="toolbar"><label>体系<select id="system"></select></label><label>副数<input id="board" type="number" min="1" value="1" style="width:76px"></label><button id="prev">上一副</button><button id="nextBoard">下一副</button><button id="undo">撤销</button><button id="clear">清空</button><button class="primary" id="copy">复制叫牌序列</button><span id="dataset" class="dataset"></span></div><div class="layout"><section class="card"><div class="meta"><strong id="boardMeta"></strong><span id="status"></span></div><div id="sequence" class="sequence"></div><div id="boardGrid" class="board"></div><div id="special" class="special"></div></section><aside class="card"><h2 style="margin-top:0">下一步建议</h2><div id="nextList" class="next"></div><hr style="border:0;border-top:1px solid #e6eee5;margin:18px 0"><h2>叫品说明</h2><div id="explain" class="explain">点击叫牌历史查看说明。</div></aside></div></main><footer>北京析构整环桥牌俱乐部出品</footer><template id="alertTemplate"><strong class="alert-badge" aria-label="ALERT">🅰︎</strong></template><script>
const systems=${JSON.stringify(SYSTEMS)},suits=${JSON.stringify(SUITS)},symbols={C:'♣',D:'♦',H:'♥',S:'♠',N:'NT'},vulCycle=${JSON.stringify(VUL_CYCLE)};let bids=[],system='CBB',board=1,renderId=0,controller;const explanationCache=new Map();
const $=id=>document.getElementById(id),fmt=b=>b==='P'?'PASS':(b==='X'||b==='XX'?b:b[0]+symbols[b.slice(1)]),isSub=b=>b&&!['P','X','XX'].includes(b);const higher=(a,b)=>!b||+a[0]>+b[0]||(+a[0]===+b[0]&&suits.indexOf(a.slice(1))>suits.indexOf(b.slice(1)));const last=()=>[...bids].reverse().find(isSub);
function legal(){const l=last(),o=[];for(let n=1;n<8;n++)for(const s of suits){const b=n+s;if(higher(b,l))o.push(b)}o.push('P');const i=l?bids.lastIndexOf(l):-1,a=bids.slice(i+1);if(l&&(bids.length-i)%2===1&&!a.some(x=>x==='X'||x==='XX'))o.push('X');if(l&&(bids.length-i)%2===0&&a.includes('X')&&!a.includes('XX'))o.push('XX');return o}const info=()=>({dealer:['N','E','S','W'][(board-1)%4],vul:vulCycle[(board-1)%16]});const finished=()=>bids.length>=4&&((bids.length===4&&bids.every(x=>x==='P'))||(bids.slice(-3).every(x=>x==='P')&&bids.slice(0,-3).some(isSub)));
function show(target,data){target.textContent=data?.explanation||data?.message||'暂无说明';if(data?.isAlert)target.append(document.getElementById('alertTemplate').content.cloneNode(true))}
const explanationKey=(context,sequence)=>[context.system,context.dealer,context.vul,context.teammode,sequence].join('|');
function rememberExplanation(context,sequence,result){if(result?.status==='found')explanationCache.set(explanationKey(context,sequence),result);return result}
async function loadExplain(sequence){const i=info(),context={system,dealer:i.dealer,vul:i.vul,teammode:0};const cached=explanationCache.get(explanationKey(context,sequence));if(cached){show($('explain'),cached);return}$('explain').textContent='正在查询…';try{const r=await fetch('/api/explain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...context,sequence})});const result=await r.json();rememberExplanation(context,sequence,result);show($('explain'),result)}catch{$('explain').textContent='说明服务暂时不可用，请稍后重试。'}}
async function prefetch(items,id){const i=info(),context={system,dealer:i.dealer,vul:i.vul,teammode:0},buttons=[...document.querySelectorAll('[data-next]')];const missing=items.filter((item,k)=>{const cached=explanationCache.get(explanationKey(context,item.sequence));if(cached)show(buttons[k].querySelector('small'),cached);return !cached});if(!missing.length)return;controller?.abort();controller=new AbortController();try{const r=await fetch('/api/explanations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...context,sequences:missing.map(x=>x.sequence)}),signal:controller.signal});const data=await r.json();items.forEach((item,k)=>{const result=data.results?.[item.sequence];if(!result)return;rememberExplanation(context,item.sequence,result);if(id===renderId)show(buttons[k].querySelector('small'),result)});for(const sequence of data.pending||[]){const k=items.findIndex(item=>item.sequence===sequence);if(k<0)continue;fetch('/api/explain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...context,sequence}),signal:controller.signal}).then(r=>r.json()).then(result=>{rememberExplanation(context,sequence,result);if(id===renderId)show(buttons[k].querySelector('small'),result)}).catch(e=>{if(e.name!=='AbortError'&&id===renderId)buttons[k].querySelector('small').textContent='说明暂时不可用'})}}catch(e){if(e.name!=='AbortError'&&id===renderId)document.querySelectorAll('[data-next] small').forEach(e=>e.textContent='说明暂时不可用')}}
function render(){const id=++renderId,i=info(),l=finished()?[]:legal(),seq=$('sequence');$('boardMeta').textContent='第 '+board+' 副 · '+i.dealer+' 发 · 局况 '+i.vul;$('status').textContent=finished()?'叫牌结束':'';seq.innerHTML=['N','E','S','W'].map(s=>'<div class="seat '+((i.vul==='All'||i.vul.includes((s==='N'||s==='S')?'NS':'EW'))?'vul':'')+'">'+s+'</div>').join('');for(let x=0;x<['N','E','S','W'].indexOf(i.dealer);x++)seq.innerHTML+='<div></div>';bids.forEach((b,k)=>seq.innerHTML+='<div class="bid click" data-i="'+k+'">'+fmt(b)+'</div>');while(seq.children.length%4)seq.innerHTML+='<div></div>';seq.querySelectorAll('[data-i]').forEach(e=>e.onclick=()=>loadExplain(bids.slice(0,+e.dataset.i+1).join('_')));let grid='<div></div>'+suits.map(s=>'<div class="level">'+symbols[s]+'</div>').join('');for(let n=1;n<8;n++){grid+='<div class="level">'+n+'</div>';for(const s of suits){const b=n+s;grid+='<button class="bidbtn '+(['H','D'].includes(s)?'red':'')+'" data-bid="'+b+'" '+(l.includes(b)?'':'disabled')+'>'+fmt(b)+'</button>'}}$('boardGrid').innerHTML=grid;$('special').innerHTML=['P','X','XX'].map(b=>'<button data-bid="'+b+'" '+(l.includes(b)?'':'disabled')+'>'+fmt(b)+'</button>').join('');document.querySelectorAll('[data-bid]').forEach(e=>e.onclick=()=>add(e.dataset.bid));const items=l.slice(0,40).map(b=>({bid:b,sequence:(bids.length?bids.join('_')+'_':'')+b}));$('nextList').innerHTML=items.map(x=>'<button data-next="'+x.bid+'"><strong>'+fmt(x.bid)+'</strong><small>正在查询真实说明…</small></button>').join('');document.querySelectorAll('[data-next]').forEach(e=>e.onclick=()=>add(e.dataset.next));if(items.length)prefetch(items,id);$('board').value=board}
function add(b){if(!legal().includes(b)||finished())return;document.querySelectorAll('[data-next]').forEach(e=>e.disabled=true);controller?.abort();bids.push(b);if($('autoPass').checked&&b!=='P')bids.push('P');render();loadExplain(bids.join('_'))}
const autoPassControl=document.createElement('label');autoPassControl.innerHTML='对手自动PASS<input id="autoPass" type="checkbox">';document.querySelector('.toolbar').insertBefore(autoPassControl,$('prev'));
$('system').innerHTML=Object.entries(systems).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('');$('system').value=system;$('system').onchange=e=>{system=e.target.value;bids=[];render()};$('undo').onclick=()=>{bids.pop();render()};$('clear').onclick=()=>{bids=[];render()};$('prev').onclick=()=>{board=Math.max(1,board-1);bids=[];render()};$('nextBoard').onclick=()=>{board++;bids=[];render()};$('board').onchange=e=>{board=Math.max(1,+e.target.value||1);bids=[];render()};$('copy').onclick=async()=>{await navigator.clipboard?.writeText(bids.join('_'))};async function poll(){try{const d=await(await fetch('/api/dataset-status')).json();$('dataset').textContent=d.dataAvailable?(d.status==='refreshing'?'规则库正在更新':'规则库已就绪'):'规则库初始化中';setTimeout(poll,(d.nextPollSeconds||3)*1000)}catch{setTimeout(poll,5000)}}render();poll();
</script></body></html>`.replace('</script></body>',String.raw`</script><script>
const displaySuits=['N','S','H','D','C'];
    document.head.insertAdjacentHTML('beforeend','<style>.suit-C,.next strong.suit-C{color:#198754 !important}.suit-D,.next strong.suit-D{color:#e67e22 !important}.suit-H,.next strong.suit-H{color:#d6336c !important}.suit-S,.next strong.suit-S{color:#111 !important}.suit-N,.next strong.suit-N{color:#e7a6df !important}.next .alert-badge{color:#1677ff}.sequence-trace{white-space:pre-line;margin-top:14px;color:#42544a;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}</style>');
    function decorateCalls(){const grid=$('boardGrid'),cells=[...grid.children];for(let i=0;i<cells.length;i+=6){const row=cells.slice(i,i+6);if(row.length===6){const reordered=[...row.slice(1).reverse(),row[0]];reordered.forEach(cell=>grid.appendChild(cell))}}document.querySelectorAll('.bid,.bidbtn,.special button,#nextList strong').forEach(el=>{const text=el.textContent;[['♣','C'],['♦','D'],['♥','H'],['♠','S'],['NT','N']].forEach(([symbol,suit])=>{if(text.includes(symbol))el.classList.add('suit-'+suit)})});let trace=$('sequenceTrace');if(!trace){trace=document.createElement('div');trace.id='sequenceTrace';trace.className='sequence-trace';$('explain').after(trace)}const groups=[];for(let i=0;i<bids.length;i+=4)groups.push(bids.slice(i,i+4).join('_'));trace.textContent=groups.join('\\n')}
const baseRender=render;render=function(){baseRender();decorateCalls()};
const copyButton=$('copy'),readButton=document.createElement('button');readButton.id='readClipboard';readButton.textContent='读取叫牌序列';copyButton.after(readButton);copyButton.onclick=async()=>{try{await navigator.clipboard.writeText(bids.join('_'));const old=copyButton.textContent;copyButton.textContent='已复制';setTimeout(()=>copyButton.textContent=old,1600)}catch{copyButton.textContent='复制失败'}};readButton.onclick=async()=>{try{const raw=await navigator.clipboard.readText();const parsed=raw.trim().split(/[\\s_,]+/).filter(Boolean).map(token=>token.toUpperCase().replace('PASS','P').replace('♣','C').replace('♦','D').replace('♥','H').replace('♠','S').replace('NT','N'));if(parsed.some(token=>!(/^(?:P|X|XX|[1-7][CDHSN])$/.test(token))))throw new Error('invalid');bids=parsed;render();if(bids.length)loadExplain(bids.join('_'));readButton.textContent='已读取';setTimeout(()=>readButton.textContent='读取叫牌序列',1600)}catch{readButton.textContent='读取失败';setTimeout(()=>readButton.textContent='读取叫牌序列',1600)}};render();
</script></body></html>`).replaceAll("groups.join('\\\\n')",'groups.join(String.fromCharCode(10))').replaceAll("bids.slice(i,i+4).join('_')",'bids.slice(i,i+4).join(String.fromCharCode(9))').replaceAll('max-height:560px','max-height:365px').replaceAll('.sequence-trace{white-space:pre-line','.sequence-trace{tab-size:4;white-space:pre-line').replace('</body>',String.raw`<script>
let activeSequence='';
function renderActiveTrace(){const full=bids.join('_'),shown=activeSequence&&full.startsWith(activeSequence)?activeSequence:full,trace=$('sequenceTrace');if(!trace)return;const calls=shown?shown.split('_'):[],groups=[];for(let i=0;i<calls.length;i+=4)groups.push(calls.slice(i,i+4).join(String.fromCharCode(9)));trace.textContent=groups.join(String.fromCharCode(10))}
const originalLoadExplain=loadExplain;loadExplain=async sequence=>{activeSequence=sequence;renderActiveTrace();return originalLoadExplain(sequence)};
const decoratedRender=render;render=function(){decoratedRender();renderActiveTrace()};renderActiveTrace();
</script></body>`).replaceAll('副数','副号').replaceAll('正在查询真实规则…','正在查询…').replaceAll('正在查询真实说明…','正在查询…')}

export default { async scheduled(_event, env, ctx) {
  ctx.waitUntil(runRefreshBurst(env));
}, async fetch(request,env,ctx={}) {
  await ensureDatasetState(env); if(env?.DB&&env?.STAGING&&ctx?.waitUntil) ctx.waitUntil(runRefreshBurst(env));
  const url=new URL(request.url);
  if(url.pathname==='/api/explain'&&request.method==='POST') return handleExplain(request,env);
  if(url.pathname==='/api/explanations'&&request.method==='POST') return handleExplanations(request,env);
  if(url.pathname==='/api/dataset-status'&&request.method==='GET') return json(await datasetStatus(env));
  if(url.pathname!=='/'&&url.pathname!=='/index.html') return new Response('Not found',{status:404});
  return new Response(page(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
} };
