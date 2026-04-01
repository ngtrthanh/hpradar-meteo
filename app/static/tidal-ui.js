// ═══════════════════════════════════════════════════════════════
//  MAIN ANALYSIS ENTRY POINT
// ═══════════════════════════════════════════════════════════════
function performAnalysis() {
    const latitude = parseFloat(document.getElementById('latitude').value);
    const longitude = parseFloat(document.getElementById('longitude').value);
    if (!csvData || !latitude || !longitude) {
        showError(activeSource === 'api' ? 'Please fetch data from API first' : 'Please upload CSV and enter coordinates');
        return;
    }
    const btn = document.getElementById('analyzeBtn');
    btn.disabled = true; btn.textContent = '⏳ Analyzing...'; hideError();

    setTimeout(() => {
        try {
            const processedData = csvData.map(row => {
                const vals = Object.values(row);
                const dt = new Date(vals[0] + ' ' + vals[1]);
                return { datetime: dt, timestamp: dt.getTime(), height: parseFloat(vals[2]) };
            }).filter(d => !isNaN(d.height) && !isNaN(d.datetime));
            if (!processedData.length) throw new Error('No valid data');
            processedData.sort((a, b) => a.timestamp - b.timestamp);
            const meanHeight = processedData.reduce((s, d) => s + d.height, 0) / processedData.length;

            let result;
            if (selectedMethod === 'fft') result = performAdvancedFFT(processedData, meanHeight);
            else if (selectedMethod === 'hybrid') result = performHybridAnalysis(processedData, meanHeight, latitude, longitude);
            else result = performAdvancedHarmonic(processedData, meanHeight, latitude, longitude);

            const predicted = result.predicted;

            // For hybrid, compute metrics on TEST set only
            let evalStart = 0;
            if (selectedMethod === 'hybrid' && result.trainSize) evalStart = result.trainSize;

            const evalObs = processedData.slice(evalStart);
            const evalPred = predicted.slice(evalStart);
            const residuals = evalObs.map((d, i) => d.height - evalPred[i]);
            const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
            const mae = residuals.reduce((s, r) => s + Math.abs(r), 0) / residuals.length;
            const variance = evalObs.reduce((s, d) => s + (d.height - meanHeight) ** 2, 0) / evalObs.length;
            const r2 = 1 - residuals.reduce((s, r) => s + r * r, 0) / (variance * evalObs.length);
            const maxError = Math.max(...residuals.map(Math.abs));
            const sorted = residuals.map(Math.abs).sort((a, b) => a - b);
            const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];

            // Full residuals for plotting
            const fullResiduals = processedData.map((d, i) => d.height - predicted[i]);

            analysisResults = {
                method: selectedMethod, meanSeaLevel: meanHeight,
                rmse, mae, r2, maxError, percentile95Error: p95,
                dataPoints: processedData.length,
                evalDataPoints: evalObs.length,
                predicted, observed: processedData.map(d => d.height),
                timestamps: processedData.map(d => d.datetime),
                residuals: fullResiduals, latitude, longitude,
                ...result
            };
            displayResults(); plotCharts();
        } catch (err) { showError('Analysis error: ' + err.message); }
        finally { btn.disabled = false; btn.textContent = '🚀 Run Tidal Analysis'; }
    }, 50);
}

// ═══════════════════════════════════════════════════════════════
//  DISPLAY RESULTS
// ═══════════════════════════════════════════════════════════════
function displayResults() {
    document.getElementById('results').classList.add('active');
    const names = { fft: 'FFT Advanced', hybrid: 'Hybrid (test-set metrics)', harmonic: 'Harmonic Analysis' };
    const name = names[analysisResults.method] || 'Harmonic';
    document.getElementById('methodName').textContent = name;
    document.getElementById('methodBadge').textContent = name;
    document.getElementById('meanSeaLevel').textContent = analysisResults.meanSeaLevel.toFixed(2) + ' cm';
    document.getElementById('rmse').textContent = analysisResults.rmse.toFixed(2) + ' cm';
    document.getElementById('mae').textContent = analysisResults.mae.toFixed(2) + ' cm';
    document.getElementById('r2').textContent = analysisResults.r2.toFixed(6);
    const range = Math.max(...analysisResults.observed) - Math.min(...analysisResults.observed);
    document.getElementById('accuracy').textContent = Math.max(0, (1 - analysisResults.mae / range) * 100).toFixed(2) + '%';
    document.getElementById('dataPoints').textContent = analysisResults.evalDataPoints || analysisResults.dataPoints;
    displayConstituentsTable();
    displayDetails();
}

function displayConstituentsTable() {
    if (analysisResults.method === 'fft') {
        document.getElementById('constituentsTable').innerHTML = '<table><thead><tr><th>#</th><th>Freq (Hz)</th><th>Period (h)</th><th>Amplitude (cm)</th><th>Phase (°)</th></tr></thead><tbody>' +
            analysisResults.fftPeaks.map((p, i) => `<tr><td>${i+1}</td><td>${p.frequency.toFixed(8)}</td><td>${(p.period/3600).toFixed(2)}</td><td>${p.amplitude.toFixed(4)}</td><td>${p.phase.toFixed(2)}</td></tr>`).join('') + '</tbody></table>';
    } else {
        document.getElementById('constituentsTable').innerHTML = '<table><thead><tr><th>Name</th><th>Freq (°/hr)</th><th>Amplitude (cm)</th><th>Phase (°)</th><th>Nodal F</th><th>Nodal U (°)</th></tr></thead><tbody>' +
            Object.entries(analysisResults.constituents).sort((a, b) => b[1].amplitude - a[1].amplitude)
            .map(([n, p]) => `<tr><td><strong>${n}</strong></td><td>${p.frequency.toFixed(6)}</td><td>${p.amplitude.toFixed(4)}</td><td>${p.phase.toFixed(2)}</td><td>${(p.nodalF||1).toFixed(4)}</td><td>${(p.nodalU||0).toFixed(2)}</td></tr>`).join('') + '</tbody></table>';
    }
}

function displayDetails() {
    let html = '<div style="line-height:1.8">';
    html += `<p><strong>Method:</strong> ${analysisResults.method.toUpperCase()}</p>`;
    html += `<p><strong>Data points:</strong> ${analysisResults.dataPoints}</p>`;
    if (analysisResults.evalDataPoints && analysisResults.evalDataPoints !== analysisResults.dataPoints)
        html += `<p><strong>Evaluation points (test set):</strong> ${analysisResults.evalDataPoints}</p>`;
    html += `<p><strong>Mean sea level:</strong> ${analysisResults.meanSeaLevel.toFixed(2)} cm</p>`;
    html += `<p><strong>RMSE:</strong> ${analysisResults.rmse.toFixed(4)} cm</p>`;
    html += `<p><strong>MAE:</strong> ${analysisResults.mae.toFixed(4)} cm</p>`;
    html += `<p><strong>R²:</strong> ${analysisResults.r2.toFixed(6)}</p>`;
    html += `<p><strong>Max error:</strong> ${analysisResults.maxError.toFixed(2)} cm</p>`;
    html += `<p><strong>95th percentile error:</strong> ${analysisResults.percentile95Error.toFixed(2)} cm</p>`;
    if (analysisResults.nodalCorrectionsApplied !== undefined)
        html += `<p><strong>Nodal corrections:</strong> ${analysisResults.nodalCorrectionsApplied ? 'Yes' : 'No'}</p>`;
    if (analysisResults.windowType)
        html += `<p><strong>FFT window:</strong> ${analysisResults.windowType}</p>`;
    html += '</div>';
    document.getElementById('detailsContent').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
//  CHARTS (Plotly only — Phase 4 item 17)
// ═══════════════════════════════════════════════════════════════
function plotCharts() {
    const ts = analysisResults.timestamps, obs = analysisResults.observed, pred = analysisResults.predicted, res = analysisResults.residuals;
    Plotly.newPlot('chart1', [
        { x: ts, y: obs, mode: 'lines', name: 'Observed', line: { color: '#3b82f6', width: 1.5 } },
        { x: ts, y: pred, mode: 'lines', name: 'Predicted', line: { color: '#ef4444', width: 2, dash: 'dot' } }
    ], { title: 'Observed vs Predicted (full)', xaxis: { title: 'Time' }, yaxis: { title: 'Height (cm)' }, hovermode: 'closest' });

    const z = Math.min(7 * 24, ts.length);
    Plotly.newPlot('chart2', [
        { x: ts.slice(0, z), y: obs.slice(0, z), mode: 'lines+markers', name: 'Observed', line: { color: '#3b82f6', width: 2 }, marker: { size: 4 } },
        { x: ts.slice(0, z), y: pred.slice(0, z), mode: 'lines', name: 'Predicted', line: { color: '#ef4444', width: 3, dash: 'dash' } }
    ], { title: 'Detail (first 7 days)', xaxis: { title: 'Time' }, yaxis: { title: 'Height (cm)' }, hovermode: 'closest' });

    Plotly.newPlot('chart3', [{ x: ts, y: res, mode: 'lines', name: 'Residual', line: { color: '#8b5cf6', width: 1 }, fill: 'tozeroy', fillcolor: 'rgba(139,92,246,0.2)' }],
        { title: 'Residuals', xaxis: { title: 'Time' }, yaxis: { title: 'Error (cm)' }, hovermode: 'closest' });

    if (analysisResults.method === 'fft') {
        const p = analysisResults.fftPeaks;
        Plotly.newPlot('chart4', [{ x: p.map(pk => (pk.period / 3600).toFixed(2)), y: p.map(pk => pk.amplitude), type: 'bar', marker: { color: p.map(pk => pk.amplitude), colorscale: 'Viridis' } }],
            { title: 'FFT Spectrum', xaxis: { title: 'Period (hours)', type: 'log' }, yaxis: { title: 'Amplitude (cm)' } });
    } else {
        const names = Object.keys(analysisResults.constituents);
        Plotly.newPlot('chart4', [{ x: names, y: names.map(n => analysisResults.constituents[n].amplitude), type: 'bar', marker: { color: names.map(n => analysisResults.constituents[n].amplitude), colorscale: 'Thermal' } }],
            { title: 'Constituent Amplitudes', xaxis: { title: 'Constituent' }, yaxis: { title: 'Amplitude (cm)' } });
    }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════════
function exportJSON() {
    if (!analysisResults) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(analysisResults, null, 2)], { type: 'application/json' }));
    a.download = 'tidal_analysis.json'; a.click();
}
function exportCSV() {
    if (!analysisResults) return;
    let csv;
    if (analysisResults.method !== 'fft') {
        csv = 'Constituent,Frequency (deg/hr),Amplitude (cm),Phase (deg),Nodal F,Nodal U (deg)\n';
        Object.entries(analysisResults.constituents).forEach(([n, p]) => {
            csv += `${n},${p.frequency},${p.amplitude.toFixed(4)},${p.phase.toFixed(4)},${(p.nodalF||1).toFixed(4)},${(p.nodalU||0).toFixed(4)}\n`;
        });
    } else {
        csv = 'Peak,Frequency (Hz),Period (hours),Amplitude (cm),Phase (deg)\n';
        analysisResults.fftPeaks.forEach((p, i) => { csv += `${i+1},${p.frequency.toFixed(8)},${(p.period/3600).toFixed(2)},${p.amplitude.toFixed(4)},${p.phase.toFixed(4)}\n`; });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'tidal_constituents.csv'; a.click();
}
function exportPredictions() {
    if (!analysisResults) return;
    let csv = 'Timestamp,Observed (cm),Predicted (cm),Residual (cm)\n';
    for (let i = 0; i < analysisResults.timestamps.length; i++)
        csv += `${analysisResults.timestamps[i].toISOString()},${analysisResults.observed[i].toFixed(2)},${analysisResults.predicted[i].toFixed(2)},${analysisResults.residuals[i].toFixed(2)}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'tidal_predictions.csv'; a.click();
}

// ═══════════════════════════════════════════════════════════════
//  API DATA FETCH — dynamic station list
// ═══════════════════════════════════════════════════════════════
async function loadApiStations() {
    try {
        const stations = await fetch(API_BASE + '/stations').then(r => r.json());
        const sel = document.getElementById('apiMMSI');
        sel.innerHTML = '';
        if (!stations.length) { sel.innerHTML = '<option value="">No stations available</option>'; return; }
        stations.forEach(s => {
            const o = document.createElement('option');
            o.value = s.mmsi;
            o.textContent = s.mmsi + ' — ' + (s.country || 'Unknown') + ' (' + s.lat.toFixed(2) + ', ' + s.lon.toFixed(2) + ')';
            sel.appendChild(o);
        });
    } catch (e) {
        document.getElementById('apiMMSI').innerHTML = '<option value="">Failed to load stations</option>';
    }
}

function setApiStatus(text, pct, pulse) {
    const el = document.getElementById('apiStatus');
    el.style.display = 'block';
    document.getElementById('apiStatusFill').style.width = pct + '%';
    document.getElementById('apiStatusFill').classList.toggle('pulse', !!pulse);
    document.getElementById('apiStatusText').textContent = text;
}
function hideApiStatus() { document.getElementById('apiStatus').style.display = 'none'; }

async function fetchAPIData() {
    const mmsi = document.getElementById('apiMMSI').value;
    const limit = document.getElementById('apiLimit').value;
    const btn = document.getElementById('fetchBtn');
    if (!mmsi) { showError('Please select a station'); return; }

    document.getElementById('apiPreview').style.display = 'none';
    document.getElementById('fileInfo').classList.remove('active');
    hideError(); csvData = null;
    btn.disabled = true; btn.textContent = '⏳ Loading...';

    try {
        setApiStatus('Connecting to MMSI ' + mmsi + '...', 10, true);
        const resp = await fetch(API_BASE + '/hydro?mmsi=' + mmsi + '&limit=' + limit);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        setApiStatus('Reading JSON...', 40, true);
        const raw = await resp.json();
        if (!Array.isArray(raw) || !raw.length) throw new Error('Empty response');

        setApiStatus('Validating...', 55, false);
        if (!('ts' in raw[0]) || !('waterlevel' in raw[0])) throw new Error('Missing ts/waterlevel fields');

        setApiStatus('Normalizing...', 70, false);
        const parsed = raw.map(r => {
            const dt = new Date(r.ts); const wl = parseFloat(r.waterlevel);
            return (!isNaN(dt) && !isNaN(wl)) ? { datetime: dt, waterlevel_m: wl } : null;
        }).filter(Boolean).sort((a, b) => a.datetime - b.datetime);
        if (!parsed.length) throw new Error('No valid records');

        setApiStatus('Converting...', 85, false);
        csvData = parsed.map(r => ({
            'Date': r.datetime.toISOString().split('T')[0],
            'Time': r.datetime.toISOString().split('T')[1].substring(0, 8),
            'Tide_cm': (r.waterlevel_m * 100).toFixed(2)
        }));

        setApiStatus('✅ Loaded ' + csvData.length.toLocaleString() + ' records', 100, false);
        const fmt = d => d.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
        document.getElementById('apiRecordCount').textContent = '📊 ' + csvData.length.toLocaleString() + ' records — MMSI ' + mmsi;
        document.getElementById('apiDateRange').textContent = fmt(parsed[0].datetime) + ' → ' + fmt(parsed[parsed.length - 1].datetime);

        document.getElementById('apiPreviewBody').innerHTML = parsed.slice(0, 5).map((r, i) =>
            `<tr><td>${i+1}</td><td>${r.datetime.toISOString().replace('T',' ').substring(0,19)} UTC</td><td>${r.waterlevel_m.toFixed(3)} m (${(r.waterlevel_m*100).toFixed(1)} cm)</td></tr>`
        ).join('');
        document.getElementById('apiPreview').style.display = 'block';

        document.getElementById('fileInfo').classList.add('active');
        document.getElementById('fileName').textContent = 'API — MMSI ' + mmsi;
        document.getElementById('rowCount').textContent = csvData.length.toLocaleString();

        // Auto-fill coordinates from station
        try {
            const stations = await fetch(API_BASE + '/stations').then(r => r.json());
            const st = stations.find(s => s.mmsi == mmsi);
            if (st) {
                document.getElementById('latitude').value = st.lat.toFixed(6);
                document.getElementById('longitude').value = st.lon.toFixed(6);
            }
        } catch (e) {}

    } catch (err) { hideApiStatus(); showError('API error: ' + err.message); csvData = null; }
    finally { btn.disabled = false; btn.textContent = '⬇️ Fetch Data'; }
}

// Init
loadApiStations();
