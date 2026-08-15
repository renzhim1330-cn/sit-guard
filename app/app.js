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
    graceSeconds: 3.5, cooldownSeconds: 30, maxRepeatSame: 2, praiseMinInterval: 20,
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
  let recorder = null, recordingKey = null;

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
    try {
      await initMediaPipe();
    } catch (e) {
      showBanner('检测模型加载失败（首次运行需联网下载）：' + e.message);
      return;
    }
    const camOk = await initCamera();
    if (!camOk) return;
    app.ready = true;
    $('btnStart').disabled = false;
    $('btnCalibrate').disabled = false;
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
  function doCalibrate() {
    if (!app.liveMeasures) { toast('还没检测到你——请坐正面对摄像头再点'); return; }
    engine.calibrate(app.liveMeasures);
    app.calibrated = true;
    $('ovCalibrate').classList.remove('open');
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
  }

  function stateLabel() {
    if (app.lost) return '看不到你啦';
    if (!app.running) return '未开始';
    if (app.paused) return '已暂停';
    return { ok: '学习中', warn: '要注意咯', bad: '超标·宽限中', remind: '提醒中' }[app.mood] || '学习中';
  }
  function statusText() {
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
    { key: 'slouch', name: '驼背', texts: SitGuardVoice.SCRIPTS.slouch },
    { key: 'headDrop', name: '头过低', texts: SitGuardVoice.SCRIPTS.headDrop },
    { key: 'tilt', name: '侧倾', texts: SitGuardVoice.SCRIPTS.tilt },
    { key: 'fallback', name: '兜底（检测不清）', texts: SitGuardVoice.SCRIPTS.fallback },
    { key: 'praise', name: '坐正表扬', texts: SitGuardVoice.SCRIPTS.praise },
    { key: 'start', name: '开始学习', texts: SitGuardVoice.SCRIPTS.start },
    { key: 'end', name: '结束学习', texts: SitGuardVoice.SCRIPTS.end },
  ];
  function renderVoiceList() {
    $('voiceList').innerHTML = VOICE_CATS.map((c) => {
      const has = SitGuardVoice.recording(c.key);
      const texts = Array.isArray(c.texts) ? c.texts.join(' / ') : c.texts;
      const recBtn = recordingKey === c.key
        ? '<button class="rec-on" data-act="stoprec" data-k="' + c.key + '">⏹ 停止</button>'
        : '<button data-act="rec" data-k="' + c.key + '" class="' + (has ? 'has-rec' : '') + '">' + (has ? '🔊 重录' : '● 录音') + '</button>';
      return '<li><div class="vname"><b>' + c.name + (has ? '（已预录）' : '') + '</b><span>' + texts + '</span></div>' +
        '<div class="vbtns">' +
        '<button data-act="play" data-k="' + c.key + '">▶ 试听</button>' +
        recBtn +
        (has && recordingKey !== c.key ? '<button data-act="delrec" data-k="' + c.key + '">清空</button>' : '') +
        '</div></li>';
    }).join('');
  }

  $('voiceList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const k = b.dataset.k;
    if (b.dataset.act === 'play') SitGuardVoice.play(k);
    else if (b.dataset.act === 'rec') startRecord(k);
    else if (b.dataset.act === 'stoprec') stopRecord();
    else if (b.dataset.act === 'delrec') { SitGuardVoice.removeRecording(k); renderVoiceList(); toast('已恢复默认朗读'); }
  });

  async function startRecord(key) {
    if (recorder) { stopRecord(); if (recordingKey === key) return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const myKey = key;
      const myRec = new MediaRecorder(stream);
      recorder = myRec;
      const chunks = [];
      myRec.ondataavailable = (e) => chunks.push(e.data);
      myRec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: myRec.mimeType || 'audio/webm' });
        const fr = new FileReader();
        fr.onload = () => { SitGuardVoice.saveRecording(myKey, fr.result); toast('✅ 录音已保存'); renderVoiceList(); };
        fr.readAsDataURL(blob);
        if (recorder === myRec) recorder = null;
        if (recordingKey === myKey) recordingKey = null;
      };
      myRec.start();
      recordingKey = key;
      toast('🔴 录音中……念：「' + (Array.isArray(SitGuardVoice.SCRIPTS[key]) ? SitGuardVoice.SCRIPTS[key][0] : SitGuardVoice.SCRIPTS[key]) + '」说完点「⏹ 停止」');
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
  $('btnCalibrateCancel').addEventListener('click', () => { $('ovCalibrate').classList.remove('open'); });
  $('btnDemo').addEventListener('click', () => { demoActive = true; $('ovDemo').classList.add('open'); });
  $('btnDemoClose').addEventListener('click', () => { demoActive = false; $('ovDemo').classList.remove('open'); });
  $('btnSummaryClose').addEventListener('click', () => { $('ovSummary').classList.remove('open'); });
  $('btnRetry').addEventListener('click', async () => {
    const ok = await initCamera();
    if (ok && poseLandmarker) { app.ready = true; $('btnStart').disabled = false; $('btnCalibrate').disabled = false; requestAnimationFrame(loop); }
  });
  $('volRange').addEventListener('input', (e) => { SitGuardVoice.setVolume(e.target.value / 100); });
  $('chkMute').addEventListener('change', (e) => { SitGuardVoice.setMuted(e.target.checked); });

  /* ---------------- 启动 ---------------- */
  renderVoiceList();
  renderSummaryCards();
  render();
  boot();
})();
