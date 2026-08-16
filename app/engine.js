/* 判定引擎（spec §4.3，源自 prototypes/02-posture-thresholds.html 的 createEngine，经票 02 定稿）。
 * 纯模块、无 DOM 依赖。
 * 关键设计：不做度量平滑（EMA 渐近偏差 bug）；抗误报靠「迟滞带 + 宽限计时」。
 *
 * 提醒（对齐用户目标：不改正就持续提醒）：
 *  - 真实超标（d≥t2）持续满宽限（默认 10s）→ 提醒 → 冷却（默认 45s）；
 *  - 冷却期间**暂停宽限计时**（不再累计超标时长），冷却结束重新从 0 计满宽限才再提醒，无次数上限；
 *  - 宽限只计「真实超标」（d≥t2）的连续时间：迟滞粘滞区（t2−hys ~ t2，状态仍显红色但已低于超标阈值）暂停不计，
 *    一旦真正出带到疑似/正常（d < t2−hys）即清零重算——边界抖动不再跨时段累积红色时长；
 *  - 真正改正（全部姿态回到「正常」并保持 recoveryHoldSeconds，默认 6s）→ 全姿态宽限清零，重新开始。
 *
 * 表扬（对齐用户目标：批评后坐正才表扬，一次提醒一次表扬）：
 *  - 只有「真正发出过提醒」之后坐正（三个姿态全部回到「正常」并保持 praiseHoldSeconds，默认 6s）才表扬；
 *    表扬是对「听到批评并改正」的奖励——擦边超标（没满宽限、没发过提醒）不表扬；
 *  - 表扬后该次提醒不再重复表扬；再次提醒、再改正才再次表扬；≥praiseMinInterval（30s）。
 */
(function (global) {
  'use strict';

  function createEngine(cfg) {
    const keys = Object.keys(cfg.postures);
    let baseline = null;
    const band = {}, grace = {};
    let allOkSince = -1;
    let cooldownLeft = 0, reminderTotal = 0, time = 0;
    let praiseCount = 0, lastPraiseAt = -Infinity, remindedSincePraise = false;
    const snapshot = {};

    function calibrate(current) {
      baseline = { ...current };
      for (const k of keys) { band[k] = 'ok'; grace[k] = 0; }
      allOkSince = -1;
      cooldownLeft = 0; reminderTotal = 0;
      praiseCount = 0; lastPraiseAt = -Infinity; remindedSincePraise = false;
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
        if (d >= t2 && cooldownLeft <= 0) {        // 宽限只累计「真实超标」（d≥t2）的连续时间；提醒冷却期间暂停计时
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
        if (remindedSincePraise && okFor >= cfg.praiseHoldSeconds && time - lastPraiseAt >= cfg.praiseMinInterval) {
          events.push({ type: 'praise', at: time });
          praiseCount += 1; lastPraiseAt = time;
          remindedSincePraise = false;             // 一次提醒只表扬一次（提醒→改正→表扬）
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
          remindedSincePraise = true;              // 表扬只跟随提醒（批评后坐正才表扬）
        }
      }
      return {
        states: snapshot,
        globals: { cooldownLeft, cooldownTotal: cfg.cooldownSeconds, reminderTotal, time, praiseCount },
        events,
      };
    }

    return { calibrate, tick, resetGrace };
  }

  global.SitGuardEngine = { createEngine };
})(window);
