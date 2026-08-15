/* 语音层（spec §6，票 04 文案库定稿）。
 * 播放优先级：录音（家长/老师预录）> 内置语音文件（app/audio/*.mp3）> 浏览器 TTS > 提示音兜底。
 * 内置 mp3 随仓库部署，移动端用 <audio> 播放（最可靠，不依赖系统 TTS）。
 * 生成方式：python app/generate_voice.py（edge-tts）。
 * 轮换：同一类别随机选取且不与上一条重复（防唠叨）。
 */
(function (global) {
  'use strict';

  const SCRIPTS = {
    slouch:   ['背挺直～', '背要挺直哦～'],
    headDrop: ['头抬起来一点哦～', '脑袋抬起来一点～'],
    tilt:     ['身体坐正，别歪哦～', '坐直一点，别歪啦～'],
    fallback: ['坐端正哦～', '换个舒服又端正的姿势～'],
    praise:   ['坐正啦，真棒！', '背挺直了，真棒！', '好样的，继续保持～'],
    start:    ['开始学习啦，加油～'],
    end:      ['学习结束，休息一下吧～'],
  };

  const LS = 'sgVoice_';
  let volume = 0.8, muted = false;
  const lastIdx = {};

  /* —— 迁移旧版单录音（sgVoice_<cat> → 第 0 句槽） —— */
  (function migrate() {
    try {
      for (const cat of Object.keys(SCRIPTS)) {
        const old = localStorage.getItem(LS + cat);
        if (old) { localStorage.setItem(slotKey(cat, 0), old); localStorage.removeItem(LS + cat); }
      }
    } catch (e) { /* 忽略 */ }
  })();

  function slotKey(cat, idx) { return LS + cat + '_' + idx; }
  function textCount(cat) { return SCRIPTS[cat].length; }
  function recording(cat, idx) {
    try { return localStorage.getItem(slotKey(cat, idx)); } catch (e) { return null; }
  }
  function saveRecording(cat, idx, dataUrl) {
    try { localStorage.setItem(slotKey(cat, idx), dataUrl); } catch (e) { /* 容量不足时静默 */ }
  }
  function removeRecording(cat, idx) {
    try { localStorage.removeItem(slotKey(cat, idx)); } catch (e) {}
  }
  function recordedSlots(cat) {
    const out = [];
    for (let i = 0; i < textCount(cat); i++) if (recording(cat, i)) out.push(i);
    return out;
  }

  /* —— TTS 可用性检测：设备是否有中文语音包（安卓常见缺失） —— */
  let hasZhVoice = true;
  function refreshVoices() {
    try {
      const vs = speechSynthesis.getVoices();
      if (vs.length) hasZhVoice = vs.some((v) => (v.lang || '').toLowerCase().indexOf('zh') === 0);
    } catch (e) { /* 保持上次判断 */ }
  }
  if ('speechSynthesis' in window) {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
  }

  /* —— 提示音兜底（WebAudio 合成，无需任何资源文件） —— */
  let audioCtx = null;
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      [880, 1174.66].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = t + i * 0.18;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.05, volume * 0.25), t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.4);
      });
    } catch (e) { /* 静默 */ }
  }

  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.volume = volume; u.rate = 0.95; u.pitch = 1.1;
      speechSynthesis.speak(u);
    } catch (e) { chime(); }
  }

  function playAudio(dataUrl) {
    try { const a = new Audio(dataUrl); a.volume = volume; a.play().catch(() => {}); }
    catch (e) { /* 静默 */ }
  }

  /* 已录槽随机轮换且不与上一条重复 */
  function pickSlot(cat) {
    const slots = recordedSlots(cat);
    if (!slots.length) return -1;
    if (slots.length === 1) return slots[0];
    let s;
    do { s = slots[Math.floor(Math.random() * slots.length)]; } while (s === lastIdx[cat]);
    lastIdx[cat] = s;
    return s;
  }

  /* 内置语音文件（app/audio/<类别>-<序号>.mp3，随仓库部署） */
  function bundledFile(cat, idx) { return 'audio/' + cat + '-' + idx + '.mp3'; }

  /* 文案索引随机轮换且不与上一条重复（内置音频 / TTS 共用） */
  function pickTextIdx(cat) {
    const arr = SCRIPTS[cat];
    let i;
    if (lastIdx[cat] === undefined || arr.length === 1) i = Math.floor(Math.random() * arr.length);
    else i = (lastIdx[cat] + 1 + Math.floor(Math.random() * (arr.length - 1))) % arr.length;
    lastIdx[cat] = i;
    return i;
  }

  /* 播放内置 mp3；文件缺失 / 加载失败时回落到 TTS / 提示音 */
  function playBundledOrFallback(cat, idx) {
    let fell = false;
    const fallback = () => {
      if (fell) return;
      fell = true;
      if (hasZhVoice && 'speechSynthesis' in window) speak(SCRIPTS[cat][idx]);
      else chime();
    };
    const a = new Audio(bundledFile(cat, idx));
    a.volume = volume;
    a.onerror = fallback;
    a.play().catch(fallback);
  }

  /* 事件驱动播放：已录槽轮换 > 内置语音（轮换）> TTS / 提示音 */
  function play(cat) {
    if (muted) return;
    const s = pickSlot(cat);
    if (s >= 0) { playAudio(recording(cat, s)); return; }
    playBundledOrFallback(cat, pickTextIdx(cat));
  }

  /* 试听某一具体句槽：录音 > 内置语音 > TTS / 提示音 */
  function playSlot(cat, idx) {
    if (muted) return;
    const rec = recording(cat, idx);
    if (rec) { playAudio(rec); return; }
    playBundledOrFallback(cat, idx);
  }

  global.SitGuardVoice = {
    SCRIPTS,
    textCount,
    play,
    playSlot,
    recording,
    saveRecording,
    removeRecording,
    recordedSlots,
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); },
    setMuted(m) { muted = m; },
    get hasZhVoice() { return hasZhVoice; },
  };
})(window);
