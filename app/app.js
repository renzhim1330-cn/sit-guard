/* 坐姿小卫士 MVP — 主逻辑（spec §3/§5/§7）
 * 流程：摄像头 → MediaPipe 姿态 → measurePose → 判定引擎 → 语音 / 界面
 * 学习时段 40 分钟；检测丢失三档（<5s 忽略 / ≥5s 离开+暂停 / ≥30s 强化）；恢复宽限清零。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const CFG = {
    postures: {
      slouch:   { label:'驼背',   t1:8,    t2:12,   hys:2,    fmt:(d)=>d.toFixed(1)+'°' },
      headDrop: { label:'头过低', t1:0.12, t2:0.20, hys:0.03, fmt:(d)=>(d*100).toFixed(0)+'%' },
      tilt:     { label:'侧倾',   t1:8,    t2:12,   hys:2,    fmt:(d)=>d.toFixed(1)+'°' },
    },
    graceSeconds: 3.5, cooldownSeconds: 30, praiseMinInterval: 20, praiseHoldSeconds: 6, recoveryHoldSeconds: 6,
  };
  const POSTURE_TEXT = {
    slouch:   { t:'背要挺直哦', s:'背有点弯了，挺直一点～' },
    headDrop: { t:'头太低啦',   s:'把脑袋抬起来一点哦～' },
    tilt:     { t:'身体坐正哦', s:'别歪着坐，坐正一点～' },
  };

  const engine = SitGuardEngine.createEngine(CFG);
  const video = $('video');
  let poseLandmarker = null, lastTs = performance.now(), lastVideoTime = -1;
  let demoActive = false, calibratePendingStart = false;
  let recorder = null, recordingKey = null, recordingIdx = -1;

  const app = {
    ready: false, calibrated: false,
    running: false, paused: false,
    lost: false, lostMs: 0, reinforce: false,
    totalSec: 40 * 60, leftSec: 40 * 60,
    goodSec: 0, remindCount: 0, praiseCount: 0,
    lastRemindAt: 0, mood: 'idle',
    liveMeasures: null, lastStates: null, lastResult: null,
  };

  /* ---------------- 初始化 ---------------- */
  async function initMediaPipe() {
    if (!window.__mp) await new Promise((res) => window.addEventListener('mp-loaded', res, { once: true }));
    const wasm = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
    const model = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
    const vision = await window.__mp.FilesetResolver.forVisionTasks(wasm);
    try {
      poseLandmarker = await window.__mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'GPU' },
        runningMode: 'VIDEO', numPoses: 1,
      });
    } catch (e) {
      poseLandmarker = await window.__mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1,
      });
    }
  }

  async function initCamera() {
    hideBanner();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      return true;
    } catch (e) {
      showBanner('无法打开摄像头——需要 HTTPS 或 localhost（Chrome / Edge 直接双击打开本文件可以）。' + (e && e.message ? ' ' + e.message : ''));
      return false;
    }
  }

  async function boot() {
    // 模型下载与摄像头授权并行：首次访问模型需下载数秒，期间立即弹出摄像头授权，避免干等
    const [modelOk, camOk] = await Promise.all([
      initMediaPipe().then(() => true).catch((e) => {
        showBanner('检测模型加载失败（首次运行需联网下载）：' + e.message);
        return false;
      }),
      initCamera(),
    ]);
    if (!modelOk || !camOk) return;
    app.ready = true;
    $('btnStart').disabled = false;
    $('btnCalibrate').disabled = false;
    $('btnDemoCalibrate').disabled = false;
    requestAnimationFrame(loop);
    toast('准备好了，先校准再开始～');
  }

  /* ---------------- 检测循环 ---------------- */
  function loop(ts) {
    requestAnimationFrame(loop);
    if (!app.ready || !poseLandmarker || video.readyState < 2) return;
    if (video.currentTime === lastVideoTime) return;   // 无新帧
    lastVideoTime = video.currentTime;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    let result = null;
    try { result = poseLandmarker.detectForVideo(video, ts); } catch (e) { return; }
    const hasPose = result && result.landmarks && result.landmarks.length > 0;
    if (hasPose) {
      app.lastResult = result;
      app.liveMeasures = SitGuardMeasure.measurePose(result.landmarks[0], result.worldLandmarks);
      onPose(app.liveMeasures, dt);
    } else {
      onNoPose(dt);
    }
    if (demoActive) drawDemo();
    render();
  }

  function onPose(m, dt) {
    if (app.lost) {                       // 票 07：恢复检测
      app.lost = false; app.lostMs = 0; app.reinforce = false;
      engine.resetGrace();                // 宽限清零，防“坐回来立刻响”
      toast('看到你啦，继续加油～');
    }
    if (!app.running || app.paused) {
      if (app.calibrated) {
        app.lastStates = engine.tick(m, 0).states;   // dt=0：仅刷新状态显示，不积累宽限/冷却
        app.mood = worstBand(app.lastStates) === 'ok' ? 'ok' : 'warn';
      } else {
        app.lastStates = null;
        app.mood = 'idle';
      }
      return;
    }
    if (!app.calibrated) return;
    const res = engine.tick(m, dt);
    app.lastStates = res.states;
    if (worstBand(res.states) === 'ok') app.goodSec += dt;
    let justReminded = false;
    for (const ev of res.events) {
      if (ev.type === 'reminder') {
        app.remindCount += 1;
        app.lastRemindAt = performance.now();
        SitGuardVoice.play(ev.posture);
        justReminded = true;
      } else if (ev.type === 'praise') {
        app.praiseCount += 1;
        SitGuardVoice.play('praise');
      }
      // suppressed：压住，不播
    }
    if (justReminded || performance.now() - app.lastRemindAt < 2500) app.mood = 'remind';
    else app.mood = worstBand(res.states);
  }

  function onNoPose(dt) {
    if (!app.running || app.paused) return;
    app.lostMs += dt * 1000;
    if (app.lostMs >= 5000) { app.lost = true; app.mood = 'lost'; }
    if (app.lostMs >= 30000) app.reinforce = true;
  }

  function worstBand(states) {
    if (!states) return 'ok';
    let w = 'ok';
    for (const k of Object.keys(states)) {
      if (states[k].band === 'bad') return 'bad';
      if (states[k].band === 'warn') w = 'warn';
    }
    return w;
  }
  function worstPosture(states, bands) {
    for (const k of Object.keys(states)) if (states[k].band === 'bad') return k;
    for (const k of Object.keys(states)) if (states[k].band === 'warn') return k;
    return null;
  }

  /* ---------------- 会话动作 ---------------- */
  function startSession() {
    if (!app.calibrated) { openCalibrate(true); return; }
    app.running = true; app.paused = false;
    app.lost = false; app.lostMs = 0; app.reinforce = false;
    app.leftSec = app.totalSec; app.goodSec = 0; app.remindCount = 0; app.praiseCount = 0;
    app.lastRemindAt = 0; app.mood = 'ok';
    engine.resetGrace();
    SitGuardVoice.play('start');
    render();
  }

  function endSession() {
    if (!app.running) return;
    const durationSec = app.totalSec - Math.max(0, app.leftSec);
    app.running = false; app.paused = false; app.lost = false; app.reinforce = false; app.lostMs = 0;
    app.mood = app.calibrated ? 'ok' : 'idle';
    saveHistory({ ts: Date.now(), goodSec: Math.round(app.goodSec), remind: app.remindCount, praise: app.praiseCount, durationSec });
    showSummary(durationSec);
    SitGuardVoice.play('end');
    render();
  }

  function togglePause() {
    if (!app.running) return;
    app.paused = !app.paused;
    render();
  }

  /* ---------------- 校准 ---------------- */
  function openCalibrate(pendingStart) {
    calibratePendingStart = pendingStart;
    $('ovCalibrate').classList.add('open');
  }
  function closeCalibrate() {
    $('ovCalibrate').classList.remove('open', 'on-top');
  }
  function doCalibrate() {
    if (!app.liveMeasures) { toast('还没检测到你——请坐正面对摄像头再点'); return; }
    engine.calibrate(app.liveMeasures);
    app.calibrated = true;
    closeCalibrate();
    if (calibratePendingStart) { calibratePendingStart = false; startSession(); }
    else toast('✅ 校准完成（已记住你的标准坐姿）');
    render();
  }

  /* ---------------- 小结与历史（localStorage 最近 7 次） ---------------- */
  const LS_HIST = 'sgHistory';
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HIST)) || []; } catch (e) { return []; }
  }
  function saveHistory(entry) {
    const h = loadHistory(); h.unshift(entry);
    try { localStorage.setItem(LS_HIST, JSON.stringify(h.slice(0, 7))); } catch (e) {}
    renderSummaryCards();
  }
  function showSummary(durationSec) {
    $('sumText').innerHTML =
      cell('学习时长', fmtTime(durationSec)) +
      cell('良好时长', fmtTime(Math.round(app.goodSec))) +
      cell('提醒', app.remindCount + ' 次') +
      cell('坐正表扬', app.praiseCount + ' 次');
    $('ovSummary').classList.add('open');
  }
  function cell(label, val) { return '<div class="cell"><b>' + val + '</b><span>' + label + '</span></div>'; }
  function fmtTime(s) { return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

  function renderSummaryCards() {
    const h = loadHistory();
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const today = h.filter((x) => x.ts >= day0.getTime());
    const good = today.reduce((a, x) => a + x.goodSec, 0);
    const remind = today.reduce((a, x) => a + x.remind, 0);
    const praise = today.reduce((a, x) => a + x.praise, 0);
    $('todayStats').innerHTML =
      cell('良好时长', fmtTime(good)) + cell('提醒', remind + ' 次') + cell('坐正', praise + ' 次');
    $('history').innerHTML = h.length
      ? h.map((x) => '<div class="hline"><span>' + fmtDate(x.ts) + '</span><span>良好 ' + fmtTime(x.goodSec) + ' · 提醒 ' + x.remind + ' · 坐正 ' + x.praise + '</span></div>').join('')
      : '<div class="empty">还没有记录——完成第一次学习后，这里会显示你的进步</div>';
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    // 吉祥物
    const mascot = $('mascot');
    mascot.className = 'mascot m-' + app.mood;
    mascot.querySelector('.mouth').textContent = app.mood === 'lost' ? '？' : '';
    // 头栏
    const dot = $('statusDot');
    const dotCls = { ok: 's-ok', warn: 's-warn', bad: 's-bad', remind: 's-bad', lost: 's-lost' }[app.mood] || '';
    dot.className = 'dot ' + dotCls;
    $('statusLabel').textContent = stateLabel();
    // 状态语
    const [t, s] = statusText();
    $('stText').textContent = t;
    $('stSub').textContent = s;
    renderBadges('badges');
    renderTimer();
    $('btnDemoCalibrate').textContent = app.calibrated ? '重新校准' : '校准';
  }

  function stateLabel() {
    if (!app.ready) return '加载中…';
    if (app.lost) return '看不到你啦';
    if (!app.running) return '未开始';
    if (app.paused) return '已暂停';
    return { ok: '学习中', warn: '要注意咯', bad: '超标·宽限中', remind: '提醒中' }[app.mood] || '学习中';
  }
  function statusText() {
    if (!app.ready) return ['正在加载检测模型…', '首次访问需联网下载（约几秒），请稍候'];
    if (app.lost) return app.reinforce ? ['还在吗？', '回来继续学习哦～'] : ['看不到你啦', '坐回来继续学习吧～'];
    if (!app.running) return ['准备好了吗？', '坐好，点「开始学习」'];
    if (app.paused) return ['已暂停', '点「继续」回到学习'];
    if (app.mood === 'remind') return ['叮咚～', '正在提醒你坐正哦'];
    if (app.mood === 'ok') return ['坐得真棒！', '背挺直，继续保持～'];
    const k = worstPosture(app.lastStates, ['bad', 'warn']);
    if (k && POSTURE_TEXT[k]) return [POSTURE_TEXT[k].t, POSTURE_TEXT[k].s];
    return ['要注意咯', '坐正一点哦～'];
  }

  function renderBadges(containerId) {
    const el = $(containerId || 'badges');
    if (!el) return;
    if (!app.calibrated) {
      el.innerHTML =
        '<div class="badge-row"><span>尚未校准</span><span class="badge none">点「校准」开始</span></div>';
      return;
    }
    el.innerHTML = Object.keys(CFG.postures).map((k) => {
      const p = CFG.postures[k];
      const st = app.lastStates && app.lastStates[k];
      let badge, extra = '';
      if (!st) { badge = '<span class="badge none">—</span>'; }
      else if (st.band === 'ok') { badge = '<span class="badge ok">正常</span>'; }
      else if (st.band === 'warn') { badge = '<span class="badge warn">疑似</span>'; }
      else {
        badge = '<span class="badge bad">超标</span>';
        const pct = Math.min(100, st.grace / st.graceTotal * 100);
        extra = '<div class="gracebar"><i style="width:' + pct + '%"></i></div>';
      }
      const dTxt = st ? '偏离 ' + p.fmt(st.deviation) : '等待检测…';
      return '<div class="badge-row"><span>' + p.label + '　' + dTxt + '</span>' + badge + '</div>' + extra;
    }).join('');
  }

  function renderTimer() {
    $('timer').textContent = fmtTime(Math.max(0, app.leftSec));
    let sub = '默认 40 分钟 · 已提醒 ' + app.remindCount + ' 次';
    if (app.lost) sub = '看不到你啦，计时已暂停';
    else if (app.paused) sub = '已暂停，计时停止';
    $('timerSub').textContent = sub;
    const bs = $('btnStart');
    if (app.running) { bs.textContent = '结束学习'; bs.classList.add('danger'); }
    else { bs.textContent = '开始学习'; bs.classList.remove('danger'); }
    const bp = $('btnPause');
    bp.disabled = !app.running;
    bp.textContent = app.paused ? '继续' : '暂停';
  }

  /* ---------------- 语音列表 ---------------- */
  const VOICE_CATS = [
    { key: 'slouch', name: '驼背' },
    { key: 'headDrop', name: '头过低' },
    { key: 'tilt', name: '侧倾' },
    { key: 'fallback', name: '兜底（检测不清）' },
    { key: 'praise', name: '坐正表扬' },
    { key: 'start', name: '开始学习' },
    { key: 'end', name: '结束学习' },
  ];
  function renderVoiceList() {
    const warn = SitGuardVoice.hasZhVoice ? '' :
      '<div class="voicewarn">⚠️ 此设备没有中文语音包：默认语音由应用内置音频提供；想用更温暖的声音可点「● 录音」录入家长声音。</div>';
    $('voiceList').innerHTML = warn + VOICE_CATS.map((c) => {
      const n = SitGuardVoice.textCount(c.key);
      let rows = '';
      for (let i = 0; i < n; i++) {
        const has = SitGuardVoice.recording(c.key, i);
        const isRec = recordingKey === c.key && recordingIdx === i;
        const recBtn = isRec
          ? '<button class="rec-on" data-act="stoprec" data-k="' + c.key + '" data-i="' + i + '">⏹ 停止</button>'
          : '<button data-act="rec" data-k="' + c.key + '" data-i="' + i + '" class="' + (has ? 'has-rec' : '') + '">' + (has ? '🔊 重录' : '● 录音') + '</button>';
        rows += '<li><div class="vname"><b>' + c.name + (n > 1 ? ' · 第' + (i + 1) + '句' : '') + (has ? '（已预录）' : '') + '</b><span>' + SitGuardVoice.SCRIPTS[c.key][i] + '</span></div>' +
          '<div class="vbtns">' +
          '<button data-act="play" data-k="' + c.key + '" data-i="' + i + '">▶ 试听</button>' +
          recBtn +
          (has && !isRec ? '<button data-act="delrec" data-k="' + c.key + '" data-i="' + i + '">清空</button>' : '') +
          '</div></li>';
      }
      return rows;
    }).join('');
  }

  $('voiceList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const k = b.dataset.k;
    const i = +(b.dataset.i || 0);
    if (b.dataset.act === 'play') SitGuardVoice.playSlot(k, i);
    else if (b.dataset.act === 'rec') startRecord(k, i);
    else if (b.dataset.act === 'stoprec') stopRecord();
    else if (b.dataset.act === 'delrec') { SitGuardVoice.removeRecording(k, i); renderVoiceList(); toast('已恢复默认朗读'); }
  });

  async function startRecord(key, idx) {
    if (recorder) { stopRecord(); if (recordingKey === key && recordingIdx === idx) return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const myKey = key, myIdx = idx;
      const myRec = new MediaRecorder(stream);
      recorder = myRec;
      const chunks = [];
      myRec.ondataavailable = (e) => chunks.push(e.data);
      myRec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: myRec.mimeType || 'audio/webm' });
        const fr = new FileReader();
        fr.onload = () => { SitGuardVoice.saveRecording(myKey, myIdx, fr.result); toast('✅ 录音已保存'); renderVoiceList(); };
        fr.readAsDataURL(blob);
        if (recorder === myRec) recorder = null;
        if (recordingKey === myKey && recordingIdx === myIdx) { recordingKey = null; recordingIdx = -1; }
      };
      myRec.start();
      recordingKey = key; recordingIdx = idx;
      toast('🔴 录音中……念：「' + SitGuardVoice.SCRIPTS[key][idx] + '」说完点「⏹ 停止」');
      renderVoiceList();
    } catch (e) {
      toast('录音失败（需麦克风权限）：' + e.message);
    }
  }
  function stopRecord() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  /* ---------------- 骨架演示模式（spec §5） ---------------- */
  const POSE_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],
    [11,12],[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
    [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
    [11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[31,27],
    [24,26],[26,28],[28,30],[30,32],[32,28],
  ];
  function drawDemo() {
    const cv = $('demoCanvas'), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    // 视频画面（镜像，自拍视角）
    ctx.save(); ctx.translate(cv.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, cv.width, cv.height);
    ctx.restore();
    const r = app.lastResult;
    if (!r || !r.landmarks || !r.landmarks[0]) return;
    const lm = r.landmarks[0];
    const px = (p) => (1 - p.x) * cv.width, py = (p) => p.y * cv.height;
    ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2;
    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = lm[a], pb = lm[b];
      if (!pa || !pb || (pa.visibility || 0) < 0.3 || (pb.visibility || 0) < 0.3) continue;
      ctx.beginPath(); ctx.moveTo(px(pa), py(pa)); ctx.lineTo(px(pb), py(pb)); ctx.stroke();
    }
    ctx.fillStyle = '#fbbf24';
    for (const p of lm) {
      ctx.beginPath(); ctx.arc(px(p), py(p), 4, 0, Math.PI * 2); ctx.fill();
    }
    renderBadges('demoBadges');
  }

  /* ---------------- 小工具 ---------------- */
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function showBanner(msg) { $('cameraErrorMsg').textContent = msg; $('cameraError').classList.remove('hidden'); }
  function hideBanner() { $('cameraError').classList.add('hidden'); }

  /* ---------------- 计时器 ---------------- */
  setInterval(() => {
    if (app.running && !app.paused && !app.lost) {
      app.leftSec -= 1;
      if (app.leftSec <= 0) { app.leftSec = 0; endSession(); }
    }
    renderTimer();
  }, 1000);

  /* ---------------- 事件绑定 ---------------- */
  $('btnStart').addEventListener('click', () => { app.running ? endSession() : startSession(); });
  $('btnPause').addEventListener('click', togglePause);
  $('btnCalibrate').addEventListener('click', () => openCalibrate(false));
  $('btnCalibrateDone').addEventListener('click', doCalibrate);
  $('btnCalibrateCancel').addEventListener('click', closeCalibrate);
  $('btnDemo').addEventListener('click', () => { demoActive = true; $('ovDemo').classList.add('open'); });
  // 演示模式里的校准：复用同一个校准覆盖层，但要叠在演示层之上（on-top）
  $('btnDemoCalibrate').addEventListener('click', () => {
    $('ovCalibrate').classList.add('on-top');
    openCalibrate(false);
  });
  $('btnDemoClose').addEventListener('click', () => { demoActive = false; $('ovDemo').classList.remove('open'); });
  $('btnSummaryClose').addEventListener('click', () => { $('ovSummary').classList.remove('open'); });
  $('btnRetry').addEventListener('click', async () => {
    const ok = await initCamera();
    if (ok && poseLandmarker) { app.ready = true; $('btnStart').disabled = false; $('btnCalibrate').disabled = false; $('btnDemoCalibrate').disabled = false; requestAnimationFrame(loop); }
  });
  $('volRange').addEventListener('input', (e) => { SitGuardVoice.setVolume(e.target.value / 100); });
  $('chkMute').addEventListener('change', (e) => { SitGuardVoice.setMuted(e.target.checked); });

  /* ---------------- 参数设置（家长面板） ----------------
   * 引擎实时读取 CFG（每帧），改 CFG 即生效、无需重启或重新校准。
   * 数值统一用「显示单位」（角度°、百分比%、秒）；头过低内部为比例，set/get 负责换算。 */
  const PARAM_DEFS = (() => {
    const D = [];
    const add = (key, group, name, unit, min, max, step, get, set, exp, fmt) =>
      D.push({ key, group, name, unit, min, max, step, get, set, exp, fmt: fmt || ((v) => v + ' ' + unit) });
    const ang = (v) => v.toFixed(1) + '°', pct = (v) => v.toFixed(0) + '%', sec = (v) => (v % 1 ? v.toFixed(1) : v) + ' 秒';
    add('slouch.t1', '判定阈值', '驼背 · 疑似阈值', '°', 2, 16, 0.5, () => CFG.postures.slouch.t1, (v) => { CFG.postures.slouch.t1 = v; }, '偏离达到该角度开始「疑似」（黄脸）。越大越宽容。', ang);
    add('slouch.t2', '判定阈值', '驼背 · 超标阈值', '°', 6, 25, 0.5, () => CFG.postures.slouch.t2, (v) => { CFG.postures.slouch.t2 = v; }, '达到该角度进入「超标」，持续满宽限就语音提醒。', ang);
    add('slouch.hys', '判定阈值', '驼背 · 迟滞', '°', 0.5, 4, 0.5, () => CFG.postures.slouch.hys, (v) => { CFG.postures.slouch.hys = v; }, '防闪烁：回落这么多才退出当前状态。', ang);
    add('headDrop.t1', '判定阈值', '头过低 · 疑似阈值', '%', 4, 20, 1, () => CFG.postures.headDrop.t1 * 100, (v) => { CFG.postures.headDrop.t1 = v / 100; }, '鼻相对肩高度（已扣身体前倾）偏离该比例开始「疑似」。', pct);
    add('headDrop.t2', '判定阈值', '头过低 · 超标阈值', '%', 8, 30, 1, () => CFG.postures.headDrop.t2 * 100, (v) => { CFG.postures.headDrop.t2 = v / 100; }, '达到该百分比进入「超标」。', pct);
    add('headDrop.hys', '判定阈值', '头过低 · 迟滞', '%', 1, 8, 1, () => CFG.postures.headDrop.hys * 100, (v) => { CFG.postures.headDrop.hys = v / 100; }, '防闪烁：回落这么多才退出当前状态。', pct);
    add('tilt.t1', '判定阈值', '侧倾 · 疑似阈值', '°', 2, 16, 0.5, () => CFG.postures.tilt.t1, (v) => { CFG.postures.tilt.t1 = v; }, '歪头 / 歪身达到该角度开始「疑似」。', ang);
    add('tilt.t2', '判定阈值', '侧倾 · 超标阈值', '°', 6, 25, 0.5, () => CFG.postures.tilt.t2, (v) => { CFG.postures.tilt.t2 = v; }, '达到该角度进入「超标」。', ang);
    add('tilt.hys', '判定阈值', '侧倾 · 迟滞', '°', 0.5, 4, 0.5, () => CFG.postures.tilt.hys, (v) => { CFG.postures.tilt.hys = v; }, '防闪烁：回落这么多才退出当前状态。', ang);
    add('grace', '时间参数', '宽限时间', '秒', 1, 10, 0.5, () => CFG.graceSeconds, (v) => { CFG.graceSeconds = v; }, '连续超标多久才语音提醒。越大越「忍住」。', sec);
    add('cooldown', '时间参数', '提醒冷却', '秒', 10, 120, 5, () => CFG.cooldownSeconds, (v) => { CFG.cooldownSeconds = v; }, '两次提醒之间的最小间隔。', (v) => v + ' 秒');
    add('praiseMin', '时间参数', '表扬最小间隔', '秒', 5, 60, 5, () => CFG.praiseMinInterval, (v) => { CFG.praiseMinInterval = v; }, '两次坐正表扬之间至少隔多久。', (v) => v + ' 秒');
    return D;
  })();

  /* 三档灵敏度预设（显示单位；同类连续上限已随「不改正就一直提醒」规则移除） */
  const PRESETS = {
    loose: { name: '宽松', exp: '提醒更少、更温柔', values: { 'slouch.t1': 12, 'slouch.t2': 18, 'slouch.hys': 3, 'headDrop.t1': 20, 'headDrop.t2': 28, 'headDrop.hys': 4, 'tilt.t1': 12, 'tilt.t2': 18, 'tilt.hys': 3, grace: 5, cooldown: 45, praiseMin: 30 } },
    standard: { name: '标准', exp: 'spec 默认值', values: { 'slouch.t1': 8, 'slouch.t2': 12, 'slouch.hys': 2, 'headDrop.t1': 12, 'headDrop.t2': 20, 'headDrop.hys': 3, 'tilt.t1': 8, 'tilt.t2': 12, 'tilt.hys': 2, grace: 3.5, cooldown: 30, praiseMin: 20 } },
    strict: { name: '严格', exp: '更敏感、更及时', values: { 'slouch.t1': 6, 'slouch.t2': 9, 'slouch.hys': 1.5, 'headDrop.t1': 8, 'headDrop.t2': 14, 'headDrop.hys': 2, 'tilt.t1': 6, 'tilt.t2': 9, 'tilt.hys': 1.5, grace: 2.5, cooldown: 20, praiseMin: 10 } },
  };

  function writeParams(values) {
    for (const d of PARAM_DEFS) if (values[d.key] !== undefined) d.set(values[d.key]);
    enforceOrder();
  }
  /* 防非法组合：保证 t2 > t1 > hys（角度 +2°、比例 +2%），否则状态机会卡带 */
  function enforceOrder() {
    for (const k of ['slouch', 'headDrop', 'tilt']) {
      const p = CFG.postures[k];
      const u = k === 'headDrop' ? 0.02 : 2, minHys = k === 'headDrop' ? 0.01 : 0.5;
      if (p.t2 <= p.t1) p.t2 = p.t1 + u;
      if (p.hys >= p.t1) p.hys = Math.max(minHys, p.t1 - u);
    }
  }
  function saveParams() {
    const obj = {};
    for (const d of PARAM_DEFS) obj[d.key] = d.get();
    try { localStorage.setItem('sgParams', JSON.stringify(obj)); } catch (e) {}
  }
  function loadParams() {
    try {
      const saved = JSON.parse(localStorage.getItem('sgParams'));
      if (saved) writeParams(saved);
    } catch (e) {}
  }
  function activePreset() {
    outer:
    for (const pk of Object.keys(PRESETS)) {
      const v = PRESETS[pk].values;
      for (const d of PARAM_DEFS) if (Math.abs(d.get() - v[d.key]) > 1e-6) continue outer;
      return pk;
    }
    return null;
  }
  function refreshPresetBtns() {
    const preset = activePreset();
    [...$('presetBtns').children].forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  }
  function renderSettings() {
    $('presetBtns').innerHTML = Object.keys(PRESETS).map((pk) => {
      const p = PRESETS[pk];
      return '<button data-preset="' + pk + '" title="' + p.exp + '">' + p.name + '</button>';
    }).join('');
    refreshPresetBtns();
    let html = '', lastGroup = '';
    for (const d of PARAM_DEFS) {
      if (d.group !== lastGroup) { html += '<div class="pgroup">' + d.group + '</div>'; lastGroup = d.group; }
      html += '<div class="param"><div class="phead"><span class="pname">' + d.name + '</span><span class="pval">' + d.fmt(d.get()) + '</span></div>' +
        '<div class="pexp">' + d.exp + '</div>' +
        '<input type="range" data-k="' + d.key + '" min="' + d.min + '" max="' + d.max + '" step="' + d.step + '" value="' + d.get() + '"></div>';
    }
    $('settingsForm').innerHTML = html;
  }

  $('btnSettings').addEventListener('click', () => { renderSettings(); $('ovSettings').classList.add('open'); });
  $('btnSettingsClose').addEventListener('click', () => $('ovSettings').classList.remove('open'));
  $('btnResetParams').addEventListener('click', () => {
    writeParams(PRESETS.standard.values);
    saveParams();
    toast('已恢复默认（标准）参数');
    renderSettings();
  });
  $('presetBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    writeParams(PRESETS[b.dataset.preset].values);
    saveParams();
    toast('已切换为「' + PRESETS[b.dataset.preset].name + '」');
    renderSettings();
  });
  $('settingsForm').addEventListener('input', (e) => {
    const inp = e.target;
    if (inp.tagName !== 'INPUT' || !inp.dataset.k) return;
    const def = PARAM_DEFS.find((d) => d.key === inp.dataset.k); if (!def) return;
    def.set(+inp.value);
    enforceOrder();
    saveParams();
    inp.closest('.param').querySelector('.pval').textContent = def.fmt(def.get());
    inp.value = def.get();   // 若被钳制则同步滑杆位置
    refreshPresetBtns();
  });

  /* ---------------- 启动 ---------------- */
  loadParams();
  renderVoiceList();
  renderSummaryCards();
  render();
  /* iOS / 移动端：第一次用户手势时解锁语音合成（否则 TTS 可能被静默拦截） */
  document.addEventListener('pointerdown', function unlockAudio() {
    try {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    } catch (e) {}
    document.removeEventListener('pointerdown', unlockAudio);
  }, { once: true });
  /* 中文语音包晚加载完成时刷新提示 */
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', renderVoiceList);
  boot();
})();
