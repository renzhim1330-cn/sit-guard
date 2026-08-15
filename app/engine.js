/* 判定引擎（spec §4.3，源自 prototypes/02-posture-thresholds.html 的 createEngine，
 * 经票 02 定稿）。纯模块、无 DOM 依赖。
 * 关键设计：不做度量平滑（EMA 渐近偏差 bug）；抗误报靠「迟滞带 + 持续宽限计时」；
 * 票 04：坐正表扬 ≥20s 间隔；票 07：resetGrace（恢复检测时宽限清零）。
 * 修订（用户实测反馈）：表扬必须「恢复到正常带并保持 praiseHoldSeconds」才触发——
 * 原先「离开超标带即表扬」会在偏离值徘徊于退出线附近时被测量抖动触发误表扬。
 */
(function (global) {
  'use strict';

  function createEngine(cfg) {
    const keys = Object.keys(cfg.postures);
    let baseline = null;
    const band = {}, grace = {}, okSince = {}, wasBad = {};
    let cooldownLeft = 0, lastReminded = null, streakSame = 0, reminderTotal = 0, time = 0;
    let praiseCount = 0, lastPraiseAt = -Infinity;
    const snapshot = {};

    function calibrate(current) {
      baseline = { ...current };
      for (const k of keys) {
        band[k] = 'ok'; grace[k] = 0; okSince[k] = -1; wasBad[k] = false;
      }
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
        // 坐正表扬（修订）：必须恢复到「正常」带并稳定保持 praiseHoldSeconds，
        // 且此前确实到过「超标」，才表扬（票 04：≥20s 间隔）。
        // 防止偏离值徘徊在退出线附近时被测量抖动触发误表扬。
        if (next === 'ok') {
          if (prev !== 'ok') okSince[k] = time;
          if (wasBad[k] && okSince[k] >= 0 && time - okSince[k] >= cfg.praiseHoldSeconds &&
              time - lastPraiseAt >= cfg.praiseMinInterval) {
            events.push({ type: 'praise', posture: k, at: time });
            praiseCount += 1; lastPraiseAt = time;
            wasBad[k] = false;   // 本次恢复已表扬，下次需再犯再恢复才表扬
          }
        } else {
          okSince[k] = -1;
          if (next === 'bad') wasBad[k] = true;
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
