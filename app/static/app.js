const A = '/api';
let STN = [], sel = null, map, popup, MK = {}, rCur = 'meteo', bCur = 'tide', searchQ = '';
let timeRange = '24h', trStart = null, trEnd = null, lastRightData = [];
const C = ['#00ffaa', '#00d4ff', '#ff00aa', '#ff8800', '#ffcc00', '#aa55ff', '#ff3355', '#55ffcc', '#00ff55', '#ff5500', '#55aaff', '#ff55aa'];

// ── MAP LAYERS ──
const LAYERS = {
  Dark: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png', '© CartoDB © OSM'],
  Satellite: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', '© Esri'],
  Topo: ['https://tile.opentopomap.org/{z}/{x}/{y}.png', '© OpenTopoMap'],
  Light: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png', '© CartoDB © OSM'],
  Ocean: ['https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', '© Esri'],
};
let curLayer = 'Dark';

// ── INIT ──
document.addEventListener('DOMContentLoaded', async () => {
  initMap(); buildLayerSw();
  await go();
  refreshNames();
  initWS();
  setInterval(go, 60000); // fallback poll every 60s
});
async function go() { await Promise.all([loadNav(), loadStations(), loadRight()]) }

// ── NAV ──
async function loadNav() {
  try {
    const [c, h] = await Promise.all([J('/counts'), J('/health')]);
    $('n_s').textContent = fmt(c.stations); $('n_m').textContent = fmt(c.meteo_observations); $('n_h').textContent = fmt(c.hydro_observations);
    const ok = h.db_pool === 'connected' && h.poller === 'running';
    $('hd').className = 'dot' + (ok ? '' : ' off');
  } catch (e) { $('hd').className = 'dot off' }
}

// ── MAP ──
function initMap() {
  const L = LAYERS[curLayer];
  map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: { base: { type: 'raster', tiles: [L[0]], tileSize: 256, attribution: L[1] } }, layers: [{ id: 'base', type: 'raster', source: 'base' }] },
    center: [10, 35], zoom: 3, attributionControl: false
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '240px' });
}

function buildLayerSw() {
  $('lsw').innerHTML = Object.keys(LAYERS).map(k => `<button class="lbtn${k === curLayer ? ' on' : ''}" onclick="switchLayer('${k}')">${k}</button>`).join('');
}

function switchLayer(name) {
  curLayer = name;
  const L = LAYERS[name];
  const src = map.getSource('base');
  if (src) { src.setTiles([L[0]]) }
  buildLayerSw();
}

function syncMK() {
  Object.keys(MK).forEach(k => { if (!STN.find(s => String(s.mmsi) === k)) { MK[k].remove(); delete MK[k] } });
  STN.forEach((s, i) => {
    if (!s.lat || !s.lon) return;
    if (MK[s.mmsi]) { MK[s.mmsi].setLngLat([s.lon, s.lat]); return }
    const c = C[i % C.length];
    const fresh = freshness(s);
    // Outer wrapper: fixed size, centers the dot inside
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer';
    // Inner dot with heartbeat based on freshness
    const dot = document.createElement('div');
    const opacity = fresh === 'dead' ? '0.3' : fresh === 'stale' ? '0.6' : '1';
    const anim = fresh === 'fresh' ? 'animation:mk-pulse 2s ease-in-out infinite;' : fresh === 'stale' ? 'animation:mk-pulse 4s ease-in-out infinite;' : '';
    dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c};border:2px solid #080c14;box-shadow:0 0 10px ${c}80;opacity:${opacity};transition:width .15s,height .15s;${anim}`;
    wrap.appendChild(dot);
    wrap.onmouseenter = () => { dot.style.width = '18px'; dot.style.height = '18px'; dot.style.boxShadow = `0 0 18px ${c}`; showPop(s) };
    wrap.onmouseleave = () => { dot.style.width = '12px'; dot.style.height = '12px'; dot.style.boxShadow = `0 0 10px ${c}80`; popup.remove() };
    wrap.onclick = () => pick(s.mmsi);
    wrap._dot = dot; wrap._color = c;
    MK[s.mmsi] = new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map);
  });
}

function showPop(s) {
  const nm = sname(s);
  const recs = (s.meteo_count || 0) + (s.hydro_count || 0);
  const icons = (s.has_hydro ? '🌊' : '') + ' ' + (s.has_meteo ? '💨' : '');
  popup.setLngLat([s.lon, s.lat]).setHTML(
    `<div class="pt">${flag(s.country)} ${nm || s.mmsi}</div>` +
    (nm ? `<div class="pr"><span class="l">MMSI</span>${s.mmsi}</div>` : '') +
    `<div class="pr"><span class="l">Pos</span>${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}</div>` +
    `<div class="pr"><span class="l">Data</span>${icons}</div>` +
    `<div class="pr"><span class="l">Records</span>${recs.toLocaleString()}</div>`
  ).addTo(map);
}

// ── STATIONS ──
async function loadStations() {
  try { STN = await J('/stations'); renderList(); syncMK() } catch (e) { }
}

function filterList() { searchQ = $('search').value.toLowerCase(); renderList() }

// Station names — shipname from AIS, fallback to geocoded location
const NAMES = {
  '2242115': 'A Coruña', '2300057': 'Helsinki', '2300059': 'Rauma',
  '2655619': 'Stockholm', '2766100': 'Pärnu', '2766140': 'Pärnu',
  '3160011': 'Juan de Fuca', '3160029': 'Kingston',
  '992351272': 'Grimsby', '992351273': 'Brough', '992351274': 'Spurn',
  '992351275': 'Sunk Dredged Channel', '992351276': 'Immingham',
  '992351279': 'South Ferriby', '992351280': 'Humber Bridge',
  '992351281': 'Humber Sea Terminal', '992351282': 'West Walker Dykes',
  '992351283': 'Blacktoft', '992351284': 'King George Dock',
  '992351285': 'Keadby', '992351286': 'North Shields',
  '992351287': 'Flixborough', '992351288': 'Goole Docks',
  '992351289': 'Burton Stather', '992351312': 'Stone Creek',
  '992501017': 'Kish Lighthouse', '992501018': 'South Burford',
  '992501295': 'Dún Laoghaire', '992501301': 'Dublin Bay Buoy',
  '995741977': 'Lạch Huyện Meteo', '995741986': 'Đình Vũ',
};
function sname(s) { return NAMES[String(s.mmsi)] || '' }

// Curated names take priority over AIS-reported shipnames
const _STATIC_NAMES = Object.assign({}, NAMES);
// Fetch live station names from AIS and merge (only fills gaps, never overrides curated)
async function refreshNames() {
  try {
    const live = await J('/station-names');
    for (const [k, v] of Object.entries(live)) { if (v && !_STATIC_NAMES[k]) NAMES[k] = v }
    renderList(); // re-render with updated names
  } catch (e) { }
}

// Country → ISO 3166-1 alpha-2 for flag-icons CSS
const CC = {
  'Vietnam': 'vn', 'United Kingdom': 'gb', 'Finland': 'fi', 'Sweden': 'se',
  'Ireland': 'ie', 'Canada': 'ca', 'Spain': 'es', 'Estonia': 'ee',
  'Norway': 'no', 'Denmark': 'dk', 'Germany': 'de', 'France': 'fr',
  'Netherlands': 'nl', 'Belgium': 'be', 'Portugal': 'pt', 'Italy': 'it',
  'Greece': 'gr', 'Poland': 'pl', 'Latvia': 'lv', 'Lithuania': 'lt',
  'Russia': 'ru', 'China': 'cn', 'Japan': 'jp', 'South Korea': 'kr',
  'Australia': 'au', 'New Zealand': 'nz', 'USA': 'us', 'Brazil': 'br',
  'India': 'in', 'Thailand': 'th', 'Philippines': 'ph', 'Singapore': 'sg',
  'Malaysia': 'my', 'Indonesia': 'id', 'Turkey': 'tr', 'Croatia': 'hr',
};
function flag(c) { const code = CC[c]; return code ? `<span class="fi fi-${code}" style="font-size:.9rem"></span>` : '🏳️' }

function renderList() {
  const f = STN.filter(s => {
    if (!searchQ) return true;
    return String(s.mmsi).includes(searchQ) || (s.country || '').toLowerCase().includes(searchQ) || sname(s).toLowerCase().includes(searchQ);
  });
  $('slist').innerHTML = f.length ? f.map((s, i) => {
    const ci = STN.indexOf(s);
    const icons = (s.has_hydro ? '<span title="Water level" style="color:var(--cyan)">🌊</span>' : '') +
      (s.has_meteo ? '<span title="Wind data" style="color:var(--neon)">💨</span>' : '');
    const nm = sname(s);
    const recs = (s.meteo_count || 0) + (s.hydro_count || 0);
    const fresh = freshness(s);
    const faint = fresh === 'dead' ? ' faint' : '';
    return `<div class="si${s.mmsi === sel ? ' on' : ''}${faint}" onclick="pick(${s.mmsi})">
      <div class="nm"><span class="sdot ${fresh}"></span>${flag(s.country)} <span style="color:${C[ci % C.length]}">${nm || s.mmsi}</span><span class="fl">${icons || '—'}</span></div>
      <div class="sub">${nm ? s.mmsi + ' · ' : ''}${s.country || '?'} · ${recs.toLocaleString()} rec</div>
    </div>`;
  }).join('') : '<div class="empty">No match</div>';
}

function freshness(s) {
  const ts = s.last_hydro_ts || s.last_meteo_ts;
  if (!ts) return 'dead';
  const age = Date.now() - new Date(ts).getTime();
  if (age < 600000) return 'fresh';   // <10min
  if (age < 3600000) return 'stale';  // <1h
  return 'dead';
}

async function pick(mmsi) {
  sel = sel === mmsi ? null : mmsi;
  renderList();
  // highlight marker — no map pan
  Object.entries(MK).forEach(([k, m]) => {
    const wrap = m.getElement();
    const dot = wrap._dot, c = wrap._color;
    const on = Number(k) === sel;
    if (dot) {
      dot.style.width = on ? '20px' : '12px';
      dot.style.height = on ? '20px' : '12px';
      dot.style.boxShadow = on ? `0 0 22px ${c}` : `0 0 10px ${c}80`;
    }
    wrap.style.zIndex = on ? '10' : '1';
  });
  if (sel) await loadDetail(sel);
  else $('sdet').classList.remove('show');
  updateCC();
  await loadRight();
  if ($('app').classList.contains('bot-open')) await loadBot();
}

// ── CURRENT CONDITIONS BAR ──
async function updateCC() {
  const app = $('app'), bar = $('ccbar');
  if (!sel) { app.classList.remove('has-cc'); return }
  const s = STN.find(x => x.mmsi === sel);
  if (!s) { app.classList.remove('has-cc'); return }
  try {
    const [m, h] = await Promise.all([J(`/meteo?mmsi=${sel}&limit=2`), J(`/hydro?mmsi=${sel}&limit=2`)]);
    const a = m[0], b = h[0];
    if (!a && !b) { app.classList.remove('has-cc'); return }
    const trend = b && h[1] ? (b.waterlevel > h[1].waterlevel ? '<span class="cc-trend" style="color:var(--neon)">▲</span>' : '<span class="cc-trend" style="color:var(--red)">▼</span>') : '';
    const lastTs = b?.ts || a?.ts;
    bar.innerHTML = `
      <span class="cc-name">${flag(s.country)} ${sname(s) || s.mmsi}</span>
      ${b ? `<div class="cc-item"><div class="cc-val" style="color:var(--cyan)">${b.waterlevel ?? '—'}${trend}</div><div class="cc-lbl">Water Level (m)</div></div>` : ''}
      ${a ? `<div class="cc-item"><div class="cc-val" style="color:var(--neon)">${a.wspeed ?? '—'}</div><div class="cc-lbl">Wind (m/s)</div></div>` : ''}
      ${a ? `<div class="cc-item"><div class="cc-val">${a.wdir ?? '—'}°</div><div class="cc-lbl">Direction</div></div>` : ''}
      <span class="cc-age">${ago(lastTs)}</span>
      <button class="cc-close" onclick="clearCC()">✕</button>`;
    app.classList.add('has-cc');
    setTimeout(() => map.resize(), 50);
  } catch (e) { app.classList.remove('has-cc') }
}
function clearCC() { sel = null; $('app').classList.remove('has-cc'); renderList(); $('sdet').classList.remove('show'); setTimeout(() => map.resize(), 50) }

async function loadDetail(mmsi) {
  const el = $('sdet');
  try {
    const [m, h] = await Promise.all([J(`/meteo?mmsi=${mmsi}&limit=1`), J(`/hydro?mmsi=${mmsi}&limit=1`)]);
    let html = '<div class="dt">Latest</div>';
    const a = m[0], b = h[0];
    if (a) html += dr('Wind', `<span class="hi">${a.wspeed ?? '—'}</span> m/s`) + dr('Dir', `${a.wdir ?? '—'}°`) + dr('Time', ago(a.ts));
    if (b) html += dr('Level', `<span style="color:var(--cyan)">${b.waterlevel ?? '—'}</span> m`) + dr('Sea', b.seastate ?? '—') + dr('Time', ago(b.ts));
    if (!a && !b) html += '<div class="empty">No data</div>';
    el.innerHTML = html; el.classList.add('show');
  } catch (e) { el.classList.remove('show') }
}
function dr(l, v) { return `<div class="dr"><span class="l">${l}</span><span class="v">${v}</span></div>` }

// ── PANELS TOGGLE ──
function togPanel(w) {
  const app = $('app'), cls = 'hide-' + w, btn = $(w === 'left' ? 'bl' : 'br');
  app.classList.toggle(cls); btn.classList.toggle('on', !app.classList.contains(cls));
  setTimeout(() => map.resize(), 50);
}
function togBot() {
  const app = $('app'); app.classList.toggle('bot-open');
  $('bb').classList.toggle('on', app.classList.contains('bot-open'));
  const bot = $('pbot');
  if (bot) bot.classList.remove('collapsed');
  if (app.classList.contains('bot-open')) loadBot();
  setTimeout(() => map.resize(), 50);
}
function toggleMob(w) {
  const el = $(w === 'left' ? 'pl' : 'pr');
  closeMob();
  el.classList.add('mob');
  $('mob-overlay').classList.add('show');
}
function closeMob() {
  document.querySelectorAll('.left,.right').forEach(p => p.classList.remove('mob'));
  $('mob-overlay').classList.remove('show');
}

// ── TIME RANGE ──
function setRange(r) {
  timeRange = r;
  document.querySelectorAll('.trpick .trbtn').forEach(b => b.classList.toggle('on', b.textContent.trim().toLowerCase() === r));
  if (r === 'custom') {
    trStart = $('tr-start').value ? new Date($('tr-start').value).toISOString() : null;
    trEnd = $('tr-end').value ? new Date($('tr-end').value).toISOString() : null;
  } else { trStart = null; trEnd = null }
  loadRight();
}
function trQuery() {
  if (timeRange === 'all') return '';
  if (timeRange === 'custom') {
    let q = '';
    if (trStart) q += `&start=${trStart}`;
    if (trEnd) q += `&end=${trEnd}`;
    return q;
  }
  const ms = {
    '1h': 36e5, '6h': 216e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6
  }[timeRange] || 864e5;
  return `&start=${new Date(Date.now() - ms).toISOString()}`;
}

// ── RIGHT ──
function rTab(t) { rCur = t; document.querySelectorAll('.rtab').forEach(x => x.classList.toggle('on', x.dataset.t === t)); loadRight() }
async function loadRight() {
  const el = $('rc'), q = sel ? `&mmsi=${sel}` : '', tq = trQuery();
  lastRightData = [];
  try {
    if (rCur === 'meteo') {
      const d = await J(`/meteo?limit=500${q}${tq}`);
      lastRightData = d;
      $('einfo').textContent = d.length + ' rows';
      el.innerHTML = d.length ? `<table class="rt"><thead><tr><th>MMSI</th><th>Wind</th><th>Dir</th><th>When</th></tr></thead><tbody>${d.map(r => `<tr><td>${r.mmsi}</td><td class="hi">${r.wspeed ?? '—'}</td><td>${r.wdir ?? '—'}°</td><td>${ago(r.ts)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No meteo data</div>';
    } else if (rCur === 'hydro') {
      const d = await J(`/hydro?limit=500${q}${tq}`);
      lastRightData = d;
      $('einfo').textContent = d.length + ' rows';
      el.innerHTML = d.length ? `<table class="rt"><thead><tr><th>MMSI</th><th>Level</th><th>Sea</th><th>When</th></tr></thead><tbody>${d.map(r => `<tr><td>${r.mmsi}</td><td class="hi">${r.waterlevel ?? '—'}</td><td>${r.seastate ?? '—'}</td><td>${ago(r.ts)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No hydro data</div>';
    } else if (rCur === 'alerts') {
      $('einfo').textContent = '';
      try {
        const d = await J('/alerts'); const ev = d.recent_events || []; const al = d.alerts || [];
        lastRightData = ev;
        $('einfo').textContent = ev.length + ' events';
        let html = `<div class="aform">
          <select id="af-field"><option value="waterlevel">Water Level</option><option value="wspeed">Wind Speed</option></select>
          <select id="af-op"><option value=">">&gt;</option><option value="<">&lt;</option><option value=">=">&gt;=</option><option value="<=">&lt;=</option></select>
          <input id="af-val" type="number" step="0.1" placeholder="Threshold">
          <button class="abtn" onclick="createAlert()">+ Create Alert${sel ? ' for ' + sel : ''}</button>
        </div>`;
        if (al.length) html += al.map(a => `<div class="alert-item"><span>${a.mmsi || 'All'} ${a.field} ${a.operator} ${a.threshold}</span><button class="alert-del" onclick="delAlert(${a.id})">✕</button></div>`).join('');
        if (ev.length) html += `<div style="padding:8px 12px;font-size:.68rem;color:var(--t3);text-transform:uppercase;border-bottom:1px solid var(--border)">Recent Events</div>` +
          ev.slice(0, 30).map(e => `<div class="alert-item"><span>${e.mmsi} = ${e.value?.toFixed(2) ?? '—'}</span><span style="color:var(--t3)">${ago(e.triggered_at)}</span></div>`).join('');
        el.innerHTML = html || '<div class="empty">No alerts</div>';
      } catch (e) { el.innerHTML = '<div class="empty">Alerts unavailable</div>' }
    } else if (rCur === 'virtual') {
      await showVirtualUI(); return;
    }
  } catch (e) { el.innerHTML = '<div class="empty">Load failed</div>' }
}

// ── EXPORT ──
function exportData(fmt) {
  if (!lastRightData.length) return;
  let content, mime, ext;
  if (fmt === 'csv') {
    const keys = Object.keys(lastRightData[0]);
    content = '\uFEFF' + keys.join(',') + '\n' + lastRightData.map(r => keys.map(k => { const v = r[k]; return v == null ? '' : '"' + v + '"' }).join(',')).join('\n');
    mime = 'text/csv;charset=utf-8'; ext = 'csv';
  } else {
    content = JSON.stringify(lastRightData, null, 2);
    mime = 'application/json'; ext = 'json';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = `tidewatch_${rCur}_${new Date().toISOString().slice(0, 10)}.${ext}`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ── ALERTS CRUD ──
async function createAlert() {
  const field = $('af-field').value, op = $('af-op').value, val = $('af-val').value;
  if (!val) return;
  const q = `?field=${field}&operator=${encodeURIComponent(op)}&threshold=${val}${sel ? '&mmsi=' + sel : ''}`;
  try { await fetch(A + '/alerts' + q, { method: 'POST' }); rTab('alerts') } catch (e) { }
}
async function delAlert(id) {
  try { await fetch(A + '/alerts/' + id, { method: 'DELETE' }); rTab('alerts') } catch (e) { }
}

// ── BOTTOM ──
function bTab(t) { bCur = t; document.querySelectorAll('[data-b]').forEach(x => x.classList.toggle('on', x.dataset.b === t)); loadBot() }
async function loadBot() {
  const el = $('bbd');
  if (bCur === 'tide') await tidePlots(el);
  else if (bCur === 'wind') await windRose(el);
  else if (bCur === 'table') await tideTable(el);
  else if (bCur === 'overlay') await dayOverlay(el);
  else if (bCur === 'predict') await predictPanel(el);
  else await sysPanel(el);
}

// ── TIDE: separate chart per station ──
async function tidePlots(el) {
  const list = (sel ? STN.filter(s => s.mmsi === sel) : STN).slice(0, 9);
  if (!list.length) { el.innerHTML = '<div class="empty">No stations</div>'; return }
  const cols = Math.min(list.length, 3);
  el.innerHTML = `<div class="cgrid" style="grid-template-columns:repeat(${cols},1fr)">${list.map((s, i) => `<div class="cbox"><div class="ct" style="color:${C[STN.indexOf(s) % C.length]}">${sname(s) || s.mmsi} — ${s.country || '?'}</div><div class="cp" id="tc${i}"></div></div>`).join('')
    }</div>`;
  // small delay so DOM has layout dimensions
  await new Promise(r => setTimeout(r, 100));
  for (let i = 0; i < list.length; i++) {
    const s = list[i], c = C[STN.indexOf(s) % C.length], div = $('tc' + i);
    if (!div) continue;
    try {
      const d = await J(`/hydro?mmsi=${s.mmsi}&limit=1000${trQuery()}`);
      const wl = d.filter(r => r.waterlevel != null).sort((a, b) => new Date(a.ts) - new Date(b.ts));
      if (!wl.length) { div.innerHTML = '<div class="empty">No data</div>'; continue }
      Plotly.newPlot(div, [{
        x: wl.map(r => r.ts), y: wl.map(r => r.waterlevel),
        mode: 'lines', line: { color: c, width: 2 }, fill: 'tozeroy', fillcolor: c + '12'
      }], pLayout('m'), { responsive: true });
    } catch (e) { div.innerHTML = '<div class="empty">Error</div>' }
  }
}

// ── WIND ROSE: separate per station ──
async function windRose(el) {
  const list = (sel ? STN.filter(s => s.mmsi === sel) : STN).slice(0, 9);
  if (!list.length) { el.innerHTML = '<div class="empty">No stations</div>'; return }
  const cols = Math.min(list.length, 3);
  el.innerHTML = `<div class="cgrid" style="grid-template-columns:repeat(${cols},1fr)">${list.map((s, i) => `<div class="cbox"><div class="ct" style="color:${C[STN.indexOf(s) % C.length]}">${sname(s) || s.mmsi} — ${s.country || '?'}</div><div class="cp" id="wr${i}"></div></div>`).join('')
    }</div>`;
  await new Promise(r => setTimeout(r, 100));
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const bins = ['0-2', '2-5', '5-10', '10-20', '20+'];
  const lims = [2, 5, 10, 20, Infinity];
  const bclr = ['#00ffaa30', '#00ffaa70', '#00ffaacc', '#00d4ff', '#ff00aa'];

  for (let i = 0; i < list.length; i++) {
    const s = list[i], div = $('wr' + i);
    if (!div) continue;
    try {
      const d = await J(`/meteo?mmsi=${s.mmsi}&limit=2000${trQuery()}`);
      const v = d.filter(r => r.wdir != null && r.wspeed != null);
      if (!v.length) { div.innerHTML = '<div class="empty">No wind data</div>'; continue }
      const traces = bins.map((_, si) => {
        const cnt = Array(16).fill(0);
        v.forEach(r => {
          const di = Math.floor(((r.wdir + 11.25) % 360) / 22.5);
          const ok = si === 0 ? r.wspeed < lims[0] : si === bins.length - 1 ? r.wspeed >= lims[si - 1] : r.wspeed >= lims[si - 1] && r.wspeed < lims[si];
          if (ok) cnt[di]++;
        });
        return { r: cnt.map(c => c / v.length * 100), theta: dirs, name: bins[si] + ' m/s', type: 'barpolar', marker: { color: bclr[si], line: { color: '#080c14', width: .5 } }, opacity: .9 };
      });
      Plotly.newPlot(div, traces, {
        paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: '#607090', size: 10 },
        polar: { bgcolor: 'transparent', radialaxis: { gridcolor: '#1a2540', ticksuffix: '%', tickfont: { size: 8 } }, angularaxis: { gridcolor: '#1a2540', direction: 'clockwise', rotation: 90 } },
        legend: { font: { color: '#a0b4d0', size: 9 }, bgcolor: 'transparent', orientation: 'h', y: -0.15 },
        margin: { t: 10, r: 30, b: 40, l: 30 }, showlegend: true, barmode: 'stack'
      }, { responsive: true });
    } catch (e) { div.innerHTML = '<div class="empty">Error</div>' }
  }
}

// ── TIDE TABLE: high/low water detection ──
async function tideTable(el) {
  const list = (sel ? STN.filter(s => s.mmsi === sel) : STN.filter(s => s.has_hydro)).slice(0, 6);
  if (!list.length) { el.innerHTML = '<div class="empty">Select a station with hydro data</div>'; return }
  let html = '<div style="overflow:auto;padding:4px"><table class="rt" style="font-size:.8rem"><thead><tr><th>Station</th><th>Date</th><th>High Water</th><th>HW Time</th><th>Low Water</th><th>LW Time</th></tr></thead><tbody>';
  for (const s of list) {
    try {
      const d = await J(`/hydro?mmsi=${s.mmsi}&limit=2000${trQuery()}`);
      const pts = d.filter(r => r.waterlevel != null).sort((a, b) => new Date(a.ts) - new Date(b.ts));
      if (pts.length < 3) continue;
      const extremes = findExtremes(pts);
      const byDay = {};
      extremes.forEach(e => {
        const day = e.ts.slice(0, 10);
        if (!byDay[day]) byDay[day] = { hw: null, lw: null };
        if (e.type === 'high' && (!byDay[day].hw || e.val > byDay[day].hw.val)) byDay[day].hw = e;
        if (e.type === 'low' && (!byDay[day].lw || e.val < byDay[day].lw.val)) byDay[day].lw = e;
      });
      const nm = sname(s) || s.mmsi;
      Object.entries(byDay).sort().reverse().slice(0, 7).forEach(([day, v]) => {
        html += `<tr><td>${nm}</td><td>${day}</td>`;
        html += v.hw ? `<td class="hi">${v.hw.val.toFixed(2)}m</td><td>${v.hw.ts.slice(11, 16)}</td>` : '<td>—</td><td>—</td>';
        html += v.lw ? `<td style="color:var(--cyan)">${v.lw.val.toFixed(2)}m</td><td>${v.lw.ts.slice(11, 16)}</td>` : '<td>—</td><td>—</td>';
        html += '</tr>';
      });
    } catch (e) { }
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

function findExtremes(pts) {
  const ex = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1].waterlevel, cur = pts[i].waterlevel, next = pts[i + 1].waterlevel;
    if (cur > prev && cur > next) ex.push({ type: 'high', val: cur, ts: pts[i].ts });
    if (cur < prev && cur < next) ex.push({ type: 'low', val: cur, ts: pts[i].ts });
  }
  return ex;
}

// ── DAY OVERLAY: today vs yesterday vs 2 days ago ──
async function dayOverlay(el) {
  const list = sel ? STN.filter(s => s.mmsi === sel) : STN.filter(s => s.has_hydro).slice(0, 3);
  if (!list.length) { el.innerHTML = '<div class="empty">Select a station with hydro data</div>'; return }
  const cols = Math.min(list.length, 3);
  el.innerHTML = `<div class="cgrid" style="grid-template-columns:repeat(${cols},1fr)">${list.map((s, i) => `<div class="cbox"><div class="ct" style="color:${C[STN.indexOf(s) % C.length]}">${sname(s) || s.mmsi} — Day Overlay</div><div class="cp" id="ov${i}"></div></div>`).join('')
    }</div>`;
  await new Promise(r => setTimeout(r, 100));
  const colors = ['#00ffaa', '#00d4ff80', '#ff00aa60'];
  const labels = ['Today', 'Yesterday', '2 days ago'];
  for (let i = 0; i < list.length; i++) {
    const s = list[i], div = $('ov' + i);
    if (!div) continue;
    try {
      const d = await J(`/hydro?mmsi=${s.mmsi}&limit=5000`);
      const pts = d.filter(r => r.waterlevel != null).sort((a, b) => new Date(a.ts) - new Date(b.ts));
      const now = new Date();
      const traces = [0, 1, 2].map((daysAgo, ti) => {
        const dayStart = new Date(now); dayStart.setDate(dayStart.getDate() - daysAgo); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
        const dayPts = pts.filter(p => { const t = new Date(p.ts); return t >= dayStart && t < dayEnd });
        return {
          x: dayPts.map(p => { const t = new Date(p.ts); return t.getHours() + t.getMinutes() / 60 }),
          y: dayPts.map(p => p.waterlevel),
          mode: 'lines', name: labels[ti], line: { color: colors[ti], width: ti === 0 ? 2 : 1.5 }
        };
      }).filter(t => t.x.length > 0);
      if (!traces.length) { div.innerHTML = '<div class="empty">Not enough data</div>'; continue }
      Plotly.newPlot(div, traces, { ...pLayout('m'), xaxis: { ...pLayout('m').xaxis, title: { text: 'Hour', font: { size: 10 } }, range: [0, 24], dtick: 3 }, showlegend: true, legend: { font: { color: '#a0b4d0', size: 9 }, bgcolor: 'transparent' } }, { responsive: true });
    } catch (e) { div.innerHTML = '<div class="empty">Error</div>' }
  }
}

// ── TIDAL PREDICTION ──
async function predictPanel(el) {
  const mmsi = sel || 995741977;
  const s = STN.find(x => x.mmsi === mmsi);
  const nm = s ? sname(s) || mmsi : mmsi;
  const showVirtual = true;
  el.innerHTML = `<div class="cgrid" style="grid-template-columns:1fr 280px">
    <div class="cbox" style="height:auto;min-height:280px">
      <div class="ct" style="color:var(--neon);display:flex;gap:8px;align-items:center">🔮 ${nm} — 72h + 48h Forecast
        ${showVirtual ? '<button onclick="virtualPredict()" style="margin-left:auto;background:var(--bg4);border:1px solid var(--border);color:var(--cyan);padding:2px 8px;border-radius:4px;font-size:.68rem;cursor:pointer">+ Virtual Stations</button>' : ''}
      </div>
      <div class="cp" id="pred-chart"></div>
    </div>
    <div class="cbox" style="height:auto;min-height:280px;overflow-y:auto"><div class="ct">Analysis</div><div id="pred-info" style="font-size:.78rem;color:var(--t2)">Loading...</div></div>
  </div>`;
  await new Promise(r => setTimeout(r, 100));
  try {
    // Fetch observed (last 72h) and prediction (72h back + 48h ahead) in parallel
    const [obs, pred] = await Promise.all([
      J(`/hydro?mmsi=${mmsi}&limit=2000&start=${new Date(Date.now() - 72 * 36e5).toISOString()}`),
      J(`/tidal/predict/${mmsi}?hours_ahead=48&hours_back=72`)
    ]);
    const obsS = obs.filter(r => r.waterlevel != null).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const predPts = pred.predictions;
    const lastObs = pred.observed_end;
    const goodFit = pred.r2 > 0.7;

    // Split prediction into hindcast and forecast
    const hindcast = predPts.filter(r => r.ts <= lastObs);
    const forecast = predPts.filter(r => r.ts >= lastObs);

    // Find forecast highs/lows
    const highs = [], lows = [];
    for (let i = 1; i < forecast.length - 1; i++) {
      const prev = forecast[i - 1].level, cur = forecast[i].level, next = forecast[i + 1].level;
      if (cur > prev && cur > next) highs.push(forecast[i]);
      if (cur < prev && cur < next) lows.push(forecast[i]);
    }

    const traces = [
      // Observed data
      {
        x: obsS.map(r => r.ts), y: obsS.map(r => r.waterlevel), mode: 'lines', name: 'Observed',
        line: { color: '#00ffaa', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(0,255,170,0.06)'
      },
      // Hindcast (model fit over observed period)
      {
        x: hindcast.map(r => r.ts), y: hindcast.map(r => r.level), mode: 'lines', name: 'Model fit',
        line: { color: '#00d4ff', width: 1.5, dash: 'dot' }
      },
      // Forecast
      {
        x: forecast.map(r => r.ts), y: forecast.map(r => r.level), mode: 'lines',
        name: goodFit ? 'Forecast' : 'Forecast (low confidence)',
        line: { color: goodFit ? '#ff00aa' : '#ff00aa80', width: goodFit ? 2.5 : 1.5, dash: goodFit ? 'solid' : 'dot' },
        fill: 'tozeroy', fillcolor: goodFit ? 'rgba(255,0,170,0.06)' : 'rgba(255,0,170,0.02)'
      },
    ];
    if (highs.length) traces.push({
      x: highs.map(h => h.ts), y: highs.map(h => h.level), mode: 'markers+text', name: 'HW',
      marker: { color: '#ffcc00', size: 9, symbol: 'triangle-up' },
      text: highs.map(h => h.level.toFixed(2) + 'm'), textposition: 'top center',
      textfont: { color: '#ffcc00', size: 9 }, showlegend: false
    });
    if (lows.length) traces.push({
      x: lows.map(l => l.ts), y: lows.map(l => l.level), mode: 'markers+text', name: 'LW',
      marker: { color: '#00d4ff', size: 9, symbol: 'triangle-down' },
      text: lows.map(l => l.level.toFixed(2) + 'm'), textposition: 'bottom center',
      textfont: { color: '#00d4ff', size: 9 }, showlegend: false
    });

    Plotly.newPlot('pred-chart', traces, {
      ...pLayout('m'), showlegend: true,
      legend: { font: { color: '#a0b4d0', size: 9 }, bgcolor: 'transparent', orientation: 'h', y: 1.05 },
      shapes: [
        {
          type: 'line', x0: lastObs, x1: lastObs, y0: 0, y1: 1, yref: 'paper',
          line: { color: '#ffcc00', width: 1.5, dash: 'dash' }
        },
        {
          type: 'rect', x0: lastObs, x1: pred.predict_end, y0: 0, y1: 1, yref: 'paper',
          fillcolor: 'rgba(255,0,170,0.04)', line: { width: 0 }
        }
      ],
      annotations: [{
        x: lastObs, y: 1.02, yref: 'paper', text: 'Now →',
        showarrow: false, font: { color: '#ffcc00', size: 10 }, xanchor: 'left'
      }]
    }, { responsive: true });

    // Info panel
    const lastObsPt = obsS[obsS.length - 1];
    const prevObsPt = obsS.length > 1 ? obsS[obsS.length - 2] : null;
    const trend = prevObsPt ? (lastObsPt.waterlevel > prevObsPt.waterlevel ? '▲ Rising' : '▼ Falling') : '';
    const trendColor = trend.includes('Rising') ? 'var(--neon)' : 'var(--red)';

    let info = `<div style="text-align:center;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px">
      <div style="font-size:.65rem;text-transform:uppercase;color:var(--t3)">Current Level</div>
      <div style="font-size:1.8rem;font-weight:800;color:var(--cyan)">${lastObsPt ? lastObsPt.waterlevel.toFixed(2) : '—'} m</div>
      <div style="font-size:.75rem;color:${trendColor}">${trend}</div>
      <div style="font-size:.65rem;color:var(--t3)">${lastObsPt ? ago(lastObsPt.ts) : ''}</div>
    </div>`;
    if (highs.length) info += `<div style="padding:4px 0;font-size:.78rem"><span style="color:var(--yellow)">▲ Next HW:</span> ${highs[0].level.toFixed(2)}m at ${new Date(highs[0].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
    if (lows.length) info += `<div style="padding:4px 0;font-size:.78rem"><span style="color:var(--cyan)">▼ Next LW:</span> ${lows[0].level.toFixed(2)}m at ${new Date(lows[0].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
    info += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="color:${pred.r2 > 0.8 ? 'var(--neon)' : pred.r2 > 0.5 ? 'var(--yellow)' : 'var(--red)'};font-weight:700">R² = ${pred.r2.toFixed(4)}</div>
      ${!goodFit ? '<div style="color:var(--yellow);font-size:.72rem;margin:4px 0">⚠ Low model fit — prediction unreliable. Needs more data or stronger tidal signal.</div>' : ''}
      <div>RMSE = ${(pred.rmse * 100).toFixed(1)} cm</div>
      ${pred.recent_rmse != null ? `<div>Recent RMSE = ${(pred.recent_rmse * 100).toFixed(1)} cm</div>` : ''}
      ${pred.bias != null ? `<div>Bias correction = ${(pred.bias * 100).toFixed(1)} cm</div>` : ''}
      <div>${pred.n_constituents} constituents</div>
      ${pred.fitted_ago_min != null ? `<div style="color:var(--t3);font-size:.7rem">Model fitted ${pred.fitted_ago_min}min ago</div>` : ''}
    </div>`;
    info += '<table class="rt" style="margin-top:8px"><thead><tr><th>Name</th><th>Amp</th><th>Phase</th></tr></thead><tbody>';
    pred.top_constituents.forEach(([name, c]) => {
      info += `<tr><td style="font-weight:700">${name}</td><td class="hi">${(c.amp * 100).toFixed(1)}cm</td><td>${c.phase.toFixed(0)}°</td></tr>`;
    });
    info += '</tbody></table>';
    $('pred-info').innerHTML = info;
  } catch (e) {
    $('pred-chart').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    $('pred-info').innerHTML = '<div class="empty">Analysis failed</div>';
  }
}

// ── VIRTUAL STATION PREDICTION ──
async function virtualPredict() {
  const info = $('pred-info');
  try {
    // Get virtual stations
    const vsList = await J('/virtual-stations');
    if (!vsList.length) {
      info.innerHTML += '<div style="color:var(--yellow);margin-top:8px">No virtual stations. Create one first.</div>';
      return;
    }
    for (const vs of vsList) {
      const vp = await J(`/tidal/virtual/${vs.id}?hours_ahead=48&hours_back=72`);
      Plotly.addTraces($('pred-chart'), {
        x: vp.predictions.map(r => r.ts), y: vp.predictions.map(r => r.level),
        mode: 'lines', name: `🔮 ${vp.name} (${vp.mode})`,
        line: { color: '#ffcc00', width: 2.5, dash: vp.mode === 'own_model' ? 'solid' : 'dashdot' }
      });
      const src = vp.sources || {};
      info.innerHTML += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
        <div style="color:var(--yellow);font-weight:700">${vp.name}</div>
        <div style="font-size:.72rem;color:var(--t3)">${vp.lat.toFixed(4)}°N, ${vp.lon.toFixed(4)}°E · ${vp.mode}</div>
        ${Object.entries(src).map(([m, w]) => `<div style="font-size:.72rem;color:var(--t2)">  ${m}: ${(w * 100).toFixed(0)}%</div>`).join('')}
      </div>`;
    }
  } catch (e) {
    info.innerHTML += `<div style="color:var(--red);margin-top:8px">Error: ${e.message}</div>`;
  }
}

// ── VIRTUAL STATION MANAGEMENT (in right panel alerts tab) ──
async function showVirtualUI() {
  const el = $('rc');
  let html = `<div class="aform">
    <div style="font-size:.72rem;color:var(--t3);text-transform:uppercase;font-weight:700;margin-bottom:4px">Add Virtual Station</div>
    <input id="vs-name" placeholder="Name (e.g. CFC-TKP)">
    <input id="vs-lat" type="number" step="0.0001" placeholder="Latitude">
    <input id="vs-lon" type="number" step="0.0001" placeholder="Longitude">
    <input id="vs-src" placeholder="Source MMSIs (comma-sep)">
    <button class="abtn" onclick="createVS()">+ Create</button>
  </div>`;
  try {
    const vsList = await J('/virtual-stations');
    for (const vs of vsList) {
      const obs = vs.obs_count || 0;
      html += `<div class="alert-item" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;width:100%;justify-content:space-between;align-items:center">
          <span style="font-weight:700;color:var(--yellow)">${vs.name}</span>
          <button class="alert-del" onclick="delVS(${vs.id})">✕</button>
        </div>
        <div style="font-size:.7rem;color:var(--t3)">${vs.lat.toFixed(4)}, ${vs.lon.toFixed(4)} · src: ${vs.source_mmsis}</div>
        <div style="font-size:.7rem;color:var(--t2)">${obs} manual obs ${vs.promoted ? '· <span style="color:var(--neon)">✓ Promoted</span>' : obs >= 48 ? '· <button onclick="promoteVS(' + vs.id + ')" style="color:var(--neon);background:none;border:1px solid var(--neon);border-radius:4px;padding:1px 6px;font-size:.68rem;cursor:pointer">Promote</button>' : ''}</div>
        <div style="display:flex;gap:4px;width:100%">
          <input id="obs-ts-${vs.id}" type="datetime-local" style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--t1);padding:3px 6px;border-radius:4px;font-size:.7rem">
          <input id="obs-wl-${vs.id}" type="number" step="0.01" placeholder="WL (m)" style="width:70px;background:var(--bg3);border:1px solid var(--border);color:var(--t1);padding:3px 6px;border-radius:4px;font-size:.7rem">
          <button onclick="addObs(${vs.id})" style="background:var(--neon);color:var(--bg);border:none;padding:3px 8px;border-radius:4px;font-size:.7rem;font-weight:700;cursor:pointer">+</button>
        </div>
      </div>`;
    }
  } catch (e) {}
  el.innerHTML = html;
}

async function createVS() {
  const name = $('vs-name').value, lat = $('vs-lat').value, lon = $('vs-lon').value, src = $('vs-src').value;
  if (!name || !lat || !lon || !src) return;
  await fetch(`${A}/virtual-stations?name=${encodeURIComponent(name)}&lat=${lat}&lon=${lon}&source_mmsis=${src}`, { method: 'POST' });
  showVirtualUI();
}
async function delVS(id) { await fetch(`${A}/virtual-stations/${id}`, { method: 'DELETE' }); showVirtualUI(); }
async function promoteVS(id) { await fetch(`${A}/virtual-stations/${id}/promote`, { method: 'POST' }); showVirtualUI(); }
async function addObs(id) {
  const ts = $('obs-ts-' + id).value, wl = $('obs-wl-' + id).value;
  if (!ts || !wl) return;
  await fetch(`${A}/virtual-stations/${id}/obs?ts=${new Date(ts).toISOString()}&waterlevel=${wl}`, { method: 'POST' });
  showVirtualUI();
}

// ── SYSTEM ──
async function sysPanel(el) {
  try {
    const h = await J('/health');
    const srcs = (h.sources || []).map(s => typeof s === 'string' ? { url: s, interval: '?' } : s);
    el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
      ${sc('Database', h.db_pool === 'connected' ? '● Connected' : '● Down', h.db_pool === 'connected')}
      ${sc('Poller', h.poller === 'running' ? '● Running' : '● Stopped', h.poller === 'running')}
      ${sc('WS Clients', h.ws_clients ?? 0, true)}
      <div style="grid-column:1/-1;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:6px;font-weight:700">Sources</div>
        ${srcs.map(s => `<div style="padding:3px 0;font-size:.78rem;color:var(--t2)">● ${s.url} <span style="color:var(--neon)">${s.interval}s</span></div>`).join('')}
      </div></div>`;
  } catch (e) { el.innerHTML = '<div class="empty">Unavailable</div>' }
}
function sc(t, v, ok) { return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px"><div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:6px;font-weight:700">${t}</div><div style="font-size:1rem;font-weight:700;color:${ok ? 'var(--neon)' : 'var(--red)'}">${v}</div></div>` }

// ── PLOTLY LAYOUT HELPER ──
function pLayout(yTitle) {
  return {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: '#607090', size: 10 },
    xaxis: { gridcolor: '#1a2540', linecolor: '#1a2540' }, yaxis: { gridcolor: '#1a2540', linecolor: '#1a2540', title: { text: yTitle, font: { size: 10 } } },
    margin: { t: 8, r: 8, b: 35, l: 45 }, showlegend: false
  };
}

// ── HELPERS ──
function $(s) { return document.getElementById(s) }
async function J(p) { const r = await fetch(A + p); if (!r.ok) throw new Error(r.status); return r.json() }
function fmt(n) { return n == null ? '—' : Number(n).toLocaleString() }
function ago(ts) {
  if (!ts) return '—'; const ms = Date.now() - new Date(ts).getTime();
  if (ms < 6e4) return 'now'; if (ms < 36e5) return Math.floor(ms / 6e4) + 'm';
  if (ms < 864e5) return Math.floor(ms / 36e5) + 'h';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── WEBSOCKET REAL-TIME ──
let _ws = null, _wsRetry = 1;
function initWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}/api/ws/live`);
  _ws.onopen = () => { _wsRetry = 1; logger('WS connected') };
  _ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'new_data') {
        logger(`Live: ${msg.count} new points`);
        loadNav(); loadRight();
        // Update current conditions if selected station has new data
        if (sel && msg.points?.some(p => p.mmsi === sel)) updateCC();
        // Flash health dot
        const dot = $('hd'); if (dot) { dot.style.boxShadow = '0 0 20px rgba(0,255,170,.8)'; setTimeout(() => dot.style.boxShadow = '', 500) }
        // Flash updated stations in list
        const updated = new Set(msg.points?.map(p => p.mmsi) || []);
        document.querySelectorAll('.si').forEach(el => {
          const mmsi = parseInt(el.querySelector('.nm span[style]')?.textContent);
          if (updated.has(mmsi)) { el.style.background = 'rgba(0,255,170,.08)'; setTimeout(() => el.style.background = '', 1500) }
        });
      }
    } catch (err) { }
  };
  _ws.onclose = () => {
    logger('WS disconnected, retry in ' + _wsRetry + 's');
    setTimeout(() => { _wsRetry = Math.min(_wsRetry * 2, 30); initWS() }, _wsRetry * 1000);
  };
  _ws.onerror = () => _ws.close();
}
function logger(msg) { if (typeof console !== 'undefined') console.log('[TideWatch]', msg) }

// ── MOBILE BOTTOM SHEET SWIPE ──
(function () {
  let startY = 0, startH = 0;
  const handle = document.getElementById('bhandle');
  if (!handle) return;
  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    const bot = document.getElementById('pbot');
    startH = bot.getBoundingClientRect().height;
    bot.style.transition = 'none';
  });
  handle.addEventListener('touchmove', e => {
    e.preventDefault();
    const dy = startY - e.touches[0].clientY;
    const bot = document.getElementById('pbot');
    const nh = Math.max(60, Math.min(window.innerHeight * .85, startH + dy));
    bot.style.maxHeight = nh + 'px';
  }, { passive: false });
  handle.addEventListener('touchend', () => {
    const bot = document.getElementById('pbot');
    bot.style.transition = 'max-height .3s ease';
    const h = bot.getBoundingClientRect().height;
    if (h < 120) {
      bot.classList.add('collapsed');
    } else {
      bot.classList.remove('collapsed');
      bot.style.maxHeight = Math.min(h, window.innerHeight * .85) + 'px';
    }
  });
})();
