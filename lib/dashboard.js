'use strict';
// Dashboards interativos num único arquivo HTML (sem internet, sem bibliotecas externas): indicadores,
// gráficos SVG (barras, linhas, área, pizza, rosca, dispersão, funil), tabelas com ordenação e busca, e filtros
// que recalculam tudo no navegador. Os dados vêm de CSV, Excel, JSON, SQLite (via SQL) ou direto no pedido.

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const THEMES = {
  claro: { bg: '#f6f7fb', card: '#ffffff', fg: '#111827', muted: '#6b7280', grid: '#e5e7eb', accent: '#2563eb', palette: ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'] },
  escuro: { bg: '#0f1115', card: '#171a21', fg: '#f3f4f6', muted: '#9ca3af', grid: '#2a2f3a', accent: '#76b900', palette: ['#76b900', '#38bdf8', '#f59e0b', '#f472b6', '#a78bfa', '#2dd4bf', '#fb923c', '#94a3b8'] },
  consultoria: { bg: '#f4f6fa', card: '#ffffff', fg: '#0b1f3a', muted: '#64748b', grid: '#e2e8f0', accent: '#0b3d91', palette: ['#0b3d91', '#5b8def', '#a7c4f2', '#f2a900', '#7a869a', '#d64545', '#2a9d8f', '#9b5de5'] },
  papel: { bg: '#fbf8f1', card: '#ffffff', fg: '#1f2937', muted: '#6b7280', grid: '#ece6d8', accent: '#f97316', palette: ['#f97316', '#3b82f6', '#10b981', '#eab308', '#ec4899', '#8b5cf6', '#06b6d4', '#84cc16'] },
};

// lê os dados: { rows: [{...}], columns: [...] }
async function loadData(src, cwd) {
  if (!src) return { rows: [], columns: [] };
  if (Array.isArray(src)) return { rows: src, columns: [...new Set(src.flatMap((r) => Object.keys(r || {})))] };
  const spec = typeof src === 'string' ? { file: src } : src;
  if (spec.rows) return loadData(spec.rows, cwd);
  if (spec.file && !spec.sql) {
    // sem SQL: carrega o arquivo inteiro como tabela
    const { dataQuery } = require('./data');
    const alias = 'dados';
    spec.sql = `SELECT * FROM ${/\.(xlsx|xlsm)$/i.test(spec.file) && spec.sheet ? `${alias}_${spec.sheet}` : alias}`;
    spec.files = { [alias]: spec.file };
  }
  if (spec.sql) {
    const rows = await runSql(spec.files || (spec.file ? { dados: spec.file } : {}), spec.sql, cwd);
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
  }
  throw new Error('data: informe um arquivo ("vendas.csv"), { files, sql } ou uma lista de linhas.');
}

// executa SQL sobre os arquivos usando o mesmo carregador do data_query
async function runSql(files, sql, cwd) {
  const data = require('./data');
  const tmp = path.join(require('os').tmpdir(), `rf-dash-${process.pid}-${Date.now()}.json`);
  try {
    data.dataQuery({ files, sql, save: tmp }, cwd);
    return JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * spec: { title, subtitle, theme, data (fonte padrão), datasets: { nome: fonte }, filters: [coluna | { column, label }],
 *   widgets: [ { type: 'kpi'|'chart'|'table'|'text', title, dataset?, width?: 1-4, ... } ] }
 * kpi: { field, agg: sum|avg|count|min|max|distinct, format, target?, compare?: { field, agg } }
 * chart: { chart: bar|barh|stacked|line|area|pie|donut|scatter|funnel, x, y (campo ou [campos]), agg, series (campo que vira cores), sort, limit, format }
 * table: { columns?, group_by?, measures?: [{ field, agg, label }], sort, limit }
 * text: { markdown }
 */
async function createDashboard(file, spec = {}, cwd = process.cwd()) {
  const theme = THEMES[spec.theme] || THEMES.claro;
  const datasets = {};
  if (spec.data) datasets.default = await loadData(spec.data, cwd);
  for (const [name, src] of Object.entries(spec.datasets || {})) datasets[name] = await loadData(src, cwd);
  // o modelo nem sempre manda "type": deduz pelos campos e aceita sinônimos
  const TYPE_ALIAS = { metric: 'kpi', metrica: 'kpi', card: 'kpi', indicador: 'kpi', number: 'kpi', numero: 'kpi', grafico: 'chart', gráfico: 'chart', graph: 'chart', tabela: 'table', grid: 'table', texto: 'text', markdown: 'text', nota: 'text' };
  const CHART_KINDS = ['bar', 'barh', 'stacked', 'line', 'area', 'pie', 'donut', 'scatter', 'funnel'];
  const CHART_ALIAS = { barras: 'barh', colunas: 'bar', linha: 'line', pizza: 'pie', rosca: 'donut', empilhado: 'stacked', funil: 'funnel', column: 'bar', columns: 'bar', horizontal: 'barh' };
  const inferType = (w) => {
    let t = String(w.type || w.kind || '').toLowerCase();
    t = TYPE_ALIAS[t] || t;
    if (CHART_KINDS.includes(t) || CHART_ALIAS[t]) return { type: 'chart', chart: CHART_ALIAS[t] || t };
    if (['kpi', 'chart', 'table', 'text'].includes(t)) return { type: t };
    if (w.chart || w.chart_type) return { type: 'chart' };
    if (w.markdown || w.text) return { type: 'text' };
    if (w.columns || w.group_by || w.measures) return { type: 'table' };
    if (w.x) return { type: 'chart' };
    return { type: 'kpi' };
  };
  const widgets = (spec.widgets || []).map((raw, i) => {
    const w = { ...raw, ...inferType(raw) };
    if (w.type === 'chart') w.chart = CHART_ALIAS[w.chart || w.chart_type] || w.chart || w.chart_type || 'bar';
    return { id: `w${i}`, dataset: 'default', width: w.type === 'kpi' ? 1 : w.type === 'text' || w.type === 'table' ? 4 : 2, ...w };
  });
  if (!widgets.length) throw new Error('Informe widgets: indicadores (kpi), gráficos (chart), tabelas (table) ou textos (text).');
  for (const w of widgets) {
    if (w.type !== 'text' && !datasets[w.dataset]) throw new Error(`Widget "${w.title || w.id}": conjunto de dados "${w.dataset}" não existe. Informe data ou datasets.`);
    const cols = w.type === 'text' ? [] : datasets[w.dataset].columns;
    for (const f of [w.field, w.x, ...[].concat(w.y || []), w.series, w.group_by].filter(Boolean)) {
      if (cols.length && !cols.includes(f)) throw new Error(`Widget "${w.title || w.id}": a coluna "${f}" não existe. Colunas: ${cols.join(', ')}.`);
    }
  }
  const filters = (spec.filters || []).map((f) => (typeof f === 'string' ? { column: f, label: f } : { label: f.column, ...f }));
  const payload = { title: spec.title || 'Dashboard', subtitle: spec.subtitle || '', theme, widgets, filters, datasets: Object.fromEntries(Object.entries(datasets).map(([k, v]) => [k, v.rows])), generated: new Date().toISOString() };
  const html = renderHtml(payload);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return { widgets: widgets.length, rows: Object.values(datasets).reduce((a, d) => a + d.rows.length, 0), bytes: Buffer.byteLength(html) };
}

function renderHtml(p) {
  const t = p.theme;
  // JSON dentro de <script>: escapa "</" para não fechar a tag
  const data = JSON.stringify(p).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<style>
:root{--bg:${t.bg};--card:${t.card};--fg:${t.fg};--muted:${t.muted};--grid:${t.grid};--accent:${t.accent}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif}
header{padding:22px 28px 6px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between}
h1{margin:0;font-size:22px}.sub{color:var(--muted);margin-top:2px}
.actions button{background:var(--card);color:var(--fg);border:1px solid var(--grid);border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit}
.filters{display:flex;flex-wrap:wrap;gap:10px;padding:8px 28px 4px}
.filters label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:3px}
.filters select{min-width:150px;padding:6px 8px;border-radius:8px;border:1px solid var(--grid);background:var(--card);color:var(--fg);font:inherit}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;padding:14px 28px 28px}
.card{background:var(--card);border:1px solid var(--grid);border-radius:12px;padding:14px 16px;min-width:0;position:relative}
.card h3{margin:0 0 8px;font-size:13px;color:var(--muted);font-weight:600}
.w1{grid-column:span 1}.w2{grid-column:span 2}.w3{grid-column:span 3}.w4{grid-column:span 4}
@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.w3,.w4{grid-column:span 2}}
@media(max-width:620px){.grid{grid-template-columns:1fr;padding:12px}.w1,.w2,.w3,.w4{grid-column:span 1}header,.filters{padding-left:12px;padding-right:12px}}
.kpi .v{font-size:28px;font-weight:700;letter-spacing:-.5px}.kpi .d{font-size:13px;font-weight:600;margin-top:2px}.up{color:#16a34a}.down{color:#dc2626}
.kpi .t{font-size:12px;color:var(--muted)}
svg{display:block;width:100%;height:auto;overflow:visible}svg text{fill:var(--fg);font-size:11px}svg .m{fill:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted);margin-bottom:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.tip{position:fixed;pointer-events:none;background:var(--fg);color:var(--bg);padding:5px 8px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .1s;z-index:9;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:7px 8px;border-bottom:1px solid var(--grid);text-align:left}th{cursor:pointer;color:var(--muted);font-weight:600;user-select:none}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.tw{max-height:420px;overflow:auto}.search{width:100%;margin-bottom:8px;padding:6px 8px;border:1px solid var(--grid);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.md p{margin:.3em 0}.md ul{margin:.3em 0 .3em 1.2em;padding:0}footer{color:var(--muted);font-size:12px;padding:0 28px 22px}
@media print{.actions,.filters{display:none}.card{break-inside:avoid}}
</style></head><body>
<header><div><h1 id="t"></h1><div class="sub" id="s"></div></div><div class="actions"><button id="csv">Baixar dados (CSV)</button> <button onclick="print()">Imprimir / PDF</button></div></header>
<div class="filters" id="filters"></div><div class="grid" id="grid"></div>
<footer id="f"></footer><div class="tip" id="tip"></div>
<script>
const P=${data};
const NICE={regiao:'Região',mes:'Mês',ano:'Ano',canal:'Canal',produto:'Produto',cliente:'Cliente',categoria:'Categoria',status:'Status',receita:'Receita',custo:'Custo',pedidos:'Pedidos',vendedor:'Vendedor',cidade:'Cidade',estado:'Estado',data:'Data',valor:'Valor',quantidade:'Quantidade',preco:'Preço',margem:'Margem',lucro:'Lucro',meta:'Meta'};
const label=(c)=>NICE[String(c).toLowerCase()]||String(c).replace(/_/g,' ').replace(/^./,(x)=>x.toUpperCase());
const T=P.theme,state={};
const $=(s)=>document.querySelector(s);
const nf=(v,f)=>{if(v==null||isNaN(v))return'-';const n=Number(v);const d=f&&f.decimals!=null?f.decimals:(Math.abs(n)<100&&n%1?1:0);
  if(f&&(f.format==='percentual'||f.format==='pct'))return(n*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
  if(f&&f.format==='compacto'){const a=Math.abs(n);const [k,u]=a>=1e9?[1e9,' bi']:a>=1e6?[1e6,' mi']:a>=1e3?[1e3,' mil']:[1,''];return (f.prefix||'')+(n/k).toLocaleString('pt-BR',{maximumFractionDigits:1})+u+(f.suffix||'')}
  const s=n.toLocaleString('pt-BR',{minimumFractionDigits:f&&f.format==='moeda'?2:0,maximumFractionDigits:f&&f.format==='moeda'?2:d});
  return (n<0?'-':'')+(f&&f.format==='moeda'?'R$ ':(f&&f.prefix)||'')+s.replace(/^-/,'')+((f&&f.suffix)||'')};
const num=(v)=>typeof v==='number'?v:(v==null||v===''?NaN:Number(String(v).replace(/\\./g,'').replace(',','.')));
const AGG={sum:a=>a.reduce((s,v)=>s+(isNaN(v)?0:v),0),avg:a=>{const b=a.filter(v=>!isNaN(v));return b.length?b.reduce((s,v)=>s+v,0)/b.length:NaN},
  count:a=>a.length,min:a=>Math.min(...a.filter(v=>!isNaN(v))),max:a=>Math.max(...a.filter(v=>!isNaN(v))),distinct:a=>new Set(a).size};
AGG.soma=AGG.sum;AGG.media=AGG.avg;AGG.contagem=AGG.count;
function rows(ds){const r=P.datasets[ds||'default']||[];return r.filter(x=>P.filters.every(f=>!state[f.column]||String(x[f.column])===state[f.column]))}
function agg(list,field,how){how=how||'sum';const fn=AGG[how]||AGG.sum;return fn(how==='count'?list:how==='distinct'?list.map(r=>r[field]):list.map(r=>num(r[field])))}
function group(list,key){const m=new Map();for(const r of list){const k=r[key]==null||r[key]===''?'(vazio)':String(r[key]);if(!m.has(k))m.set(k,[]);m.get(k).push(r)}return m}
const tip=$('#tip');function showTip(e,text){tip.textContent=text;tip.style.opacity=1;tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px'}function hideTip(){tip.style.opacity=0}
const el=(tag,attrs,kids)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)n.setAttribute(k,attrs[k]);(kids||[]).forEach(c=>n.appendChild(c));return n};
const txt=(x,y,s,a)=>{const t=el('text',Object.assign({x,y},a||{}));t.textContent=s;return t};
function legend(names,colors){return '<div class="legend">'+names.map((n,i)=>'<span><i style="background:'+colors[i%colors.length]+'"></i>'+String(n).replace(/</g,'&lt;')+'</span>').join('')+'</div>'}
function sortKeys(keys,vals,w){if(w.sort==='desc')return keys.sort((a,b)=>vals(b)-vals(a));if(w.sort==='asc')return keys.sort((a,b)=>vals(a)-vals(b));if(w.sort==='x'||!w.sort){const allNum=keys.every(k=>!isNaN(Number(k)));return allNum?keys.sort((a,b)=>a-b):keys}return keys}

function chart(w,box){
  const list=rows(w.dataset),ys=[].concat(w.y||[]),C=T.palette,kind=w.chart||'bar';
  const W=560,H=w.height||(kind==='barh'?Math.min(320,Math.max(140,[...new Set(list.map(r=>r[w.x]))].slice(0,w.limit||99).length*34+30)):260),ml=kind==='barh'?110:48,mr=kind==='barh'?70:16,mt=10,mb=kind==='barh'?18:36,iw=W-ml-mr,ih=H-mt-mb;
  if(kind==='pie'||kind==='donut'||kind==='funnel'){
    const g=group(list,w.x);let keys=[...g.keys()];const val=k=>agg(g.get(k),ys[0],w.agg);keys=sortKeys(keys,val,Object.assign({sort:'desc'},w));if(w.limit)keys=keys.slice(0,w.limit);
    const tot=keys.reduce((s,k)=>s+val(k),0)||1;
    if(kind==='funnel'){const svg=el('svg',{viewBox:'0 0 '+W+' '+H});const rh=Math.min(44,ih/keys.length);const max=Math.max(...keys.map(val));
      keys.forEach((k,i)=>{const v=val(k),bw=(v/max)*(W-200),x=(W-120-bw)/2+10,y=mt+i*(rh+4);const r=el('rect',{x,y,width:Math.max(2,bw),height:rh,rx:4,fill:C[i%C.length]});
        r.onmousemove=e=>showTip(e,k+': '+nf(v,w)+(i?' ('+nf(v/val(keys[i-1]),{format:'pct'})+' da etapa anterior)':''));r.onmouseleave=hideTip;svg.appendChild(r);
        svg.appendChild(txt(W-100,y+rh/2+4,k+'  '+nf(v,w)))});box.appendChild(svg);return}
    const R=Math.min(H/2-10,120),cx=R+20,cy=H/2,svg=el('svg',{viewBox:'0 0 '+W+' '+H});let a0=-Math.PI/2;
    keys.forEach((k,i)=>{const v=val(k),a1=a0+v/tot*Math.PI*2,large=a1-a0>Math.PI?1:0,ri=kind==='donut'?R*0.58:0;
      const p=['M',cx+R*Math.cos(a0),cy+R*Math.sin(a0),'A',R,R,0,large,1,cx+R*Math.cos(a1),cy+R*Math.sin(a1),'L',cx+ri*Math.cos(a1),cy+ri*Math.sin(a1),ri?'A '+ri+' '+ri+' 0 '+large+' 0 '+(cx+ri*Math.cos(a0))+' '+(cy+ri*Math.sin(a0)):'','Z'].join(' ');
      const s=el('path',{d:p,fill:C[i%C.length],stroke:T.card,'stroke-width':2});s.onmousemove=e=>showTip(e,k+': '+nf(v,w)+' ('+(v/tot*100).toFixed(1).replace('.',',')+'%)');s.onmouseleave=hideTip;svg.appendChild(s);a0=a1});
    if(kind==='donut')svg.appendChild(txt(cx,cy+6,nf(tot,w),{'text-anchor':'middle','font-size':16,'font-weight':700}));
    keys.forEach((k,i)=>{const y=cy-keys.length*11+i*22+6;svg.appendChild(el('rect',{x:cx+R+30,y:y-9,width:10,height:10,rx:2,fill:C[i%C.length]}));svg.appendChild(txt(cx+R+46,y,k+'  '+(val(k)/tot*100).toFixed(0)+'%'))});
    box.appendChild(svg);return}
  if(kind==='scatter'){const svg=el('svg',{viewBox:'0 0 '+W+' '+H});const xs=list.map(r=>num(r[w.x])),yv=list.map(r=>num(r[ys[0]]));
    const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(0,...yv),ymax=Math.max(...yv);const sx=v=>ml+(v-xmin)/((xmax-xmin)||1)*iw,sy=v=>mt+ih-(v-ymin)/((ymax-ymin)||1)*ih;
    axes(svg,ymin,ymax,sy,W,ml,mr,w);list.forEach((r,i)=>{if(isNaN(xs[i])||isNaN(yv[i]))return;const c=el('circle',{cx:sx(xs[i]),cy:sy(yv[i]),r:4,fill:T.accent,'fill-opacity':.7});c.onmousemove=e=>showTip(e,(w.label?r[w.label]+': ':'')+w.x+' '+nf(xs[i])+', '+ys[0]+' '+nf(yv[i],w));c.onmouseleave=hideTip;svg.appendChild(c)});
    svg.appendChild(txt(ml+iw/2,H-6,w.x,{'text-anchor':'middle',class:'m'}));box.appendChild(svg);return}
  // barras, barras horizontais, empilhado, linha, área
  const g=group(list,w.x);let keys=[...g.keys()];
  let series;// [{name, val(k)}]
  if(w.series){const names=[...group(list,w.series).keys()];series=names.map(n=>({name:n,val:k=>agg(g.get(k).filter(r=>String(r[w.series])===n),ys[0],w.agg)}))}
  else series=ys.map(y=>({name:y,val:k=>agg(g.get(k),y,w.agg)}));
  const total=k=>series.reduce((s,se)=>s+(se.val(k)||0),0);
  keys=sortKeys(keys,total,w);if(w.limit)keys=keys.slice(0,w.limit);
  if(series.length>1)box.insertAdjacentHTML('beforeend',legend(series.map(s=>w.series?s.name:label(s.name)),C));
  const stacked=kind==='stacked';
  const vals=keys.flatMap(k=>stacked?[total(k)]:series.map(s=>s.val(k))).filter(v=>!isNaN(v));
  const rawMax=Math.max(0,...vals),rawMin=Math.min(0,...vals),st=nice(((rawMax-rawMin)||1)/4);
  const vmax=Math.ceil(rawMax/st)*st||st,vmin=Math.floor(rawMin/st)*st;
  const svg=el('svg',{viewBox:'0 0 '+W+' '+H});
  if(kind==='barh'){const rh=ih/keys.length,bh=Math.min(26,rh*0.7)/(stacked?1:series.length);const sx=v=>ml+(v-vmin)/((vmax-vmin)||1)*iw;
    keys.forEach((k,i)=>{svg.appendChild(txt(ml-6,mt+i*rh+rh/2+4,k.length>16?k.slice(0,15)+'…':k,{'text-anchor':'end'}));
      series.forEach((s,j)=>{const v=s.val(k);const y=mt+i*rh+(rh-bh*series.length)/2+j*bh;const r=el('rect',{x:sx(Math.min(0,v)),y,width:Math.max(1,Math.abs(sx(v)-sx(0))),height:bh*0.9,rx:3,fill:C[j%C.length]});
        r.onmousemove=e=>showTip(e,k+(series.length>1?' · '+s.name:'')+': '+nf(v,w));r.onmouseleave=hideTip;svg.appendChild(r);if(series.length===1)svg.appendChild(txt(sx(v)+4,y+bh*0.6,nf(v,w),{class:'m'}))})});
    box.appendChild(svg);return}
  const sy=v=>mt+ih-(v-vmin)/((vmax-vmin)||1)*ih;axes(svg,vmin,vmax,sy,W,ml,mr,w);
  const slot=iw/Math.max(1,keys.length),every=Math.ceil(keys.length/12);
  keys.forEach((k,i)=>{if(i%every===0)svg.appendChild(txt(ml+slot*i+slot/2,H-mb+16,k.length>12?k.slice(0,11)+'…':k,{'text-anchor':'middle',class:'m'}))});
  if(kind==='line'||kind==='area'){series.forEach((s,j)=>{const pts=keys.map((k,i)=>[ml+slot*i+slot/2,sy(s.val(k)||0)]);
      if(kind==='area')svg.appendChild(el('path',{d:'M'+pts[0][0]+','+sy(0)+' L'+pts.map(p=>p.join(',')).join(' L')+' L'+pts[pts.length-1][0]+','+sy(0)+' Z',fill:C[j%C.length],'fill-opacity':.15}));
      svg.appendChild(el('path',{d:'M'+pts.map(p=>p.join(',')).join(' L'),fill:'none',stroke:C[j%C.length],'stroke-width':2.5}));
      pts.forEach((p,i)=>{const c=el('circle',{cx:p[0],cy:p[1],r:keys.length>40?2:3.5,fill:C[j%C.length]});c.onmousemove=e=>showTip(e,keys[i]+(series.length>1?' · '+s.name:'')+': '+nf(s.val(keys[i]),w));c.onmouseleave=hideTip;svg.appendChild(c)})});
    box.appendChild(svg);return}
  const gw=slot*0.7,bw=stacked?gw:gw/series.length;
  keys.forEach((k,i)=>{let acc=0;series.forEach((s,j)=>{const v=s.val(k)||0;const x=ml+slot*i+(slot-gw)/2+(stacked?0:j*bw);const y0=stacked?sy(acc+v):sy(Math.max(0,v));const h=stacked?sy(acc)-sy(acc+v):Math.abs(sy(v)-sy(0));
    const r=el('rect',{x,y:y0,width:Math.max(1,bw*0.92),height:Math.max(1,h),rx:3,fill:C[j%C.length]});r.onmousemove=e=>showTip(e,k+(series.length>1?' · '+s.name:'')+': '+nf(v,w));r.onmouseleave=hideTip;svg.appendChild(r);acc+=v});
    if(keys.length<=14&&(series.length===1||stacked))svg.appendChild(txt(ml+slot*i+slot/2,sy(stacked?acc:series[0].val(k))-5,nf(stacked?acc:series[0].val(k),w),{'text-anchor':'middle','font-weight':600}))});
  box.appendChild(svg)}
function nice(max){if(max<=0)return 1;const p=Math.pow(10,Math.floor(Math.log10(max)));const f=max/p;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p}
function axes(svg,vmin,vmax,sy,W,ml,mr,w){const step=nice((vmax-vmin)/4)||1;for(let v=vmin;v<=vmax+step/1000;v+=step){const y=sy(v);svg.appendChild(el('line',{x1:ml,x2:W-mr,y1:y,y2:y,stroke:T.grid}));svg.appendChild(txt(ml-6,y+4,nf(v,Object.assign({},w,{format:w.format==='moeda'?'compacto':w.format,prefix:w.format==='moeda'?'R$ ':w.prefix})),{'text-anchor':'end',class:'m'}))}}

function kpi(w,box){const list=rows(w.dataset);const v=w.value!=null?num(w.value):agg(list,w.field,w.agg);
  let h='<div class="kpi"><div class="v">'+nf(v,w)+'</div>';
  if(w.target!=null){const r=v/num(w.target);h+='<div class="d '+(r>=1?'up':'down')+'">'+nf(r,{format:'pct'})+' da meta ('+nf(num(w.target),w)+')</div>'}
  if(w.compare){const base=agg(rows(w.compare.dataset||w.dataset),w.compare.field||w.field,w.compare.agg||w.agg);const d=(v-base)/(Math.abs(base)||1);const good=w.lower_is_better?d<=0:d>=0;h+='<div class="d '+(good?'up':'down')+'">'+(d>=0?'▲ ':'▼ ')+nf(Math.abs(d),{format:'pct'})+(w.compare.label?' '+w.compare.label:'')+'</div>'}
  if(w.note)h+='<div class="t">'+String(w.note).replace(/</g,'&lt;')+'</div>';box.insertAdjacentHTML('beforeend',h+'</div>')}

function table(w,box){let list=rows(w.dataset),cols;
  if(w.group_by){const g=group(list,w.group_by);const ms=w.measures||[];list=[...g.entries()].map(([k,rs])=>{const o={[w.group_by]:k};ms.forEach(m=>o[m.label||m.field+' ('+(m.agg||'sum')+')']=agg(rs,m.field,m.agg));return o});}
  cols=w.columns||Object.keys(list[0]||{});
  const isNum=c=>list.length&&list.every(r=>r[c]==null||r[c]===''||!isNaN(num(r[c])));
  let sortC=w.sort_by||null,dir=w.sort==='asc'?1:-1,q='';
  const wrap=document.createElement('div');if(list.length>10){const s=document.createElement('input');s.className='search';s.placeholder='Buscar...';s.oninput=()=>{q=s.value.toLowerCase();draw()};box.appendChild(s)}
  wrap.className='tw';box.appendChild(wrap);
  function draw(){let r=list.filter(x=>!q||cols.some(c=>String(x[c]??'').toLowerCase().includes(q)));if(sortC)r=[...r].sort((a,b)=>{const x=num(a[sortC]),y=num(b[sortC]);return (!isNaN(x)&&!isNaN(y)?x-y:String(a[sortC]).localeCompare(String(b[sortC])))*dir});
    r=r.slice(0,w.limit||500);
    wrap.innerHTML='<table><thead><tr>'+cols.map(c=>'<th class="'+(isNum(c)?'n':'')+'" data-c="'+c+'">'+label(c)+(sortC===c?(dir>0?' ▲':' ▼'):'')+'</th>').join('')+'</tr></thead><tbody>'+
      r.map(x=>'<tr>'+cols.map(c=>{const v=x[c];return '<td class="'+(isNum(c)?'n':'')+'">'+(isNum(c)&&v!==''&&v!=null?nf(num(v),(w.formats||{})[c]||w):String(v??'').replace(/</g,'&lt;'))+'</td>'}).join('')+'</tr>').join('')+'</tbody></table>';
    wrap.querySelectorAll('th').forEach(th=>th.onclick=()=>{const c=th.dataset.c;dir=sortC===c?-dir:-1;sortC=c;draw()})}
  draw()}

function md(s){return String(s||'').replace(/</g,'&lt;').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').split(/\\n{2,}/).map(b=>/^\\s*[-*] /m.test(b)?'<ul>'+b.split(/\\n/).filter(Boolean).map(l=>'<li>'+l.replace(/^\\s*[-*] /,'')+'</li>').join('')+'</ul>':'<p>'+b.replace(/\\n/g,'<br>')+'</p>').join('')}

function render(){const grid=$('#grid');grid.innerHTML='';for(const w of P.widgets){const c=document.createElement('div');c.className='card w'+Math.min(4,Math.max(1,w.width||2));
  if(w.title)c.insertAdjacentHTML('beforeend','<h3>'+String(w.title).replace(/</g,'&lt;')+'</h3>');
  try{if(w.type==='kpi')kpi(w,c);else if(w.type==='table')table(w,c);else if(w.type==='text')c.insertAdjacentHTML('beforeend','<div class="md">'+md(w.markdown||w.text)+'</div>');else chart(w,c)}catch(e){c.insertAdjacentHTML('beforeend','<div class="down">Erro: '+e.message+'</div>')}
  grid.appendChild(c)}}
function filters(){const box=$('#filters');for(const f of P.filters){const ds=P.datasets[f.dataset||'default']||[];const vals=[...new Set(ds.map(r=>r[f.column]).filter(v=>v!=null&&v!==''))].sort();
  const l=document.createElement('label');l.textContent=f.label===f.column?label(f.column):f.label;const s=document.createElement('select');s.innerHTML='<option value="">Todos</option>'+vals.map(v=>'<option>'+String(v).replace(/</g,'&lt;')+'</option>').join('');
  s.onchange=()=>{state[f.column]=s.value;render()};l.appendChild(s);box.appendChild(l)}}
$('#t').textContent=P.title;$('#s').textContent=P.subtitle;document.title=P.title;
$('#f').textContent='Gerado pelo rfcode em '+new Date(P.generated).toLocaleString('pt-BR')+'. Passe o mouse nos gráficos para ver os valores; clique no cabeçalho da tabela para ordenar.';
$('#csv').onclick=()=>{const r=rows('default');if(!r.length)return;const cols=Object.keys(r[0]);const q=v=>{const s=String(v??'');return /[;"\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const blob=new Blob(['\\ufeff'+[cols.join(';'),...r.map(x=>cols.map(c=>q(x[c])).join(';'))].join('\\r\\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(P.title||'dados')+'.csv';a.click()};
filters();render();
</script></body></html>`;
}

module.exports = { createDashboard, THEMES, renderHtml };
