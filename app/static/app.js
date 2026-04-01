const A='/api';
let STN=[],sel=null,map,popup,MK={},rCur='meteo',bCur='tide',searchQ='';
let timeRange='24h',trStart=null,trEnd=null,lastRightData=[];
const C=['#00ffaa','#00d4ff','#ff00aa','#ff8800','#ffcc00','#aa55ff','#ff3355','#55ffcc','#00ff55','#ff5500','#55aaff','#ff55aa'];

// ── MAP LAYERS ──
const LAYERS={
  Dark:['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png','© CartoDB © OSM'],
  Satellite:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}','© Esri'],
  Topo:['https://tile.opentopomap.org/{z}/{x}/{y}.png','© OpenTopoMap'],
  Light:['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png','© CartoDB © OSM'],
  Ocean:['https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}','© Esri'],
};
let curLayer='Dark';

// ── INIT ──
document.addEventListener('DOMContentLoaded',async()=>{
  initMap();buildLayerSw();
  await go();
  initWS();
  setInterval(go,60000); // fallback poll every 60s
});
async function go(){await Promise.all([loadNav(),loadStations(),loadRight()])}

// ── NAV ──
async function loadNav(){
  try{
    const[c,h]=await Promise.all([J('/counts'),J('/health')]);
    $('n_s').textContent=fmt(c.stations);$('n_m').textContent=fmt(c.meteo_observations);$('n_h').textContent=fmt(c.hydro_observations);
    const ok=h.db_pool==='connected'&&h.poller==='running';
    $('hd').className='dot'+(ok?'':' off');
  }catch(e){$('hd').className='dot off'}
}

// ── MAP ──
function initMap(){
  const L=LAYERS[curLayer];
  map=new maplibregl.Map({
    container:'map',
    style:{version:8,sources:{base:{type:'raster',tiles:[L[0]],tileSize:256,attribution:L[1]}},layers:[{id:'base',type:'raster',source:'base'}]},
    center:[10,35],zoom:3,attributionControl:false
  });
  map.addControl(new maplibregl.NavigationControl(),'top-right');
  map.addControl(new maplibregl.ScaleControl(),'bottom-left');
  popup=new maplibregl.Popup({closeButton:true,closeOnClick:true,offset:14,maxWidth:'240px'});
}

function buildLayerSw(){
  $('lsw').innerHTML=Object.keys(LAYERS).map(k=>`<button class="lbtn${k===curLayer?' on':''}" onclick="switchLayer('${k}')">${k}</button>`).join('');
}

function switchLayer(name){
  curLayer=name;
  const L=LAYERS[name];
  const src=map.getSource('base');
  if(src){src.setTiles([L[0]])}
  buildLayerSw();
}

function syncMK(){
  Object.keys(MK).forEach(k=>{if(!STN.find(s=>String(s.mmsi)===k)){MK[k].remove();delete MK[k]}});
  STN.forEach((s,i)=>{
    if(!s.lat||!s.lon)return;
    if(MK[s.mmsi]){MK[s.mmsi].setLngLat([s.lon,s.lat]);return}
    const el=document.createElement('div');
    const c=C[i%C.length];
    el.style.cssText=`width:12px;height:12px;border-radius:50%;background:${c};border:2px solid #080c14;box-shadow:0 0 10px ${c}80;cursor:pointer;transition:transform .15s;transform-origin:center center`;
    el.onmouseenter=()=>{el.style.transform='scale(1.8)';showPop(s)};
    el.onmouseleave=()=>{el.style.transform='scale(1)';popup.remove()};
    el.onclick=()=>pick(s.mmsi);
    MK[s.mmsi]=new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([s.lon,s.lat]).addTo(map);
  });
}

function showPop(s){
  popup.setLngLat([s.lon,s.lat]).setHTML(
    `<div class="pt">${s.mmsi}</div>`+
    `<div class="pr"><span class="l">Pos</span>${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}</div>`+
    `<div class="pr"><span class="l">Country</span>${s.country||'—'}</div>`
  ).addTo(map);
}

// ── STATIONS ──
async function loadStations(){
  try{STN=await J('/stations');renderList();syncMK()}catch(e){}
}

function filterList(){searchQ=$('search').value.toLowerCase();renderList()}

function renderList(){
  const f=STN.filter(s=>{
    if(!searchQ)return true;
    return String(s.mmsi).includes(searchQ)||(s.country||'').toLowerCase().includes(searchQ);
  });
  $('slist').innerHTML=f.length?f.map((s,i)=>{
    const ci=STN.indexOf(s);
    return `<div class="si${s.mmsi===sel?' on':''}" onclick="pick(${s.mmsi})">
      <div class="nm"><span style="color:${C[ci%C.length]}">${s.mmsi}</span><span class="fl">${s.country||'?'}</span></div>
      <div class="sub">${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}</div>
    </div>`;
  }).join(''):'<div class="empty">No match</div>';
}

async function pick(mmsi){
  sel=sel===mmsi?null:mmsi;
  renderList();
  // highlight marker — no map pan
  Object.entries(MK).forEach(([k,m])=>{
    const e=m.getElement();
    const on=Number(k)===sel;
    e.style.transform=on?'scale(2)':'scale(1)';
    e.style.zIndex=on?'10':'1';
    e.style.transformOrigin='center center';
  });
  if(sel)await loadDetail(sel);
  else $('sdet').classList.remove('show');
  await loadRight();
  if($('app').classList.contains('bot-open'))await loadBot();
}

async function loadDetail(mmsi){
  const el=$('sdet');
  try{
    const[m,h]=await Promise.all([J(`/meteo?mmsi=${mmsi}&limit=1`),J(`/hydro?mmsi=${mmsi}&limit=1`)]);
    let html='<div class="dt">Latest</div>';
    const a=m[0],b=h[0];
    if(a)html+=dr('Wind',`<span class="hi">${a.wspeed??'—'}</span> m/s`)+dr('Dir',`${a.wdir??'—'}°`)+dr('Time',ago(a.ts));
    if(b)html+=dr('Level',`<span style="color:var(--cyan)">${b.waterlevel??'—'}</span> m`)+dr('Sea',b.seastate??'—')+dr('Time',ago(b.ts));
    if(!a&&!b)html+='<div class="empty">No data</div>';
    el.innerHTML=html;el.classList.add('show');
  }catch(e){el.classList.remove('show')}
}
function dr(l,v){return`<div class="dr"><span class="l">${l}</span><span class="v">${v}</span></div>`}

// ── PANELS TOGGLE ──
function togPanel(w){
  const app=$('app'),cls='hide-'+w,btn=$(w==='left'?'bl':'br');
  app.classList.toggle(cls);btn.classList.toggle('on',!app.classList.contains(cls));
  setTimeout(()=>map.resize(),50);
}
function togBot(){
  const app=$('app');app.classList.toggle('bot-open');
  $('bb').classList.toggle('on',app.classList.contains('bot-open'));
  const bot=$('pbot');
  if(bot)bot.classList.remove('collapsed');
  if(app.classList.contains('bot-open'))loadBot();
  setTimeout(()=>map.resize(),50);
}
function toggleMob(w){
  const el=$(w==='left'?'pl':'pr');
  closeMob();
  el.classList.add('mob');
  $('mob-overlay').classList.add('show');
}
function closeMob(){
  document.querySelectorAll('.left,.right').forEach(p=>p.classList.remove('mob'));
  $('mob-overlay').classList.remove('show');
}

// ── TIME RANGE ──
function setRange(r){
  timeRange=r;
  document.querySelectorAll('.trpick .trbtn').forEach(b=>b.classList.toggle('on',b.textContent.trim().toLowerCase()===r));
  if(r==='custom'){
    trStart=$('tr-start').value?new Date($('tr-start').value).toISOString():null;
    trEnd=$('tr-end').value?new Date($('tr-end').value).toISOString():null;
  }else{trStart=null;trEnd=null}
  loadRight();
}
function trQuery(){
  if(timeRange==='all')return '';
  if(timeRange==='custom'){
    let q='';
    if(trStart)q+=`&start=${trStart}`;
    if(trEnd)q+=`&end=${trEnd}`;
    return q;
  }
  const ms={
    '1h':36e5,'6h':216e5,'24h':864e5,'7d':6048e5,'30d':2592e6
  }[timeRange]||864e5;
  return `&start=${new Date(Date.now()-ms).toISOString()}`;
}

// ── RIGHT ──
function rTab(t){rCur=t;document.querySelectorAll('.rtab').forEach(x=>x.classList.toggle('on',x.dataset.t===t));loadRight()}
async function loadRight(){
  const el=$('rc'),q=sel?`&mmsi=${sel}`:'',tq=trQuery();
  lastRightData=[];
  try{
    if(rCur==='meteo'){
      const d=await J(`/meteo?limit=500${q}${tq}`);
      lastRightData=d;
      $('einfo').textContent=d.length+' rows';
      el.innerHTML=d.length?`<table class="rt"><thead><tr><th>MMSI</th><th>Wind</th><th>Dir</th><th>When</th></tr></thead><tbody>${d.map(r=>`<tr><td>${r.mmsi}</td><td class="hi">${r.wspeed??'—'}</td><td>${r.wdir??'—'}°</td><td>${ago(r.ts)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No meteo data</div>';
    }else if(rCur==='hydro'){
      const d=await J(`/hydro?limit=500${q}${tq}`);
      lastRightData=d;
      $('einfo').textContent=d.length+' rows';
      el.innerHTML=d.length?`<table class="rt"><thead><tr><th>MMSI</th><th>Level</th><th>Sea</th><th>When</th></tr></thead><tbody>${d.map(r=>`<tr><td>${r.mmsi}</td><td class="hi">${r.waterlevel??'—'}</td><td>${r.seastate??'—'}</td><td>${ago(r.ts)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No hydro data</div>';
    }else{
      $('einfo').textContent='';
      try{const d=await J('/alerts');const ev=d.recent_events||[];
        lastRightData=ev;
        $('einfo').textContent=ev.length+' events';
        el.innerHTML=ev.length?`<table class="rt"><thead><tr><th>MMSI</th><th>Val</th><th>When</th></tr></thead><tbody>${ev.slice(0,50).map(e=>`<tr><td>${e.mmsi}</td><td style="color:var(--yellow)">${e.value?.toFixed(2)??'—'}</td><td>${ago(e.triggered_at)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No alerts</div>';
      }catch(e){el.innerHTML='<div class="empty">Alerts unavailable</div>'}
    }
  }catch(e){el.innerHTML='<div class="empty">Load failed</div>'}
}

// ── EXPORT ──
function exportData(fmt){
  if(!lastRightData.length)return;
  let content,mime,ext;
  if(fmt==='csv'){
    const keys=Object.keys(lastRightData[0]);
    content='\uFEFF'+keys.join(',')+'\n'+lastRightData.map(r=>keys.map(k=>{const v=r[k];return v==null?'':'"'+v+'"'}).join(',')).join('\n');
    mime='text/csv;charset=utf-8';ext='csv';
  }else{
    content=JSON.stringify(lastRightData,null,2);
    mime='application/json';ext='json';
  }
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type:mime}));
  a.download=`tidewatch_${rCur}_${new Date().toISOString().slice(0,10)}.${ext}`;
  a.click();URL.revokeObjectURL(a.href);
}

// ── BOTTOM ──
function bTab(t){bCur=t;document.querySelectorAll('[data-b]').forEach(x=>x.classList.toggle('on',x.dataset.b===t));loadBot()}
async function loadBot(){
  const el=$('bbd');
  if(bCur==='tide')await tidePlots(el);
  else if(bCur==='wind')await windRose(el);
  else await sysPanel(el);
}

// ── TIDE: separate chart per station ──
async function tidePlots(el){
  const list=(sel?STN.filter(s=>s.mmsi===sel):STN).slice(0,9);
  if(!list.length){el.innerHTML='<div class="empty">No stations</div>';return}
  const cols=Math.min(list.length,3);
  el.innerHTML=`<div class="cgrid" style="grid-template-columns:repeat(${cols},1fr)">${
    list.map((s,i)=>`<div class="cbox"><div class="ct" style="color:${C[STN.indexOf(s)%C.length]}">${s.mmsi} — ${s.country||'?'}</div><div class="cp" id="tc${i}"></div></div>`).join('')
  }</div>`;
  // small delay so DOM has layout dimensions
  await new Promise(r=>setTimeout(r,100));
  for(let i=0;i<list.length;i++){
    const s=list[i],c=C[STN.indexOf(s)%C.length],div=$('tc'+i);
    if(!div)continue;
    try{
      const d=await J(`/hydro?mmsi=${s.mmsi}&limit=1000${trQuery()}`);
      const wl=d.filter(r=>r.waterlevel!=null).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
      if(!wl.length){div.innerHTML='<div class="empty">No data</div>';continue}
      Plotly.newPlot(div,[{
        x:wl.map(r=>r.ts),y:wl.map(r=>r.waterlevel),
        mode:'lines',line:{color:c,width:2},fill:'tozeroy',fillcolor:c+'12'
      }],pLayout('m'),{responsive:true});
    }catch(e){div.innerHTML='<div class="empty">Error</div>'}
  }
}

// ── WIND ROSE: separate per station ──
async function windRose(el){
  const list=(sel?STN.filter(s=>s.mmsi===sel):STN).slice(0,9);
  if(!list.length){el.innerHTML='<div class="empty">No stations</div>';return}
  const cols=Math.min(list.length,3);
  el.innerHTML=`<div class="cgrid" style="grid-template-columns:repeat(${cols},1fr)">${
    list.map((s,i)=>`<div class="cbox"><div class="ct" style="color:${C[STN.indexOf(s)%C.length]}">${s.mmsi} — ${s.country||'?'}</div><div class="cp" id="wr${i}"></div></div>`).join('')
  }</div>`;
  await new Promise(r=>setTimeout(r,100));
  const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const bins=['0-2','2-5','5-10','10-20','20+'];
  const lims=[2,5,10,20,Infinity];
  const bclr=['#00ffaa30','#00ffaa70','#00ffaacc','#00d4ff','#ff00aa'];

  for(let i=0;i<list.length;i++){
    const s=list[i],div=$('wr'+i);
    if(!div)continue;
    try{
      const d=await J(`/meteo?mmsi=${s.mmsi}&limit=2000${trQuery()}`);
      const v=d.filter(r=>r.wdir!=null&&r.wspeed!=null);
      if(!v.length){div.innerHTML='<div class="empty">No wind data</div>';continue}
      const traces=bins.map((_,si)=>{
        const cnt=Array(16).fill(0);
        v.forEach(r=>{
          const di=Math.floor(((r.wdir+11.25)%360)/22.5);
          const ok=si===0?r.wspeed<lims[0]:si===bins.length-1?r.wspeed>=lims[si-1]:r.wspeed>=lims[si-1]&&r.wspeed<lims[si];
          if(ok)cnt[di]++;
        });
        return{r:cnt.map(c=>c/v.length*100),theta:dirs,name:bins[si]+' m/s',type:'barpolar',marker:{color:bclr[si],line:{color:'#080c14',width:.5}},opacity:.9};
      });
      Plotly.newPlot(div,traces,{
        paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:'#607090',size:10},
        polar:{bgcolor:'transparent',radialaxis:{gridcolor:'#1a2540',ticksuffix:'%',tickfont:{size:8}},angularaxis:{gridcolor:'#1a2540',direction:'clockwise',rotation:90}},
        legend:{font:{color:'#a0b4d0',size:9},bgcolor:'transparent',orientation:'h',y:-0.15},
        margin:{t:10,r:30,b:40,l:30},showlegend:true,barmode:'stack'
      },{responsive:true});
    }catch(e){div.innerHTML='<div class="empty">Error</div>'}
  }
}

// ── SYSTEM ──
async function sysPanel(el){
  try{
    const h=await J('/health');
    const srcs=(h.sources||[]).map(s=>typeof s==='string'?{url:s,interval:'?'}:s);
    el.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
      ${sc('Database',h.db_pool==='connected'?'● Connected':'● Down',h.db_pool==='connected')}
      ${sc('Poller',h.poller==='running'?'● Running':'● Stopped',h.poller==='running')}
      ${sc('WS Clients',h.ws_clients??0,true)}
      <div style="grid-column:1/-1;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:6px;font-weight:700">Sources</div>
        ${srcs.map(s=>`<div style="padding:3px 0;font-size:.78rem;color:var(--t2)">● ${s.url} <span style="color:var(--neon)">${s.interval}s</span></div>`).join('')}
      </div></div>`;
  }catch(e){el.innerHTML='<div class="empty">Unavailable</div>'}
}
function sc(t,v,ok){return`<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px"><div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:6px;font-weight:700">${t}</div><div style="font-size:1rem;font-weight:700;color:${ok?'var(--neon)':'var(--red)'}">${v}</div></div>`}

// ── PLOTLY LAYOUT HELPER ──
function pLayout(yTitle){
  return{paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:'#607090',size:10},
    xaxis:{gridcolor:'#1a2540',linecolor:'#1a2540'},yaxis:{gridcolor:'#1a2540',linecolor:'#1a2540',title:{text:yTitle,font:{size:10}}},
    margin:{t:8,r:8,b:35,l:45},showlegend:false};
}

// ── HELPERS ──
function $(s){return document.getElementById(s)}
async function J(p){const r=await fetch(A+p);if(!r.ok)throw new Error(r.status);return r.json()}
function fmt(n){return n==null?'—':Number(n).toLocaleString()}
function ago(ts){
  if(!ts)return'—';const ms=Date.now()-new Date(ts).getTime();
  if(ms<6e4)return'now';if(ms<36e5)return Math.floor(ms/6e4)+'m';
  if(ms<864e5)return Math.floor(ms/36e5)+'h';
  return new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}

// ── WEBSOCKET REAL-TIME ──
let _ws=null,_wsRetry=1;
function initWS(){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  _ws=new WebSocket(`${proto}//${location.host}/api/ws/live`);
  _ws.onopen=()=>{_wsRetry=1;logger('WS connected')};
  _ws.onmessage=e=>{
    try{
      const msg=JSON.parse(e.data);
      if(msg.type==='new_data'){
        logger(`Live: ${msg.count} new points`);
        // Refresh nav counts + right panel
        loadNav();loadRight();
        // Flash the health dot
        const dot=$('hd');if(dot){dot.style.boxShadow='0 0 20px rgba(0,255,170,.8)';setTimeout(()=>dot.style.boxShadow='',500)}
      }
    }catch(err){}
  };
  _ws.onclose=()=>{
    logger('WS disconnected, retry in '+_wsRetry+'s');
    setTimeout(()=>{_wsRetry=Math.min(_wsRetry*2,30);initWS()},_wsRetry*1000);
  };
  _ws.onerror=()=>_ws.close();
}
function logger(msg){if(typeof console!=='undefined')console.log('[TideWatch]',msg)}

// ── MOBILE BOTTOM SHEET SWIPE ──
(function(){
  let startY=0,startH=0;
  const handle=document.getElementById('bhandle');
  if(!handle)return;
  handle.addEventListener('touchstart',e=>{
    startY=e.touches[0].clientY;
    const bot=document.getElementById('pbot');
    startH=bot.getBoundingClientRect().height;
    bot.style.transition='none';
  });
  handle.addEventListener('touchmove',e=>{
    e.preventDefault();
    const dy=startY-e.touches[0].clientY;
    const bot=document.getElementById('pbot');
    const nh=Math.max(60,Math.min(window.innerHeight*.85,startH+dy));
    bot.style.maxHeight=nh+'px';
  },{passive:false});
  handle.addEventListener('touchend',()=>{
    const bot=document.getElementById('pbot');
    bot.style.transition='max-height .3s ease';
    const h=bot.getBoundingClientRect().height;
    if(h<120){
      bot.classList.add('collapsed');
    }else{
      bot.classList.remove('collapsed');
      bot.style.maxHeight=Math.min(h,window.innerHeight*.85)+'px';
    }
  });
})();
