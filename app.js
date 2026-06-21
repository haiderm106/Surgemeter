(() => {
  'use strict';

  // ---------- State ----------
  let rawRows = [];        // [{dt: Date, pressure: number}]
  let chart = null;
  let lastFileName = '';

  // ---------- DOM refs ----------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileLoaded = document.getElementById('fileLoaded');
  const errorBanner = document.getElementById('errorBanner');
  const controlsPanel = document.getElementById('controlsPanel');
  const emptyState = document.getElementById('emptyState');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const statCard = document.getElementById('statCard');
  const headerStats = document.getElementById('headerStats');
  const footerRight = document.getElementById('footerRight');

  const pressureThreshold = document.getElementById('pressureThreshold');
  const pressureThresholdVal = document.getElementById('pressureThresholdVal');
  const timeThreshold = document.getElementById('timeThreshold');
  const timeThresholdVal = document.getElementById('timeThresholdVal');
  const lineWidth = document.getElementById('lineWidth');
  const lineWidthVal = document.getElementById('lineWidthVal');
  const showBreakMarkers = document.getElementById('showBreakMarkers');

  const resetZoomBtn = document.getElementById('resetZoomBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');

  // ---------- Helpers ----------

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  function setLoading(on) {
    loadingOverlay.style.display = on ? 'flex' : 'none';
  }

  // Mirrors the Python regex fix:
  //   "(\d+:\d+:\d+)\s(AM|PM)\.(\d+)"  ->  "\1.\3 \2"
  // i.e. "10:15:32 AM.450" -> "10:15:32.450 AM"
  function fixTimeString(t) {
    if (!t) return t;
    t = t.trim();
    const re = /(\d+:\d+:\d+)\s(AM|PM)\.(\d+)/i;
    const m = t.match(re);
    if (m) {
      return `${m[1]}.${m[3]} ${m[2].toUpperCase()}`;
    }
    return t;
  }

  // Parse "DD/MM/YYYY" + "H:MM:SS.fff AM/PM" into a Date.
  // Mirrors pandas format="%d/%m/%Y %I:%M:%S.%f %p"
  function parseDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    dateStr = dateStr.trim();
    timeStr = fixTimeString(timeStr);

    const dateMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!dateMatch) return null;
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);

    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(AM|PM)$/i);
    if (!timeMatch) return null;

    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const second = parseInt(timeMatch[3], 10);
    const fracStr = timeMatch[4] || '0';
    // pandas %f expects microseconds (up to 6 digits); we only need ms precision for JS Date
    const ms = Math.round(parseFloat('0.' + fracStr) * 1000);
    const ampm = timeMatch[5].toUpperCase();

    if (hour < 1 || hour > 12) return null;
    if (ampm === 'AM') {
      hour = (hour === 12) ? 0 : hour;
    } else {
      hour = (hour === 12) ? 12 : hour + 12;
    }

    const d = new Date(year, month - 1, day, hour, minute, second, ms);
    if (isNaN(d.getTime())) return null;
    // sanity-check round trip (catches e.g. month=13, day=32 silently rolling over)
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
  }

  function parseCSV(text) {
    const result = Papa.parse(text, {
      header: false,
      skipEmptyLines: true,
      dynamicTyping: false
    });

    const rows = [];
    let skipped = 0;

    for (const fields of result.data) {
      if (!fields || fields.length < 3) { skipped++; continue; }
      const [dateStr, timeStr, pressureStr] = fields;
      const dt = parseDateTime(dateStr, timeStr);
      const pressure = parseFloat(pressureStr);

      if (!dt || isNaN(pressure)) { skipped++; continue; }
      rows.push({ dt, pressure });
    }

    // sort by datetime, like df.sort_values("DateTime")
    rows.sort((a, b) => a.dt - b.dt);

    return { rows, skipped, totalLines: result.data.length };
  }

  // Apply break-point detection: returns array of {x: <ms timestamp>, y: number|null}
  // x is a plain millisecond timestamp (not a Date) so the chart can use a fast
  // linear scale with a custom tick formatter, instead of depending on a
  // separate date-adapter library for a Chart.js "time" scale.
  function applyBreaks(rows, pressureJumpThresh, timeGapSeconds) {
    const points = [];
    const breakIndices = [];

    for (let i = 0; i < rows.length; i++) {
      const cur = rows[i];
      let isBreak = false;

      if (i > 0) {
        const prev = rows[i - 1];
        const pChange = Math.abs(cur.pressure - prev.pressure);
        const tChangeMs = cur.dt - prev.dt;
        if (pChange > pressureJumpThresh || tChangeMs > timeGapSeconds * 1000) {
          isBreak = true;
        }
      }

      if (isBreak) {
        breakIndices.push(i);
        points.push({ x: cur.dt.getTime(), y: null });
      } else {
        points.push({ x: cur.dt.getTime(), y: cur.pressure });
      }
    }

    return { points, breakIndices };
  }

  // Paints a solid background behind the chart so exported PNGs aren't
  // transparent (Chart.js canvases have no background fill by default).
  const backgroundPlugin = {
    id: 'customCanvasBackground',
    beforeDraw(chartInstance) {
      const { ctx, width, height } = chartInstance;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#11151b';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  };
  if (window.Chart) {
    Chart.register(backgroundPlugin);
  }

  function fmtNum(n, decimals = 2) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // Adaptive axis-tick formatter: shows more/less detail depending on the
  // visible time span, so zoomed-in views reveal sub-second ticks while a
  // full multi-hour view stays readable.
  function fmtTick(ms, spanMs) {
    const d = new Date(ms);
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    if (spanMs < 5000) {
      // sub-5s span: show seconds + milliseconds
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }
    if (spanMs < 1000 * 60 * 60 * 6) {
      // under 6h span: show time only
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    // longer spans: show date + time
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------- Rendering ----------

  function render() {
    if (!rawRows.length) return;

    const pThresh = parseFloat(pressureThreshold.value);
    const tThresh = parseFloat(timeThreshold.value);
    const lw = parseFloat(lineWidth.value);

    const { points, breakIndices } = applyBreaks(rawRows, pThresh, tThresh);

    // Build break-marker dataset: small points at the break locations (using the
    // pressure value just before the break, so markers sit on the trace).
    const breakMarkerPoints = showBreakMarkers.checked
      ? breakIndices.map(i => ({ x: rawRows[i - 1].dt.getTime(), y: rawRows[i - 1].pressure }))
      : [];

    const datasets = [
      {
        label: 'Pressure',
        data: points,
        borderColor: '#5dd8e8',
        backgroundColor: 'rgba(93, 216, 232, 0.08)',
        borderWidth: lw,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 8,
        spanGaps: false,
        tension: 0,
        order: 2
      }
    ];

    if (showBreakMarkers.checked && breakMarkerPoints.length) {
      datasets.push({
        label: 'Detected break',
        data: breakMarkerPoints,
        showLine: false,
        pointRadius: 3.5,
        pointBackgroundColor: '#e8a33d',
        pointBorderColor: '#13171c',
        pointBorderWidth: 1,
        pointHoverRadius: 5,
        order: 1
      });
    }

    if (chart) {
      chart.data.datasets = datasets;
      chart.update('none');
    } else {
      buildChart(datasets);
    }

    updateStats(points, breakIndices, pThresh, tThresh);
  }

  function buildChart(datasets) {
    const ctx = document.getElementById('chartCanvas').getContext('2d');

    chart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1f27',
            borderColor: '#2a313c',
            borderWidth: 1,
            titleColor: '#8b96a3',
            bodyColor: '#e8eaed',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12, weight: '600' },
            padding: 10,
            displayColors: false,
            callbacks: {
              title: (items) => {
                return fmtDateTime(new Date(items[0].parsed.x));
              },
              label: (item) => {
                if (item.parsed.y === null) return null;
                return `${item.dataset.label}: ${fmtNum(item.parsed.y, 3)}`;
              }
            }
          },
          zoom: {
            zoom: {
              wheel: { enabled: true, speed: 0.08 },
              pinch: { enabled: true },
              drag: { enabled: true, backgroundColor: 'rgba(93,216,232,0.12)', borderColor: '#5dd8e8', borderWidth: 1 },
              mode: 'x'
            },
            pan: { enabled: true, mode: 'x', modifierKey: 'ctrl' },
            limits: { x: { minRange: 1000 } }
          }
        },
        scales: {
          x: {
            type: 'linear',
            grid: { color: '#242b35', tickColor: '#2a313c' },
            ticks: {
              color: '#8b96a3',
              font: { family: "'JetBrains Mono', monospace", size: 10.5 },
              maxRotation: 0,
              autoSkipPadding: 24,
              callback: function (value) {
                const scale = this.chart.scales.x;
                const span = scale.max - scale.min;
                return fmtTick(value, span);
              }
            },
            title: { display: true, text: 'Date / Time', color: '#8b96a3', font: { family: "'Inter', sans-serif", size: 11.5 } }
          },
          y: {
            grid: { color: '#242b35', tickColor: '#2a313c' },
            ticks: { color: '#8b96a3', font: { family: "'JetBrains Mono', monospace", size: 10.5 } },
            title: { display: true, text: 'Pressure', color: '#8b96a3', font: { family: "'Inter', sans-serif", size: 11.5 } }
          }
        }
      }
    });
  }

  function updateStats(points, breakIndices, pThresh, tThresh) {
    const validPressures = points.filter(p => p.y !== null).map(p => p.y);
    const min = validPressures.length ? Math.min(...validPressures) : null;
    const max = validPressures.length ? Math.max(...validPressures) : null;
    const first = rawRows[0]?.dt;
    const last = rawRows[rawRows.length - 1]?.dt;

    statCard.innerHTML = `
      <div class="stat-row"><span>Readings</span><span>${rawRows.length.toLocaleString()}</span></div>
      <div class="stat-row"><span>Break points</span><span>${breakIndices.length.toLocaleString()}</span></div>
      <div class="stat-row"><span>Segments</span><span>${(breakIndices.length + 1).toLocaleString()}</span></div>
      <div class="stat-row"><span>Pressure range</span><span>${min !== null ? fmtNum(min, 2) + ' – ' + fmtNum(max, 2) : '—'}</span></div>
      <div class="stat-row"><span>Start</span><span>${fmtDateTime(first)}</span></div>
      <div class="stat-row"><span>End</span><span>${fmtDateTime(last)}</span></div>
    `;

    headerStats.innerHTML = `
      <span><b>${rawRows.length.toLocaleString()}</b> readings</span>
      <span><b>${breakIndices.length.toLocaleString()}</b> breaks</span>
      <span><b>${(breakIndices.length + 1).toLocaleString()}</b> segments</span>
    `;

    footerRight.textContent = `${lastFileName} · ${rawRows.length.toLocaleString()} rows`;
  }

  // ---------- File handling ----------

  function handleFile(file) {
    if (!file) return;
    clearError();

    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    if (!isCsv) {
      showError(`"${file.name}" doesn't look like a CSV file. Please upload a .csv export of your pressure log.`);
      return;
    }

    setLoading(true);
    lastFileName = file.name;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const { rows, skipped, totalLines } = parseCSV(text);

        if (!rows.length) {
          setLoading(false);
          showError('No valid rows found. Expected columns: Date (DD/MM/YYYY), Time (e.g. "10:15:32 AM.450"), Pressure — with no header row.');
          return;
        }

        rawRows = rows;
        fileLoaded.textContent = `✓ ${file.name} — ${rows.length.toLocaleString()} valid rows${skipped ? ` (${skipped.toLocaleString()} skipped)` : ''}`;
        fileLoaded.style.display = 'block';
        controlsPanel.style.display = 'flex';
        emptyState.style.display = 'none';

        if (skipped > 0 && skipped / totalLines > 0.3) {
          showError(`Heads up: ${skipped.toLocaleString()} of ${totalLines.toLocaleString()} rows couldn't be parsed and were skipped. Check that the file matches the expected Date, Time, Pressure format with no header row.`);
        }

        setLoading(false);
        render();
      } catch (err) {
        setLoading(false);
        showError('Failed to parse this file: ' + err.message);
      }
    };
    reader.onerror = () => {
      setLoading(false);
      showError('Could not read this file. Please try again.');
    };
    reader.readAsText(file);
  }

  // ---------- Event wiring ----------

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // Prevent the whole page from navigating away if a file is dropped outside the zone
  ['dragover', 'drop'].forEach(evt => {
    window.addEventListener(evt, (e) => e.preventDefault());
  });

  pressureThreshold.addEventListener('input', () => {
    pressureThresholdVal.textContent = fmtNum(pressureThreshold.value, 2);
    render();
  });

  timeThreshold.addEventListener('input', () => {
    timeThresholdVal.textContent = fmtNum(timeThreshold.value, 1) + 's';
    render();
  });

  lineWidth.addEventListener('input', () => {
    lineWidthVal.textContent = fmtNum(lineWidth.value, 1);
    render();
  });

  showBreakMarkers.addEventListener('change', render);

  resetZoomBtn.addEventListener('click', () => {
    if (chart) chart.resetZoom();
  });

  zoomInBtn.addEventListener('click', () => { if (chart) chart.zoom(1.2); });
  zoomOutBtn.addEventListener('click', () => { if (chart) chart.zoom(0.8); });

  downloadBtn.addEventListener('click', () => {
    if (!chart) return;
    const link = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    link.download = `pressure-surge-${ts}.png`;
    link.href = chart.toBase64Image('image/png', 1);
    link.click();
  });

  // Init thresholds display
  pressureThresholdVal.textContent = fmtNum(pressureThreshold.value, 2);
  timeThresholdVal.textContent = fmtNum(timeThreshold.value, 1) + 's';
  lineWidthVal.textContent = fmtNum(lineWidth.value, 1);

})();
