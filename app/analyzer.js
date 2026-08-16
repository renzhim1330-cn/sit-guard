/* 坐姿素材离线分析（票 08）
 * 流程：选本地视频 → 顺序播放逐帧检测（MediaPipe）→ 复用 measure.js 算三度量
 *       → 自动取开头「标准坐」段为基准（可在轨迹图上框选改）→ 偏离图标注 / 自动切分台阶
 *       → 区间统计（均值/P25/P50/P75/max）+ 直方图 + 阈值建议
 *       → 用 engine.js 同一判定引擎按当前阈值（含迟滞/宽限/冷却）模拟提醒，标出触发帧，正常段统计误报
 *       → 导出 CSV。全程本地，视频不上传。
 * 阈值/偏离统一用「显示单位」：驼背°、头过低%（内部比例×100）、侧倾°；引擎内部为原始单位。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const KEYS = ['slouch', 'headDrop', 'tilt'];
  const META = {
    slouch:   { label: '驼背',   unit: '°', t1: 8,   t2: 12,  hys: 2,  scale: 1,   decimals: 1 },
    headDrop: { label: '头过低', unit: '%', t1: 12,  t2: 20,  hys: 3,  scale: 100, decimals: 0 },
    tilt:     { label: '侧倾',   unit: '°', t1: 8,   t2: 12,  hys: 2,  scale: 1,   decimals: 1 },
  };
  const COLORS = { slouch: '#4ade80', headDrop: '#60a5fa', tilt: '#fbbf24' };
  const GRACE_DEFAULT = 3.5;

  let poseLandmarker = null, collecting = false, lastVideoTime = -1;
  let frames = [];          // 每帧原始度量 {t, slouch, headDrop, tilt}
  let baseline = null;      // 基准（各度量均值，原始单位）
  let duration = 0;
  let segs = [];            // 区间标注 [{name, t0, t1}]
  let selection = null;     // 偏离图拖拽选区 {t0, t1} | null
  let baseSelection = null; // 轨迹图拖拽的基准选区 {t0, t1} | null
  let playheadT = null;     // 回放定位时刻（播放头）
  let sim = null;           // 引擎模拟 { reminders:[{t,posture}], badAt:Set<时间> }
  let drag = null;          // {cv, mode:'pan'|'base'|'select', ...}
  let viewport = { t0: 0, t1: 0 };

  const video = $('video');
  const chartCard = $('chartCard');

  /* ---------------- MediaPipe ---------------- */
  async function initMP() {
    if (poseLandmarker) return;
    if (window.__mpError) throw new Error('MediaPipe CDN 加载失败（需联网）：' + window.__mpError);
    if (!window.__mp) await new Promise((res) => window.addEventListener('mp-loaded', res, { once: true }));
    const wasm = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
    const model = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
    const vision = await window.__mp.FilesetResolver.forVisionTasks(wasm);
    try {
      poseLandmarker = await window.__mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 1,
      });
    } catch (e) {
      poseLandmarker = await window.__mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1,
      });
    }
  }

  /* ---------------- 文件选择 ---------------- */
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    collecting = false;               // 防止收集途中换文件时旧循环继续混入数据
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(f);
    frames = []; baseline = null; segs = []; selection = null; baseSelection = null;
    sim = null; playheadT = null;
    chartCard.hidden = true;
    chartCard.classList.remove('ready');
    $('baseInfo').textContent = '';
    $('segInfo').textContent = '';
    video.onloadedmetadata = () => {
      duration = video.duration;
      viewport = { t0: 0, t1: duration };
      $('baseEnd').value = Math.min(3, duration).toFixed(1);
      $('btnAnalyze').disabled = false;
      $('progress').textContent = '已加载 ' + duration.toFixed(1) + 's 视频，可开始收集';
    };
  });

  /* ---------------- 收集 ---------------- */
  $('btnAnalyze').addEventListener('click', async () => {
    $('btnAnalyze').disabled = true;
    $('progress').textContent = '加载模型…（首次需联网下载，约几秒）';
    try { await initMP(); } catch (err) {
      $('progress').textContent = '模型加载失败：' + (err && err.message ? err.message : err);
      $('btnAnalyze').disabled = false;
      return;
    }
    frames = []; baseline = null; lastVideoTime = -1; collecting = true;
    video.controls = false;
    video.currentTime = 0;
    $('progress').textContent = '收集中…';
    try { await video.play(); } catch (err) {
      $('progress').textContent = '播放失败：' + (err && err.message ? err.message : err);
      collecting = false; $('btnAnalyze').disabled = false;
      return;
    }
    requestAnimationFrame(loop);
  });

  function loop(ts) {
    if (!collecting) return;
    requestAnimationFrame(loop);
    if (!poseLandmarker || video.readyState < 2) return;
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    let r = null;
    try { r = poseLandmarker.detectForVideo(video, ts); } catch (e) { return; }
    if (r && r.landmarks && r.landmarks[0]) {
      const m = SitGuardMeasure.measurePose(r.landmarks[0], r.worldLandmarks);
      frames.push({ t: video.currentTime, slouch: m.slouch, headDrop: m.headDrop, tilt: m.tilt });
    }
    $('progress').textContent = '收集中… ' + video.currentTime.toFixed(1) + 's / ' + duration.toFixed(1) + 's（' + frames.length + ' 帧）';
    if (video.currentTime >= duration - 0.03) finish();
  }
  video.addEventListener('ended', finish);
  function finish() {
    if (!collecting) return;
    collecting = false;
    video.controls = true;
    $('progress').textContent = '收集完成：' + frames.length + ' 帧';
    if (!frames.length) { $('progress').textContent += '（未检测到人，请检查视频）'; return; }
    viewport = { t0: 0, t1: duration || frames[frames.length - 1].t };
    chartCard.hidden = false;
    chartCard.classList.add('ready');
    // 默认基准：开头「标准坐」段（0 ~ min(3s, 时长)）；素材按拍摄规则 1 均以标准坐开头
    const s = parseFloat($('baseStart').value) || 0;
    const e = parseFloat($('baseEnd').value) || Math.min(3, duration || 3);
    applyBase(s, e, true);
    redraw();
  }

  /* ---------------- 基准与偏离 ---------------- */
  function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  function applyBase(s, e, silent) {
    if (!frames.length || !(s < e)) return false;
    const seg = frames.filter((f) => f.t >= s && f.t <= e);
    if (seg.length < 3) { if (!silent) alert('基准段内帧太少，请拉长区间或重选'); return false; }
    baseline = {};
    for (const k of KEYS) baseline[k] = avg(seg.map((f) => f[k]));
    $('baseInfo').textContent = (silent ? '默认' : '') + '基准已更新：' + KEYS.map((k) => META[k].label + ' ' + (baseline[k] * META[k].scale).toFixed(META[k].decimals) + META[k].unit).join(' · ');
    return true;
  }

  $('btnApplyBase').addEventListener('click', () => {
    const s = parseFloat($('baseStart').value), e = parseFloat($('baseEnd').value);
    if (!isFinite(s) || !isFinite(e)) return;
    applyBase(s, e, false);
    redraw();
  });

  // 偏离值（显示单位）
  function dev(k, raw) { return baseline ? Math.abs(raw - baseline[k]) * META[k].scale : 0; }

  /* ---------------- 阈值输入（t1 / t2 / 迟滞 / 宽限，显示单位） ---------------- */
  function stepOf(k) { return k === 'headDrop' ? 1 : 0.5; }
  function renderThresholdInputs() {
    $('thresholdInputs').innerHTML = KEYS.map((k) =>
      '<span class="muted">' + META[k].label + '　</span>' +
      '<label>t1</label><input type="number" data-k="' + k + '.t1" value="' + META[k].t1 + '" step="' + stepOf(k) + '">' +
      '<label>t2</label><input type="number" data-k="' + k + '.t2" value="' + META[k].t2 + '" step="' + stepOf(k) + '">' +
      '<label>迟滞</label><input type="number" data-k="' + k + '.hys" value="' + META[k].hys + '" step="' + stepOf(k) + '">'
    ).join('<span class="muted">　|　</span>') +
      '<span class="muted">　|　宽限</span><input type="number" id="graceInput" value="' + GRACE_DEFAULT + '" step="0.5" min="1" max="10"><label>秒</label>';
  }
  function threshold(k, which) {
    const el = document.querySelector('[data-k="' + k + '.' + which + '"]');
    const v = el ? parseFloat(el.value) : META[k][which];
    return isFinite(v) && v > 0 ? v : META[k][which];
  }
  function graceSec() {
    const el = $('graceInput');
    const v = el ? parseFloat(el.value) : GRACE_DEFAULT;
    return isFinite(v) && v > 0 ? v : GRACE_DEFAULT;
  }
  $('thresholdInputs').addEventListener('input', () => { if (baseline) redraw(); });

  /* ---------------- 引擎提醒模拟（与 App 完全同一 engine.js） ---------------- */
  function runSim() {
    if (!baseline) { sim = null; return; }
    const cfg = {
      postures: {},
      graceSeconds: graceSec(), cooldownSeconds: 30, praiseMinInterval: 20, praiseHoldSeconds: 6, recoveryHoldSeconds: 6,
    };
    for (const k of KEYS) {
      const div = k === 'headDrop' ? 100 : 1;   // 显示单位 → 引擎原始单位
      cfg.postures[k] = {
        t1: threshold(k, 't1') / div,
        t2: threshold(k, 't2') / div,
        hys: threshold(k, 'hys') / div,
      };
    }
    const eng = SitGuardEngine.createEngine(cfg);
    eng.calibrate({ ...baseline });
    const reminders = [];
    const badAt = new Set();
    let prevT = null;
    for (const f of frames) {
      const dt = prevT == null ? 0 : Math.max(0, f.t - prevT);
      prevT = f.t;
      const res = eng.tick({ slouch: f.slouch, headDrop: f.headDrop, tilt: f.tilt }, dt);
      if (res && res.states) {
        for (const k of KEYS) if (res.states[k].band === 'bad') { badAt.add(f.t); break; }
        for (const ev of res.events) if (ev.type === 'reminder') reminders.push({ t: f.t, posture: ev.posture });
      }
    }
    sim = { reminders, badAt };
  }

  /* ---------------- 图表 ---------------- */
  function setupCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawBand(ctx, xOf, a, b, h, fill, stroke) {
    const x0 = xOf(a), x1 = xOf(b);
    ctx.fillStyle = fill;
    ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), h);
    ctx.strokeStyle = stroke;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.min(x0, x1), 0.5, Math.abs(x1 - x0), h - 1);
    ctx.setLineDash([]);
  }

  function drawChart(cv, mode) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!frames.length) return;
    if (mode === 'dev' && !baseline) {
      ctx.fillStyle = '#9ca3af'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('请先在②应用基准，再查看偏离图', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const subH = h / KEYS.length;
    const [t0, t1] = [viewport.t0, viewport.t1];
    const span = Math.max(1e-3, t1 - t0);
    const xOf = (t) => (t - t0) / span * w;

    KEYS.forEach((k, i) => {
      const top = i * subH;
      const visible = [];
      for (const f of frames) {
        if (f.t < t0 || f.t > t1) continue;
        visible.push(mode === 'raw' ? f[k] * META[k].scale : dev(k, f[k]));
      }
      let ymin = Infinity, ymax = -Infinity;
      for (const v of visible) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
      if (!visible.length) { ymin = 0; ymax = 1; }
      else if (ymax - ymin < 1e-6) { ymax = ymin + 1; }
      const pad = (ymax - ymin) * 0.15;
      ymin -= pad; ymax += pad;
      const yOf = (v) => top + subH - (v - ymin) / (ymax - ymin) * subH;

      ctx.fillStyle = 'rgba(255,255,255,.04)';
      ctx.fillRect(0, top, w, subH);
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(w, top); ctx.stroke();

      if (mode === 'dev' && baseline) {
        for (const which of ['t1', 't2']) {
          const tv = threshold(k, which);
          ctx.strokeStyle = which === 't1' ? 'rgba(251,191,36,.7)' : 'rgba(248,113,113,.7)';
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(0, yOf(tv)); ctx.lineTo(w, yOf(tv)); ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      ctx.strokeStyle = COLORS[k];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const f of frames) {
        if (f.t < t0 || f.t > t1) continue;
        const v = mode === 'raw' ? f[k] * META[k].scale : dev(k, f[k]);
        const x = xOf(f.t), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = COLORS[k];
      ctx.font = '11px sans-serif';
      ctx.fillText(META[k].label + (mode === 'dev' ? ' 偏离' : '') + ' 范围 ' + (ymin + pad).toFixed(META[k].decimals) + '~' + (ymax - pad).toFixed(META[k].decimals) + META[k].unit, 8, top + 14);
    });

    // 提醒触发帧（红竖线 + 顶部三角）
    if (mode === 'dev' && sim && sim.reminders.length) {
      ctx.strokeStyle = 'rgba(248,113,113,.85)';
      ctx.lineWidth = 1.5;
      for (const r of sim.reminders) {
        if (r.t < t0 || r.t > t1) continue;
        const x = xOf(r.t);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.fillStyle = '#f87171';
        ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x - 5, 11); ctx.lineTo(x + 5, 11); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#f87171';
      ctx.font = '11px sans-serif';
      ctx.fillText('▲ 提醒触发帧（共 ' + sim.reminders.length + ' 次）', w - 190, h - 18);
    }

    // 区间带：轨迹图 = 基准框选；偏离图 = 标注区间 / 当前选区
    if (mode === 'raw') {
      if (baseSelection) drawBand(ctx, xOf, baseSelection.t0, baseSelection.t1, h, 'rgba(96,165,250,.25)', '#60a5fa');
    } else {
      const bands = [...segs];
      if (selection) bands.push({ t0: selection.t0, t1: selection.t1, _sel: true });
      for (const b of bands) drawBand(ctx, xOf, b.t0, b.t1, h, b._sel ? 'rgba(96,165,250,.22)' : 'rgba(74,222,128,.16)', b._sel ? '#60a5fa' : '#4ade80');
    }

    // 回放播放头
    if (playheadT != null && playheadT >= t0 && playheadT <= t1) {
      ctx.strokeStyle = 'rgba(148,163,184,.85)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(xOf(playheadT), 0); ctx.lineTo(xOf(playheadT), h); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 时间轴刻度
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px sans-serif';
    const step = niceStep(span);
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      ctx.fillText(t.toFixed(1) + 's', xOf(t) - 14, h - 4);
    }
  }
  function niceStep(span) {
    const target = span / 6;
    const pow = Math.pow(10, Math.floor(Math.log10(target || 1)));
    for (const m of [1, 2, 5, 10]) if (pow * m >= target) return pow * m;
    return pow * 10;
  }
  function redraw() {
    if (!drag) runSim();
    drawChart($('rawChart'), 'raw');
    drawChart($('devChart'), 'dev');
    renderSegTable();
    renderSuggestion();
  }

  /* ---------------- 交互（缩放 / 平移 / 框选 / 回放定位） ---------------- */
  function xToT(cv, x) {
    const r = cv.getBoundingClientRect();
    return viewport.t0 + (x - r.left) / r.width * (viewport.t1 - viewport.t0);
  }
  function seekVideo(t) {
    if (!isFinite(duration) || duration <= 0) return;
    const v = Math.min(Math.max(0, t), duration - 0.05);
    video.currentTime = v;
    playheadT = v;
    drawChart($('rawChart'), 'raw');
    drawChart($('devChart'), 'dev');
  }
  function bindInteraction(cv, cvMode) {
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const anchor = xToT(cv, e.clientX);
      const factor = Math.exp(e.deltaY * 0.001);
      viewport = {
        t0: anchor - (anchor - viewport.t0) * factor,
        t1: anchor + (viewport.t1 - anchor) * factor,
      };
      clampViewport(); redraw();
    }, { passive: false });
    cv.addEventListener('mousedown', (e) => {
      const t = xToT(cv, e.clientX);
      if (e.altKey) {
        drag = { cv, mode: 'pan', startX: e.clientX, t0: viewport.t0, t1: viewport.t1 };
      } else if (cvMode === 'base') {
        drag = { cv, mode: 'base', t0: t };
        baseSelection = { t0: t, t1: t };
      } else {
        drag = { cv, mode: 'select', t0: t };
        selection = { t0: t, t1: t };
      }
      redraw();
    });
    cv.addEventListener('dblclick', () => {
      viewport = { t0: 0, t1: duration || (frames.length ? frames[frames.length - 1].t : 1) };
      redraw();
    });
  }
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (drag.mode === 'pan') {
      const rect = drag.cv.getBoundingClientRect();
      const dx = (e.clientX - drag.startX) / rect.width * (drag.t1 - drag.t0);
      viewport = { t0: drag.t0 - dx, t1: drag.t1 - dx };
      clampViewport();
    } else {
      const t = xToT(drag.cv, e.clientX);
      if (drag.mode === 'base') baseSelection = { t0: drag.t0, t1: Math.max(drag.t0, t) };
      else selection = { t0: drag.t0, t1: Math.max(drag.t0, t) };
    }
    redraw();
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'select') {
      if (selection && selection.t1 - selection.t0 > 0.05) {
        $('segInfo').textContent = '已选 ' + selection.t0.toFixed(1) + '~' + selection.t1.toFixed(1) + 's，输入名称后点「添加选中区间」';
      } else {
        selection = null;
        seekVideo(xToT(d.cv, e.clientX));
      }
    } else if (d.mode === 'base') {
      if (baseSelection && baseSelection.t1 - baseSelection.t0 >= 0.2) {
        $('baseStart').value = baseSelection.t0.toFixed(1);
        $('baseEnd').value = baseSelection.t1.toFixed(1);
        applyBase(baseSelection.t0, baseSelection.t1, false);
      } else {
        seekVideo(xToT(d.cv, e.clientX));
      }
      baseSelection = null;
    }
    redraw();
  });
  function clampViewport() {
    const max = duration || (frames.length ? frames[frames.length - 1].t : 1);
    const span = Math.max(0.2, viewport.t1 - viewport.t0);
    if (viewport.t0 < 0) { viewport.t0 = 0; viewport.t1 = span; }
    if (viewport.t1 > max) { viewport.t1 = max; viewport.t0 = Math.max(0, max - span); }
  }
  // 回放：视频播放/拖动时同步播放头
  video.addEventListener('timeupdate', () => {
    playheadT = video.currentTime;
    if (collecting || chartCard.hidden) return;
    drawChart($('rawChart'), 'raw');
    drawChart($('devChart'), 'dev');
  });

  /* ---------------- 区间统计 ---------------- */
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function statsOf(values) {
    const s = values.slice().sort((a, b) => a - b);
    return { n: s.length, mean: avg(s), p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75), max: s.length ? s[s.length - 1] : 0 };
  }
  function segStats(seg) {
    const out = { name: seg.name, t0: seg.t0, t1: seg.t1, dur: seg.t1 - seg.t0 };
    for (const k of KEYS) {
      const vals = frames.filter((f) => f.t >= seg.t0 && f.t <= seg.t1).map((f) => dev(k, f[k]));
      out[k] = statsOf(vals);
    }
    return out;
  }

  $('btnAddSeg').addEventListener('click', () => {
    if (!baseline) { alert('请先在②应用基准'); return; }
    if (!selection) { alert('请先在偏离图上按住拖动选择时间区间'); return; }
    const name = $('segName').value.trim() || ('区间 ' + (segs.length + 1));
    segs.push({ name, t0: selection.t0, t1: selection.t1 });
    selection = null;
    $('segInfo').textContent = '';
    redraw();
  });
  $('btnDelSeg').addEventListener('click', () => { segs.pop(); selection = null; redraw(); });

  /* ---------------- 自动切分「标准→动作→回正」台阶 ---------------- */
  function avgDt() {
    if (frames.length < 2) return 1 / 30;
    return (frames[frames.length - 1].t - frames[0].t) / (frames.length - 1);
  }
  function detectRegions() {
    // 每帧相对偏离分：max(偏离/t2)，三度量取最大
    const score = frames.map((f) => {
      let s = 0;
      for (const k of KEYS) s = Math.max(s, dev(k, f[k]) / threshold(k, 't2'));
      return s;
    });
    // 平滑：±0.35s 滚动均值
    const win = Math.max(3, Math.round(0.35 / avgDt()));
    const sm = frames.map((_, i) => {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(frames.length - 1, i + win); j++) { sum += score[j]; n++; }
      return sum / n;
    });
    // 活动区：sm ≥ 25% × t2；合并间隙 < 0.8s；丢弃 < 0.9s 的碎段
    const ACT = 0.25, MIN_GAP = 0.8, MIN_LEN = 0.9;
    const runs = [];
    let cur = null;
    for (let i = 0; i < frames.length; i++) {
      if (sm[i] >= ACT) { if (!cur) cur = { i0: i, i1: i }; else cur.i1 = i; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && frames[r.i0].t - frames[last.i1].t < MIN_GAP) last.i1 = r.i1;
      else merged.push({ i0: r.i0, i1: r.i1 });
    }
    const regions = [];
    for (const r of merged) {
      const t0 = frames[r.i0].t, t1 = frames[r.i1].t;
      if (t1 - t0 < MIN_LEN) continue;
      const slice = frames.slice(r.i0, r.i1 + 1);
      const mean = {};
      for (const k of KEYS) mean[k] = avg(slice.map((f) => dev(k, f[k])));
      regions.push({ t0, t1, mean });
    }
    // 命名：主导度量（偏离/t2 最大者）分组；组内按均值升序三等分 → 轻/中/重；
    // 该度量所有段都低于 t1（如「正常小动作」素材）→ 全部叫「动作段」，不进分档统计
    const byKey = {};
    for (const r of regions) {
      let dom = KEYS[0], best = -1;
      for (const k of KEYS) {
        const rel = r.mean[k] / threshold(k, 't2');
        if (rel > best) { best = rel; dom = k; }
      }
      r.key = dom;
      (byKey[dom] = byKey[dom] || []).push(r);
    }
    for (const k of Object.keys(byKey)) {
      const arr = byKey[k].sort((a, b) => a.mean[k] - b.mean[k]);
      const n = arr.length;
      const allBelowT1 = arr.every((r) => r.mean[k] < threshold(k, 't1'));
      arr.forEach((r, i) => {
        if (allBelowT1) { r.name = '动作段' + (n > 1 ? (i + 1) : ''); return; }
        let tier = '';
        if (n >= 3) tier = i < Math.ceil(n / 3) ? '轻' : i < Math.ceil(n * 2 / 3) ? '中' : '重';
        else if (n === 2) tier = i === 0 ? '轻' : '重';
        r.name = tier ? META[k].label + '-' + tier : '动作段';
      });
    }
    return regions.map((r) => ({ name: r.name, t0: r.t0, t1: r.t1 }));
  }
  $('btnAutoSeg').addEventListener('click', () => {
    if (!baseline) { alert('请先在②应用基准'); return; }
    const regions = detectRegions();
    if (!regions.length) {
      alert('未检测到动作台阶：全部帧的偏离都低于切分阈值（t2 的 25%）。\n可能是基准选错，或素材本身没有动作段。');
      return;
    }
    segs = regions;
    selection = null;
    $('segInfo').textContent = '自动切分完成：' + regions.length + ' 个台阶（按偏离自动命名，可「删除最后区间」后手动重标）';
    redraw();
  });

  /* ---------------- 阈值建议 ---------------- */
  function groupOf(name) {
    if (/正常/.test(name)) return 'normal';
    if (/轻/.test(name)) return 'light';
    if (/中/.test(name)) return 'mid';
    if (/重/.test(name)) return 'heavy';
    return 'other';
  }
  function binOf(v, mx) { return Math.min(12, Math.floor(v / mx * 12) + 1); }
  function histoLines(k, vals) {
    const t1 = threshold(k, 't1'), t2 = threshold(k, 't2');
    const mx = Math.max(t2 * 1.25, ...vals, 1e-6);
    const B = 12, W = 44;
    const counts = new Array(B).fill(0);
    for (const v of vals) counts[Math.min(B - 1, Math.floor(v / mx * B))] += 1;
    const maxC = Math.max(...counts, 1);
    const out = [];
    for (let i = 0; i < B; i++) {
      const a = i * mx / B, b = (i + 1) * mx / B;
      const bar = '█'.repeat(Math.round(counts[i] / maxC * W));
      out.push('  ' + String(i + 1).padStart(2) + ' [' + a.toFixed(META[k].decimals) + '~' + b.toFixed(META[k].decimals) + ') ' + bar + ' ' + counts[i]);
    }
    out.push('  → t1=' + t1.toFixed(META[k].decimals) + META[k].unit + ' 在第 ' + binOf(t1, mx) + ' 档内 · t2=' + t2.toFixed(META[k].decimals) + META[k].unit + ' 在第 ' + binOf(t2, mx) + ' 档内');
    return out.join('\n');
  }
  function renderSuggestion() {
    const pre = $('suggestion');
    if (!baseline) { pre.textContent = '（应用基准后生成）'; return; }
    const lines = [];
    lines.push('当前阈值：' + KEYS.map((k) => META[k].label + ' t1=' + threshold(k, 't1') + ' t2=' + threshold(k, 't2') + ' 迟滞=' + threshold(k, 'hys')).join('，') + '；宽限 ' + graceSec() + 's（与 App 引擎一致）');
    lines.push('');

    // 每姿态：全部帧偏离直方图
    for (const k of KEYS) {
      const vals = frames.map((f) => dev(k, f[k]));
      lines.push('【' + META[k].label + ' · 偏离直方图】n=' + vals.length + '，单位 ' + META[k].unit);
      lines.push(histoLines(k, vals));
      lines.push('');
    }

    // 各档偏离分布与阈值建议
    const groups = {};
    for (const k of KEYS) groups[k] = { light: [], mid: [], heavy: [], normal: [] };
    for (const seg of segs) {
      const g = groupOf(seg.name);
      if (g === 'other') continue;
      for (const k of KEYS) {
        for (const f of frames) if (f.t >= seg.t0 && f.t <= seg.t1) groups[k][g].push(dev(k, f[k]));
      }
    }
    for (const k of KEYS) {
      lines.push('【' + META[k].label + ' · 各档偏离分布】');
      for (const g of ['light', 'mid', 'heavy', 'normal']) {
        if (!groups[k][g].length) continue;
        const s = statsOf(groups[k][g]);
        const n = { light: '轻度', mid: '中度', heavy: '重度', normal: '正常动作' }[g];
        lines.push('  ' + n + '：n=' + s.n + '，均值=' + s.mean.toFixed(META[k].decimals) + '，P25=' + s.p25.toFixed(META[k].decimals) + '，P50=' + s.p50.toFixed(META[k].decimals) + '，P75=' + s.p75.toFixed(META[k].decimals) + '，max=' + s.max.toFixed(META[k].decimals) + META[k].unit);
      }
      let t1s = null, t2s = null;
      if (groups[k].light.length && groups[k].mid.length) t1s = (statsOf(groups[k].light).p75 + statsOf(groups[k].mid).p25) / 2;
      else if (groups[k].light.length) t1s = statsOf(groups[k].light).p75;
      if (groups[k].mid.length && groups[k].heavy.length) t2s = (statsOf(groups[k].mid).p75 + statsOf(groups[k].heavy).p25) / 2;
      else if (groups[k].heavy.length) t2s = statsOf(groups[k].heavy).p25;
      if (t1s != null) lines.push('  → 建议 t1 ≈ ' + t1s.toFixed(META[k].decimals) + META[k].unit + '（轻度↔中度分界）');
      if (t2s != null) lines.push('  → 建议 t2 ≈ ' + t2s.toFixed(META[k].decimals) + META[k].unit + '（中度↔重度分界）');
      if (groups[k].normal.length && t1s != null && statsOf(groups[k].normal).max > t1s) {
        lines.push('  ⚠ 正常动作 max=' + statsOf(groups[k].normal).max.toFixed(META[k].decimals) + META[k].unit + ' 超过建议 t1，会误报——t1 需调高或检查基准');
      }
      lines.push('');
    }

    // 提醒模拟 + 抗误报
    if (sim) {
      lines.push('【提醒模拟】按当前阈值 t1/t2/迟滞 + 宽限 ' + graceSec() + 's + 冷却 30s，与 App 完全同一引擎（红竖线即触发帧）');
      if (!sim.reminders.length) lines.push('  无触发帧：本素材全程不会触发提醒');
      else lines.push('  触发提醒 ' + sim.reminders.length + ' 次 @ ' + sim.reminders.map((r) => r.t.toFixed(1) + 's(' + META[r.posture].label + ')').join('、'));
      for (const seg of segs) {
        if (groupOf(seg.name) !== 'normal') continue;
        const inSeg = frames.filter((f) => f.t >= seg.t0 && f.t <= seg.t1);
        const badN = inSeg.filter((f) => sim.badAt.has(f.t)).length;
        const remN = sim.reminders.filter((r) => r.t >= seg.t0 && r.t <= seg.t1).length;
        lines.push('  抗误报[' + seg.name + ' ' + seg.t0.toFixed(1) + '~' + seg.t1.toFixed(1) + 's]：超标帧 ' + badN + '/' + inSeg.length +
          '（' + (inSeg.length ? (badN / inSeg.length * 100).toFixed(1) : 0) + '%），触发提醒 ' + remN + ' 次');
      }
      lines.push('');
    }

    lines.push('提示：建议值为启发式初值（P75↔P25 分界），最终由主理人确认后更新 app.js 的 CFG；阈值改动即时重算。');
    pre.textContent = lines.join('\n');
  }

  function fmtNum(v, k) { return v.toFixed(META[k].decimals) + META[k].unit; }
  function renderSegTable() {
    const tb = $('segTable');
    if (!baseline || !segs.length) {
      tb.innerHTML = '<thead><tr><th>（应用基准并添加 / 自动切分区间后显示）</th></tr></thead>';
      return;
    }
    let head = '<tr><th>区间</th><th>时长</th>';
    for (const k of KEYS) head += '<th>' + META[k].label + ' 均值</th><th>P25</th><th>P50</th><th>P75</th><th>max</th>';
    head += '</tr>';
    let rows = '';
    for (const seg of segs) {
      const s = segStats(seg);
      rows += '<tr><td>' + s.name + '</td><td>' + s.dur.toFixed(1) + 's</td>';
      for (const k of KEYS) rows += '<td>' + fmtNum(s[k].mean, k) + '</td><td>' + fmtNum(s[k].p25, k) + '</td><td>' + fmtNum(s[k].p50, k) + '</td><td>' + fmtNum(s[k].p75, k) + '</td><td>' + fmtNum(s[k].max, k) + '</td>';
      rows += '</tr>';
    }
    tb.innerHTML = '<thead>' + head + '</thead><tbody>' + rows + '</tbody>';
  }

  /* ---------------- 导出 CSV ---------------- */
  $('btnExport').addEventListener('click', () => {
    if (!frames.length) { alert('没有数据可导出'); return; }
    let csv = '\uFEFFt,slouch_deg,headDrop_pct,tilt_deg';
    if (baseline) csv += ',slouch_dev,headDrop_dev,tilt_dev';
    csv += '\n';
    for (const f of frames) {
      csv += f.t.toFixed(3) + ',' + f.slouch.toFixed(2) + ',' + (f.headDrop * 100).toFixed(1) + ',' + f.tilt.toFixed(2);
      if (baseline) csv += ',' + dev('slouch', f.slouch).toFixed(2) + ',' + dev('headDrop', f.headDrop).toFixed(1) + ',' + dev('tilt', f.tilt).toFixed(2);
      csv += '\n';
    }
    if (baseline) csv += '\n基准,' + KEYS.map((k) => (baseline[k] * META[k].scale).toFixed(META[k].decimals)).join(',') + '\n';
    if (baseline && segs.length) {
      csv += '\n区间统计\n区间,时长s';
      for (const k of KEYS) csv += ',' + META[k].label + '均值,' + META[k].label + 'P25,' + META[k].label + 'P50,' + META[k].label + 'P75,' + META[k].label + 'max';
      csv += '\n';
      for (const seg of segs) {
        const s = segStats(seg);
        csv += s.name + ',' + s.dur.toFixed(2);
        for (const k of KEYS) csv += ',' + s[k].mean.toFixed(META[k].decimals) + ',' + s[k].p25.toFixed(META[k].decimals) + ',' + s[k].p50.toFixed(META[k].decimals) + ',' + s[k].p75.toFixed(META[k].decimals) + ',' + s[k].max.toFixed(META[k].decimals);
        csv += '\n';
      }
    }
    if (sim) {
      csv += '\n提醒模拟（阈值 t1/t2/迟滞 + 宽限' + graceSec() + 's + 冷却30s）\n';
      csv += sim.reminders.length ? sim.reminders.map((r) => 'reminder,' + r.t.toFixed(3) + ',' + r.posture).join('\n') + '\n' : 'no-reminders\n';
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'posture-analysis.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ---------------- 启动 ---------------- */
  renderThresholdInputs();
  bindInteraction($('rawChart'), 'base');
  bindInteraction($('devChart'), 'select');
})();
