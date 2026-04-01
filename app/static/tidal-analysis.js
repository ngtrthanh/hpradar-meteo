// ═══════════════════════════════════════════════════════════════
//  SIMULTANEOUS LEAST-SQUARES HARMONIC ANALYSIS (Phase 5 item 23)
//  Solves all constituents simultaneously via normal equations
// ═══════════════════════════════════════════════════════════════
function performAdvancedHarmonic(processedData, meanHeight, latitude, longitude) {
    const count = parseInt(document.getElementById('constituentsCount').value);
    const useNodal = document.getElementById('nodalCorrections').checked;
    const inclShallow = document.getElementById('shallowWater').checked;

    const allKeys = Object.keys(TIDAL_CONSTITUENTS);
    const selected = [];
    for (let i = 0; i < Math.min(count, allKeys.length); i++) {
        const k = allKeys[i];
        if (!inclShallow && /[4-9]|1[0-2]/.test(k.match(/\d+/)?.[0] || '')) continue;
        selected.push(k);
    }

    const n = processedData.length;
    const M = selected.length;
    const cols = 2 * M; // a_i cos + b_i sin for each constituent
    const startTime = processedData[0].timestamp;
    const d0 = processedData[0].datetime;
    const year = d0.getFullYear(), month = d0.getMonth() + 1, day = d0.getDate();

    // Precompute omega and nodal corrections
    const omegas = [];
    const nodalF = [];
    const nodalU = [];
    selected.forEach(name => {
        const freq = TIDAL_CONSTITUENTS[name].freq;
        omegas.push((freq * Math.PI / 180) / 3600000); // rad per ms
        if (useNodal) {
            const c = getNodalCorrections(name, year, month, day);
            nodalF.push(c.f);
            nodalU.push(c.u);
        } else {
            nodalF.push(1);
            nodalU.push(0);
        }
    });

    // Build normal equations: A^T A x = A^T b
    // A is n×cols, but we never store it — accumulate A^T A and A^T b directly
    const ATA = new Float64Array(cols * cols);
    const ATb = new Float64Array(cols);

    for (let i = 0; i < n; i++) {
        const t = processedData[i].timestamp - startTime;
        const h = processedData[i].height - meanHeight;
        // Build row of A
        const row = new Float64Array(cols);
        for (let j = 0; j < M; j++) {
            const phase = omegas[j] * t + nodalU[j];
            row[2 * j]     = nodalF[j] * Math.cos(phase);
            row[2 * j + 1] = nodalF[j] * Math.sin(phase);
        }
        // Accumulate A^T A (symmetric)
        for (let r = 0; r < cols; r++) {
            ATb[r] += row[r] * h;
            for (let c = r; c < cols; c++) {
                ATA[r * cols + c] += row[r] * row[c];
            }
        }
    }
    // Fill symmetric lower triangle
    for (let r = 0; r < cols; r++)
        for (let c = 0; c < r; c++)
            ATA[r * cols + c] = ATA[c * cols + r];

    // Solve via Cholesky decomposition
    const x = solveCholesky(ATA, ATb, cols);

    // Extract amplitudes and phases
    const harmonicParams = {};
    selected.forEach((name, j) => {
        const a = x[2 * j];
        const b = x[2 * j + 1];
        const amplitude = Math.sqrt(a * a + b * b);
        let phase = Math.atan2(b, a) * 180 / Math.PI;
        if (phase < 0) phase += 360;
        harmonicParams[name] = {
            frequency: TIDAL_CONSTITUENTS[name].freq,
            amplitude, phase, a, b,
            nodalF: nodalF[j], nodalU: nodalU[j] * 180 / Math.PI
        };
    });

    // Predict
    const predicted = processedData.map(d => {
        const t = d.timestamp - startTime;
        let pred = meanHeight;
        for (let j = 0; j < M; j++) {
            const phase = omegas[j] * t + nodalU[j];
            pred += nodalF[j] * (x[2*j] * Math.cos(phase) + x[2*j+1] * Math.sin(phase));
        }
        return pred;
    });

    return { predicted, constituents: harmonicParams, nodalCorrectionsApplied: useNodal, shallowWaterIncluded: inclShallow };
}

// Cholesky solver for symmetric positive-definite system
function solveCholesky(A, b, n) {
    // L L^T = A
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = 0;
            for (let k = 0; k < j; k++) sum += L[i * n + k] * L[j * n + k];
            if (i === j) {
                const val = A[i * n + i] - sum;
                L[i * n + j] = val > 0 ? Math.sqrt(val) : 1e-10;
            } else {
                L[i * n + j] = (A[i * n + j] - sum) / L[j * n + j];
            }
        }
    }
    // Forward substitution: L y = b
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < i; k++) sum += L[i * n + k] * y[k];
        y[i] = (b[i] - sum) / L[i * n + i];
    }
    // Back substitution: L^T x = y
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sum = 0;
        for (let k = i + 1; k < n; k++) sum += L[k * n + i] * x[k];
        x[i] = (y[i] - sum) / L[i * n + i];
    }
    return x;
}

// ═══════════════════════════════════════════════════════════════
//  FFT (Phase 5 item 25 — Cooley-Tukey radix-2)
// ═══════════════════════════════════════════════════════════════
function fftRadix2(re, im) {
    const n = re.length;
    if (n <= 1) return;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const ang = -2 * Math.PI / len;
        const wRe = Math.cos(ang), wIm = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let j = 0; j < half; j++) {
                const tRe = curRe * re[i + j + half] - curIm * im[i + j + half];
                const tIm = curRe * im[i + j + half] + curIm * re[i + j + half];
                re[i + j + half] = re[i + j] - tRe;
                im[i + j + half] = im[i + j] - tIm;
                re[i + j] += tRe;
                im[i + j] += tIm;
                const newRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = newRe;
            }
        }
    }
}

function performAdvancedFFT(processedData, meanHeight) {
    const signal = processedData.map(d => d.height - meanHeight);
    const n = processedData.length;
    // Hamming window
    const windowed = signal.map((v, i) => v * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1))));
    const timeRange = (processedData[n - 1].timestamp - processedData[0].timestamp) / 1000;
    const sampleRate = n / timeRange;
    const fftSize = 1 << Math.ceil(Math.log2(n));
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let i = 0; i < n; i++) re[i] = windowed[i];

    fftRadix2(re, im);

    const peaks = [];
    for (let k = 1; k < fftSize / 2; k++) {
        const amp = 2 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / fftSize;
        if (amp > 0.5) {
            peaks.push({
                frequency: k * sampleRate / fftSize,
                amplitude: amp,
                phase: Math.atan2(im[k], re[k]) * 180 / Math.PI,
                period: fftSize / (k * sampleRate)
            });
        }
    }
    const count = parseInt(document.getElementById('constituentsCount').value);
    peaks.sort((a, b) => b.amplitude - a.amplitude);
    const topPeaks = peaks.slice(0, count);

    const startTime = processedData[0].timestamp;
    const predicted = processedData.map(d => {
        let pred = meanHeight;
        const t = (d.timestamp - startTime) / 1000;
        topPeaks.forEach(p => {
            pred += p.amplitude * Math.cos(2 * Math.PI * p.frequency * t + p.phase * Math.PI / 180);
        });
        return pred;
    });
    return { predicted, fftPeaks: topPeaks, sampleRate, windowType: 'Hamming' };
}

// ═══════════════════════════════════════════════════════════════
//  HYBRID — cross-validated (Phase 5 item 24)
//  80/20 train/test split. Metrics reported on TEST set only.
// ═══════════════════════════════════════════════════════════════
function performHybridAnalysis(processedData, meanHeight, latitude, longitude) {
    const splitIdx = Math.floor(processedData.length * 0.8);
    const trainData = processedData.slice(0, splitIdx);
    const testData = processedData.slice(splitIdx);

    // Fit on train
    const trainMean = trainData.reduce((s, d) => s + d.height, 0) / trainData.length;
    const harmonicResult = performAdvancedHarmonic(trainData, trainMean, latitude, longitude);

    // Predict on full dataset using train-fitted params
    const startTime = trainData[0].timestamp;
    const constituents = harmonicResult.constituents;
    const predictFn = (d) => {
        let pred = trainMean;
        const t = d.timestamp - startTime;
        Object.values(constituents).forEach(p => {
            const omega = (p.frequency * Math.PI / 180) / 3600000;
            pred += p.a * Math.cos(omega * t + p.nodalU * Math.PI / 180) +
                    p.b * Math.sin(omega * t + p.nodalU * Math.PI / 180);
        });
        return pred;
    };

    const predicted = processedData.map(predictFn);

    return {
        predicted,
        constituents,
        trainSize: splitIdx,
        testSize: testData.length,
        method: 'hybrid',
        evaluationSet: 'test'
    };
}
