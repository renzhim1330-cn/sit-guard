/* 判定引擎（spec §4.3，源自 prototypes/02-posture-thresholds.html 的 createEngine，
 * 经票 02 定稿）。纯模块、无 DOM 依赖。
 * 关键设计：不做度量平滑（EMA 渐近偏差 bug）；抗误报靠「迟滞带 + 持续宽限计时」；
 * 票 04 新增：坐正表扬最小间隔 20s；票 07 新增：resetGrace（恢复检测时宽限清零）。
 */
(function (global) {
  'use strict';

  function createEngine(cfg) {
    const keys = Object.keys(cfg.postures);
    let baseline = null;
    const band = {}, grace = {};
    let cooldownLeft = 0, lastReminded = null, streakSame = 0, reminderTotal = 0, time = 0;
    let praiseCount = 0, lastPraiseAt = -Infinity;
    const snapshot = {};

    function calibrate(current) {
      baseline = { ...current };
      for (const k of keys) { band[k] = 'ok'; grace[k] = 0; }
      cooldownLeft = 0; lastReminded = null; streakSame = 0; reminderTotal = 0;
      praiseCount = 0; lastPraiseAt = -Infinity;
      return { ...baseline };
    }

    /* 票 07：检测恢复后宽限清零（防“离开前快满宽限、坐回来立刻响”）；冷却照走 */
    function resetGrace() {
      for (const k of keys) grace[k] = 0;
    }

    function tick(raw, dt) {
      if (!baseline) return { states: null, globals: null, events: [] };
      const events = [];
      time += dt;
      if (cooldownLeft > 0) cooldownLeft = Math.max(0, cooldownLeft - dt);
      const ready = [];
      for (const k of keys) {
        const d = Math.abs(raw[k] - baseline[k]);
        const { t1, t2, hys } = cfg.postures[k];
        const prev = band[k];
        let next = prev;                          // 迟滞带：进带 T，出带 T − hys
        if (prev === 'ok' && d >= t1) next = 'warn';
        else if (prev === 'warn') { if (d >= t2) next = 'bad'; else if (d < t1 - hys) next = 'ok'; }
        else if (prev === 'bad' && d < t2 - hys) next = 'warn';
        if (prev === 'bad' && next !== 'bad') {   // 坐正表扬（票 04：≥20s 间隔）
          if (time - lastPraiseAt >= cfg.praiseMinInterval) {
            events.push({ type: 'praise', posture: k, at: time });
            praiseCount += 1; lastPraiseAt = time;
          }
        }
        band[k] = next;
        if (next === 'bad') { grace[k] += dt; if (grace[k] >= cfg.graceSeconds) ready.push(k); }
        else grace[k] = 0;
        snapshot[k] = {
          band: next, deviation: d, current: raw[k], baseline: baseline[k],
          grace: grace[k], graceTotal: cfg.graceSeconds,
        };
      }
      // 提醒裁决：同一刻只发一条，取相对阈值偏离最大者（d/t2）；冷却与同类上限压住其余
      if (ready.length) {
        ready.sort((a, b) =>
          (snapshot[b].deviation / cfg.postures[b].t2) - (snapshot[a].deviation / cfg.postures[a].t2));
        const k = ready[0];
        grace[k] = 0;   // 无论发不发，都重新计满一轮宽限再尝试
        if (cooldownLeft > 0) {
          // 冷却中：不发（票 04：间隔 ≥30s）
        } else if (lastReminded === k && streakSame >= cfg.maxRepeatSame) {
          events.push({ type: 'suppressed', posture: k, at: time, reason: '同类连续提醒已达上限' });
        } else {
          events.push({ type: 'reminder', posture: k, deviation: snapshot[k].deviation, at: time });
          reminderTotal += 1;
          cooldownLeft = cfg.cooldownSeconds;
          streakSame = (lastReminded === k) ? streakSame + 1 : 1;
          lastReminded = k;
        }
      }
      return {
        states: snapshot,
        globals: { cooldownLeft, streakSame, lastReminded, reminderTotal, time, praiseCount },
        events,
      };
    }

    return { calibrate, tick, resetGrace };
  }

  global.SitGuardEngine = { createEngine };
})(window);
