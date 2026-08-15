/* 语音层（spec §6，票 04 文案库定稿）。
 * 播放优先级：自定义录音（家长/老师预录，localStorage）> 浏览器语音合成朗读文案 > 提示音兜底。
 * 移动端注意：安卓 / iOS 常缺中文 TTS 引擎或拦截语音合成，此时改用 WebAudio 提示音保证「有声」，
 * 并引导家长用「录音」功能录入真实声音（Audio 元素播放，移动端最可靠）。
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
    start:    '开始学习啦，加油～',
    end:      '学习结束，休息一下吧～',
  };

  const LS = 'sgVoice_';
  let volume = 0.8, muted = false;
  const lastIdx = {};

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

  function recording(key) {
    try { return localStorage.getItem(LS + key); } catch (e) { return null; }
  }
  function saveRecording(key, dataUrl) {
    try { localStorage.setItem(LS + key, dataUrl); } catch (e) { /* 容量不足时静默 */ }
  }
  function removeRecording(key) {
    try { localStorage.removeItem(LS + key); } catch (e) {}
  }

  /* 随机轮换且不与上一条重复 */
  function pickText(key) {
    const arr = Array.isArray(SCRIPTS[key]) ? SCRIPTS[key] : [SCRIPTS[key]];
    let i;
    if (lastIdx[key] === undefined || arr.length === 1) i = Math.floor(Math.random() * arr.length);
    else i = (lastIdx[key] + 1 + Math.floor(Math.random() * (arr.length - 1))) % arr.length;
    lastIdx[key] = i;
    return arr[i];
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

  function play(key) {
    if (muted) return;
    const rec = recording(key);
    if (rec) {
      try { const a = new Audio(rec); a.volume = volume; a.play().catch(() => {}); }
      catch (e) { /* 静默 */ }
      return;
    }
    if (hasZhVoice && 'speechSynthesis' in window) {
      speak(pickText(key));
    } else {
      chime();   // 无中文语音包：提示音兜底，保证「有声」
    }
  }

  global.SitGuardVoice = {
    SCRIPTS,
    play,
    recording,
    saveRecording,
    removeRecording,
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); },
    setMuted(m) { muted = m; },
    get hasZhVoice() { return hasZhVoice; },
  };
})(window);
