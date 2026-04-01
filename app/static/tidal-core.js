// ═══════════════════════════════════════════════════════════════
//  TIDAL CONSTITUENTS — deduplicated (Phase 5 item 22)
//  37 unique constituents, no duplicate keys
// ═══════════════════════════════════════════════════════════════
const TIDAL_CONSTITUENTS = {
    // Principal semidiurnal
    'M2':      { freq: 28.9841042, nodal: true },
    'S2':      { freq: 30.0,       nodal: false },
    'N2':      { freq: 28.4397295, nodal: true },
    'K2':      { freq: 30.0821373, nodal: false },
    // Principal diurnal
    'K1':      { freq: 15.0410686, nodal: false },
    'O1':      { freq: 13.9430356, nodal: true },
    'P1':      { freq: 14.9589314, nodal: false },
    'Q1':      { freq: 13.3986609, nodal: true },
    // Shallow water
    'M4':      { freq: 57.9682084, nodal: true },
    'MS4':     { freq: 58.9841042, nodal: true },
    'MN4':     { freq: 57.4238337, nodal: true },
    'M6':      { freq: 86.9523127, nodal: true },
    'M8':      { freq: 115.9364169, nodal: true },
    '2MS6':    { freq: 87.9682084, nodal: true },
    // Long period
    'Mm':      { freq: 0.5443747, nodal: true },
    'Ssa':     { freq: 0.0821373, nodal: false },
    'Sa':      { freq: 0.0410686, nodal: false },
    'Mf':      { freq: 1.0980331, nodal: true },
    // Additional semidiurnal
    'L2':      { freq: 29.5284789, nodal: true },
    'T2':      { freq: 29.9589333, nodal: false },
    'Lambda2': { freq: 29.4556253, nodal: true },
    '2N2':     { freq: 27.8953548, nodal: true },
    'Mu2':     { freq: 27.9682084, nodal: true },
    'Nu2':     { freq: 28.5125831, nodal: true },
    'Eps2':    { freq: 27.4238337, nodal: true },
    // Additional diurnal
    'J1':      { freq: 15.5854433, nodal: true },
    'OO1':     { freq: 16.1391017, nodal: true },
    '2Q1':     { freq: 12.8542862, nodal: true },
    'Sigma1':  { freq: 12.9271398, nodal: true },
    'Rho1':    { freq: 13.4715145, nodal: true },
    'M1':      { freq: 14.4920521, nodal: true },
    'Theta1':  { freq: 15.5125897, nodal: true },
    // Terdiurnal
    'M3':      { freq: 43.4761563, nodal: true },
    'MK3':     { freq: 44.0251729, nodal: true },
    'SK3':     { freq: 45.0410686, nodal: false },
    // Extended
    'SN4':     { freq: 58.4397295, nodal: true },
    'MNS4':    { freq: 56.8794590, nodal: true },
};

// ═══════════════════════════════════════════════════════════════
//  GLOBALS
// ═══════════════════════════════════════════════════════════════
let csvData = null;
let analysisResults = null;
let selectedMethod = 'harmonic';
let activeSource = 'csv';
const API_BASE = window.location.origin + '/api';  // Phase 4 item 18: auto-detect

// ═══════════════════════════════════════════════════════════════
//  NODAL CORRECTIONS
// ═══════════════════════════════════════════════════════════════
function julianDay(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const yr = y + 4800 - a;
    const mo = m + 12 * a - 3;
    return d + Math.floor((153 * mo + 2) / 5) + 365 * yr +
           Math.floor(yr / 4) - Math.floor(yr / 100) + Math.floor(yr / 400) - 32045;
}

function nodeAngle(y, m, d) {
    const T = (julianDay(y, m, d) - 2451545.0) / 36525.0;
    return (125.04 - 1934.136 * T) * Math.PI / 180;
}

function getNodalCorrections(name, y, m, d) {
    if (!TIDAL_CONSTITUENTS[name] || !TIDAL_CONSTITUENTS[name].nodal) return { f: 1, u: 0 };
    const N = nodeAngle(y, m, d);
    let f = 1, u = 0;
    switch (name) {
        case 'M2': case 'N2': case '2N2': case 'Mu2': case 'Nu2': case 'Lambda2': case 'Eps2':
            f = 1 - 0.037 * Math.cos(N); u = -2.14 * Math.sin(N); break;
        case 'O1': case 'Q1': case '2Q1': case 'Sigma1': case 'Rho1':
            f = 1 + 0.189 * Math.cos(N); u = 10.8 * Math.sin(N); break;
        case 'K1': case 'J1': case 'Theta1': case 'M1':
            f = 1 + 0.115 * Math.cos(N); u = -8.9 * Math.sin(N); break;
        case 'OO1':
            f = 1 + 0.640 * Math.cos(N); u = -6.0 * Math.sin(N); break;
        case 'Mf':
            f = 1 - 0.130 * Math.cos(N); u = 0; break;
        case 'Mm':
            f = 1 - 0.130 * Math.cos(N); u = 0; break;
        default:
            if (name.includes('M') || name.includes('N')) { f = 1 - 0.037 * Math.cos(N); u = -2.14 * Math.sin(N); }
    }
    return { f, u: u * Math.PI / 180 };
}

// ═══════════════════════════════════════════════════════════════
//  CSV PARSER & FILE HANDLING
// ═══════════════════════════════════════════════════════════════
function parseCSV(text) {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).filter(l => l.trim()).map(l => {
        const vals = l.split(',').map(v => v.trim());
        const row = {};
        headers.forEach((h, i) => row[h] = vals[i]);
        return row;
    });
}

const fileInput = document.getElementById('fileInput');
const uploadSection = document.getElementById('uploadSection');
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
uploadSection.addEventListener('dragover', e => { e.preventDefault(); uploadSection.classList.add('dragover'); });
uploadSection.addEventListener('dragleave', () => uploadSection.classList.remove('dragover'));
uploadSection.addEventListener('drop', e => {
    e.preventDefault(); uploadSection.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.csv')) handleFile(f); else showError('Please upload a CSV file');
});

function handleFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
        try {
            csvData = parseCSV(e.target.result);
            document.getElementById('fileInfo').classList.add('active');
            document.getElementById('fileName').textContent = file.name;
            document.getElementById('rowCount').textContent = csvData.length;
            hideError();
        } catch (err) { showError('Error reading CSV: ' + err.message); }
    };
    reader.readAsText(file);
}

// ═══════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════
function selectMethod(method) {
    selectedMethod = method;
    document.querySelectorAll('.method-option').forEach(el => el.classList.remove('active'));
    document.getElementById('method' + method.charAt(0).toUpperCase() + method.slice(1)).classList.add('active');
    document.getElementById(method).checked = true;
    document.getElementById('hybridWarning').style.display = method === 'hybrid' ? 'block' : 'none';
}
function showError(msg) { const el = document.getElementById('errorMsg'); el.textContent = '❌ ' + msg; el.classList.add('active'); }
function hideError() { document.getElementById('errorMsg').classList.remove('active'); }
function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('tab-' + name).classList.add('active');
}
function switchDataSource(src) {
    activeSource = src;
    document.getElementById('dsTabCSV').classList.toggle('active', src === 'csv');
    document.getElementById('dsTabAPI').classList.toggle('active', src === 'api');
    document.getElementById('uploadSection').style.display = src === 'csv' ? '' : 'none';
    document.getElementById('apiSection').style.display = src === 'api' ? '' : 'none';
    if (src === 'csv') { document.getElementById('fileInfo').classList.remove('active'); csvData = null; }
}
