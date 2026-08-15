/* 语音层（spec §6，票 04 文案库定稿）。
 * 播放优先级：自定义录音（家长/老师预录，localStorage）> 浏览器语音合成朗读文案。
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
    } catch (e) { /* 静默 */ }
  }

  function play(key) {
    if (muted) return;
    const rec = recording(key);
    if (rec) {
      try { const a = new Audio(rec); a.volume = volume; a.play().catch(() => {}); }
      catch (e) { /* 静默 */ }
    } else {
      speak(pickText(key));
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
  };
})(window);
