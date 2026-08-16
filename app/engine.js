/* 判定引擎（spec §4.3，源自 prototypes/02-posture-thresholds.html 的 createEngine，经票 02 定稿）。
 * 纯模块、无 DOM 依赖。
 * 关键设计：不做度量平滑（EMA 渐近偏差 bug）；抗误报靠「迟滞带 + 宽限计时」。
 *
 * 提醒（对齐用户目标：不改正就持续提醒）：
 *  - 真实超标（d≥t2）持续满宽限（默认 7s）→ 提醒 → 冷却（默认 30s）→ 仍超标 → 再计宽限 → 再提醒，无限循环；
 *  - 宽限只计「真实超标」（d≥t2）的连续时间：迟滞粘滞区（t2−hys ~ t2，状态仍显红色但已低于超标阈值）暂停不计，
 *    一旦真正出带到疑似/正常（d < t2−hys）即清零重算——边界抖动不再跨时段累积红色时长；
 *  - 真正改正（全部姿态回到「正常」并保持 recoveryHoldSeconds，默认 6s）→ 全姿态宽限清零，重新开始。
 *
 * 表扬（对齐用户目标：必须全绿才表扬，一次恢复只表扬一次）：
 *  - 三个姿态全部处于「正常」（黄色疑似不算），保持 praiseHoldSeconds（默认 6s），
 *    且本次全绿周期内确实出现过超标（wasBadAny）→ 表扬一次；
 *  - 表扬后本次全绿期间不再重复表扬；再次超标再恢复才再次表扬；≥praiseMinInterval（20s）。
 */
(function (global) {
  'use strict';

  function createEngine(cfg) {
    const keys = Object.keys(cfg.postures);
    let baseline = null;
    const band = {}, grace = {};
    let allOkSince = -1, wasBadAny = false;
    let cooldownLeft = 0, reminderTotal = 0, time = 0;
    let praiseCount = 0, lastPraiseAt = -Infinity;
    const snapshot = {};

    function calibrate(current) {
      baseline = { ...current };
      for (const k of keys) { band[k] = 'ok'; grace[k] = 0; }
      allOkSince = -1; wasBadAny = false;
      cooldownLeft = 0; reminderTotal = 0;
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
      let allOk = true;
      for (const k of keys) {
        const d = Math.abs(raw[k] - baseline[k]);
        const { t1, t2, hys } = cfg.postures[k];
        const prev = band[k];
        let next = prev;                          // 迟滞带：进带 T，出带 T − hys
        if (prev === 'ok' && d >= t1) next = 'warn';
        else if (prev === 'warn') { if (d >= t2) next = 'bad'; else if (d < t1 - hys) next = 'ok'; }
        else if (prev === 'bad' && d < t2 - hys) next = 'warn';
        band[k] = next;
        if (next === 'bad') {
          wasBadAny = true;                        // 本全绿周期内出现过超标（表扬的前提）
        }
        if (d >= t2) {                             // 宽限只累计「真实超标」（d≥t2）的连续时间
          grace[k] += dt;                          // 迟滞粘滞区（t2−hys ~ t2）暂停不计
          if (grace[k] >= cfg.graceSeconds) ready.push(k);
        } else if (next !== 'bad') {               // 真正出带到疑似/正常 → 清零重算
          grace[k] = 0;                            // 边界抖动不再跨时段累积红色时长
        }
        if (next !== 'ok') allOk = false;
        snapshot[k] = {
          band: next, deviation: d, current: raw[k], baseline: baseline[k],
          grace: grace[k], graceTotal: cfg.graceSeconds,
        };
      }

      /* —— 全绿判定：改正（清零宽限）与表扬（仅本次恢复，一次） —— */
      if (allOk) {
        if (allOkSince < 0) allOkSince = time;
        const okFor = time - allOkSince;
        if (okFor >= cfg.recoveryHoldSeconds) {   // 真正改正：宽限清零，下次再犯从头计
          for (const k of keys) grace[k] = 0;
          allOkSince = -1;                         // 重新武装：破绿后重新计时
        }
        if (wasBadAny && okFor >= cfg.praiseHoldSeconds && time - lastPraiseAt >= cfg.praiseMinInterval) {
          events.push({ type: 'praise', at: time });
          praiseCount += 1; lastPraiseAt = time;
          wasBadAny = false;                       // 一次恢复只表扬一次
        }
      } else {
        allOkSince = -1;
      }

      /* —— 提醒裁决：同一刻只发一条，取相对阈值偏离最大者（d/t2）；无次数上限，冷却后继续 —— */
      if (ready.length) {
        ready.sort((a, b) =>
          (snapshot[b].deviation / cfg.postures[b].t2) - (snapshot[a].deviation / cfg.postures[a].t2));
        const k = ready[0];
        if (cooldownLeft > 0) {
          // 冷却中：压住（宽限冻结在就绪态，冷却一结束立即再提醒）
        } else {
          events.push({ type: 'reminder', posture: k, deviation: snapshot[k].deviation, at: time });
          reminderTotal += 1;
          cooldownLeft = cfg.cooldownSeconds;
          grace[k] = 0;                            // 本轮提醒完成，重新计满宽限进入下一轮
        }
      }
      return {
        states: snapshot,
        globals: { cooldownLeft, reminderTotal, time, praiseCount },
        events,
      };
    }

    return { calibrate, tick, resetGrace };
  }

  global.SitGuardEngine = { createEngine };
})(window);
