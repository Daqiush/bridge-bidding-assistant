const SUITS = ["C", "D", "H", "S", "N"];
const SYSTEMS = {
  JQA: "新睿精确",
  CBB: "新睿二盖一",
  NBS: "简易二盖一",
  ASY: "黄卡",
};
const suitSymbol = { C: "♣", D: "♦", H: "♥", S: "♠", N: "NT" };
const formatBid = (b) => b === "P" ? "PASS" : b === "X" || b === "XX" ? b : b[0] + (suitSymbol[b.slice(1)] || b.slice(1));
const substantive = (b) => b && !["P", "X", "XX"].includes(b);
function higher(a, b) {
  if (!b) return true;
  const la = Number(a[0]), lb = Number(b[0]);
  return la > lb || (la === lb && SUITS.indexOf(a.slice(1)) > SUITS.indexOf(b.slice(1)));
}
function lastSubstantive(bids) { return [...bids].reverse().find(substantive); }
function legalBids(bids) {
  const last = lastSubstantive(bids);
  const out = [];
  for (let level = 1; level <= 7; level++) for (const suit of SUITS) {
    const bid = `${level}${suit}`;
    if (higher(bid, last)) out.push(bid);
  }
  out.push("P");
  const idx = last ? bids.lastIndexOf(last) : -1;
  const after = bids.slice(idx + 1);
  if (last && (bids.length - idx) % 2 === 1 && !after.some((b) => b === "X" || b === "XX")) out.push("X");
  if (last && (bids.length - idx) % 2 === 0 && after.includes("X") && !after.includes("XX")) out.push("XX");
  return out;
}
function finished(bids) {
  if (bids.length < 4) return false;
  if (bids.length === 4 && bids.every((b) => b === "P")) return true;
  return bids.slice(-3).every((b) => b === "P") && bids.slice(0, -3).some(substantive);
}
function boardInfo(board) {
  const dealers = ["N", "E", "S", "W"];
  const vul = ["None", "NS", "EW", "All"];
  return { dealer: dealers[(board - 1) % 4], vul: vul[Math.floor((board - 1) / 4) % 4] };
}
function explain(system, sequence, bid) {
  if (bid === "P") return "PASS：当前没有更合适的叫品。";
  if (bid === "X") return "DOUBLE：对方最后一个实质叫品后，表示防守性加倍。";
  if (bid === "XX") return "REDOUBLE：己方叫品被加倍后进行再加倍。";
  if (sequence.split("_").length === 1) {
    const level = Number(bid[0]);
    if (bid.endsWith("N")) return `${SYSTEMS[system]}：${formatBid(bid)}，均衡牌型的开叫候选，约 ${level === 1 ? "15–17" : "强牌"} 点。`;
    return `${SYSTEMS[system]}：${formatBid(bid)}，自然花色开叫候选，通常表示至少四张该花色。`;
  }
  return `${SYSTEMS[system]}：${formatBid(bid)} 是序列 “${sequence.replaceAll("_", " ")}” 后的合法延续。请结合牌力、牌型与局况判断。`;
}
function html() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>桥牌叫牌助手</title><style>
  :root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17221b;background:#f4f7f2}*{box-sizing:border-box}body{margin:0}header{padding:28px max(20px,calc((100% - 1180px)/2));background:#173b2c;color:#f5fbf2;display:flex;justify-content:space-between;align-items:center}header h1{margin:0;font-size:28px}header p{margin:6px 0 0;color:#c8e2cc}.shell{max-width:1180px;margin:24px auto;padding:0 20px}.toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.toolbar label{font-size:13px;color:#55705c}.toolbar select,.toolbar button{border:1px solid #c3d4c4;border-radius:10px;background:white;padding:10px 12px;font:inherit}.toolbar button{cursor:pointer}.toolbar .primary{background:#1b6a43;color:white;border-color:#1b6a43}.layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:18px;margin-top:18px}.card{background:white;border:1px solid #dce7dc;border-radius:18px;box-shadow:0 8px 24px #173b2c0b;padding:18px}.meta{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.meta strong{font-size:18px}.sequence{min-height:118px;background:#f7faf6;border-radius:12px;padding:12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.seat{text-align:center;color:#2f7c43;font-weight:700}.seat.vul{color:#bd3838}.bid{min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:#f0f5ef;font-weight:650;border:1px solid #e1eae0}.bid.click{cursor:pointer}.bid.click:hover{background:#e2f1e5}.board{display:grid;grid-template-columns:40px repeat(5,1fr);gap:7px;margin-top:16px}.level{display:grid;place-items:center;color:#698071;font-weight:700}.bidbtn{cursor:pointer;border:1px solid #d1dfd1;background:#fff;border-radius:10px;padding:11px 5px;font-size:16px}.bidbtn:disabled{opacity:.3;cursor:not-allowed}.bidbtn.red{color:#c03939}.special{display:grid;grid-template-columns:2fr 1fr 1fr;gap:7px;margin-top:10px}.special button{padding:12px;border-radius:10px;border:1px solid #d1dfd1;background:#fff;cursor:pointer}.special button:disabled{opacity:.3;cursor:not-allowed}.history{display:flex;gap:7px;flex-wrap:wrap;margin-top:13px}.history button{border:0;border-radius:8px;background:#e8f2e8;padding:7px 9px;cursor:pointer}.explain{min-height:116px;line-height:1.65;color:#3a5140}.next{display:grid;gap:9px;max-height:560px;overflow:auto}.next button{text-align:left;border:1px solid #dce7dc;background:#fbfdfb;border-radius:12px;padding:11px;cursor:pointer}.next strong{display:inline-block;min-width:65px;color:#175d3c}.next small{color:#58705d}.warning{color:#a25c1c;background:#fff5e8;padding:10px;border-radius:10px}.done{color:#1b6a43;background:#e8f5ea;padding:10px;border-radius:10px}@media(max-width:800px){.layout{grid-template-columns:1fr}.next{max-height:none}}
  </style></head><body><header><h1>桥牌叫牌助手</h1></header><main class="shell"><div class="toolbar"><label>体系<select id="system"></select></label><label>副数<input id="board" type="number" min="1" value="1" style="width:76px;padding:9px;border:1px solid #c3d4c4;border-radius:10px"></label><button id="prev">上一副</button><button id="nextBoard">下一副</button><button id="undo">撤销</button><button id="clear">清空</button><button class="primary" id="copy">复制叫牌序列</button></div><div class="layout"><section class="card"><div class="meta"><strong id="boardMeta"></strong><span id="status"></span></div><div id="sequence" class="sequence"></div><div id="boardGrid" class="board"></div><div id="special" class="special"></div></section><aside class="card"><h2 style="margin-top:0">下一步建议</h2><div id="nextList" class="next"></div><hr style="border:0;border-top:1px solid #e6eee5;margin:18px 0"><h2>叫品说明</h2><div id="explain" class="explain">点击叫牌历史或建议查看说明。</div></aside></div></main><script>
  const systems=${JSON.stringify(SYSTEMS)}, suits=${JSON.stringify(SUITS)}, symbols=${JSON.stringify(suitSymbol)};let bids=[],system="CBB",board=1,lastExplanation="";
  const $=id=>document.getElementById(id), fmt=b=>b==='P'?'PASS':(b==='X'||b==='XX'?b:b[0]+(symbols[b.slice(1)]||b.slice(1))); const isSub=b=>b&&!['P','X','XX'].includes(b);
  const higher=(a,b)=>!b||+a[0]>+b[0]||(+a[0]===+b[0]&&suits.indexOf(a.slice(1))>suits.indexOf(b.slice(1))); const last=()=>[...bids].reverse().find(isSub);
  function legal(){const l=last(),o=[];for(let n=1;n<8;n++)for(const s of suits){const b=n+s;if(higher(b,l))o.push(b)}o.push('P');const i=l?bids.lastIndexOf(l):-1,after=bids.slice(i+1);if(l&&(bids.length-i)%2===1&&!after.some(x=>x==='X'||x==='XX'))o.push('X');if(l&&(bids.length-i)%2===0&&after.includes('X')&&!after.includes('XX'))o.push('XX');return o}
  const info=n=>({dealer:['N','E','S','W'][(n-1)%4],vul:['None','NS','EW','All'][Math.floor((n-1)/4)%4]}); const finished=()=>bids.length>=4&&((bids.length===4&&bids.every(x=>x==='P'))||(bids.slice(-3).every(x=>x==='P')&&bids.slice(0,-3).some(isSub)));
  function explain(b,idx=bids.length){const seq=bids.slice(0,idx).join('_');if(b==='P')return 'PASS：当前没有更合适的叫品。';if(b==='X')return 'DOUBLE：对方最后一个实质叫品后，表示防守性加倍。';if(b==='XX')return 'REDOUBLE：己方叫品被加倍后进行再加倍。';if(idx===1)return systems[system]+'：'+fmt(b)+'，自然花色或均衡牌型的开叫候选。';return systems[system]+'：'+fmt(b)+' 是序列 “'+seq.replaceAll('_',' ')+'” 后的合法延续，请结合牌力、牌型与局况判断。'}
  function render(){const i=info(board),l=legal();$('boardMeta').textContent='第 '+board+' 副 · '+i.dealer+' 发 · 局况 '+i.vul;$('status').innerHTML=finished()?'<span class="done">叫牌结束</span>':'';const seq=$('sequence');seq.innerHTML=['N','E','S','W'].map((s,k)=>'<div class="seat '+((i.vul==='All'||i.vul.includes(s==='N'||s==='S'?'NS':'EW'))?'vul':'')+'">'+s+'</div>').join('');const pad=['N','E','S','W'].indexOf(i.dealer);for(let x=0;x<pad;x++)seq.innerHTML+='<div></div>';bids.forEach((b,k)=>seq.innerHTML+='<div class="bid click" data-i="'+k+'">'+fmt(b)+'</div>');while(seq.children.length%4)seq.innerHTML+='<div></div>';seq.querySelectorAll('[data-i]').forEach(e=>e.onclick=()=>{$('explain').textContent=explain(bids[+e.dataset.i],+e.dataset.i+1)});let grid='<div></div>'+suits.map(s=>'<div class="level">'+(symbols[s]||s)+'</div>').join('');for(let n=1;n<8;n++){grid+='<div class="level">'+n+'</div>';for(const s of suits){const b=n+s;grid+='<button class="bidbtn '+(s==='H'||s==='D'?'red':'')+'" data-bid="'+b+'" '+(l.includes(b)?'':'disabled')+'>'+fmt(b)+'</button>'}}$('boardGrid').innerHTML=grid;$('special').innerHTML=['P','X','XX'].map(b=>'<button data-bid="'+b+'" '+(l.includes(b)?'':'disabled')+'>'+fmt(b)+'</button>').join('');document.querySelectorAll('[data-bid]').forEach(e=>e.onclick=()=>add(e.dataset.bid));$('nextList').innerHTML=l.slice(0,40).map(b=>'<button data-next="'+b+'"><strong>'+fmt(b)+'</strong><small>'+explain(b,bids.length+1)+'</small></button>').join('');document.querySelectorAll('[data-next]').forEach(e=>e.onclick=()=>{$('explain').textContent=explain(e.dataset.next,bids.length+1)});$('board').value=board}
  function add(b){if(!legal().includes(b))return;bids.push(b);render();$('explain').textContent=explain(b,bids.length)}$('system').innerHTML=Object.entries(systems).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('');$('system').value=system;$('system').onchange=e=>{system=e.target.value;bids=[];render()};$('undo').onclick=()=>{bids.pop();render()};$('clear').onclick=()=>{bids=[];render()};$('prev').onclick=()=>{board=Math.max(1,board-1);bids=[];render()};$('nextBoard').onclick=()=>{board++;bids=[];render()};$('board').onchange=e=>{board=Math.max(1,+e.target.value||1);bids=[];render()};$('copy').onclick=async()=>{await navigator.clipboard?.writeText(bids.join('_'));$('copy').textContent='已复制';setTimeout(()=>$('copy').textContent='复制叫牌序列',1200)};render();
  </script></body></html>`;
}
export default { async fetch(request) { const url = new URL(request.url); if (url.pathname !== "/" && url.pathname !== "/index.html") return new Response("Not found", { status: 404 }); return new Response(html(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }); } };
