/* 度量层：MediaPipe 33 关键点 → 三个度量（spec §4.2）
 * 关键点索引：鼻 0 · 左耳 7 · 右耳 8 · 左肩 11 · 右肩 12 · 左髋 23 · 右髋 24
 * 优先使用 world landmarks（米制 3D，原点=双髋中点），归一化坐标兜底。
 * 坐标约定（实现期已按官方文档核实；如现场异常，重点查 z 正负）：
 *   world:  x=右, y=上, z=朝向观察者
 *   norm:   x=图像右, y=图像下, z=深度（越小越靠近摄像头）
 */
(function (global) {
  'use strict';

  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  }
  function deg(rad) { return rad * 180 / Math.PI; }

  /* normLm: 33 个 {x,y,z,visibility}；worldLm: 33 个 {x,y,z,visibility}（可空） */
  function measurePose(normLm, worldLm) {
    // —— 侧倾（图像坐标即够：耳线/肩线相对水平的倾角，取较大）——
    const earL = normLm[7], earR = normLm[8], shL = normLm[11], shR = normLm[12];
    const tilt = Math.max(
      Math.abs(Math.atan2(earR.y - earL.y, earR.x - earL.x)),
      Math.abs(Math.atan2(shR.y - shL.y, shR.x - shL.x))
    );
    const tiltDeg = deg(tilt);

    const hipN = mid(normLm[23], normLm[24]);
    const shoulderN = mid(shL, shR);
    const noseN = normLm[0];
    const torso2D = Math.hypot(shoulderN.x - hipN.x, shoulderN.y - hipN.y) || 1e-4;

    let slouch, headDrop, usedWorld = false;

    if (worldLm && worldLm.length > 0 && worldLm[0]) {
      const w = worldLm[0];
      const shW = mid(w[11], w[12]);
      const noseW = w[0];
      const torsoLen = Math.hypot(shW.x, shW.y, shW.z);
      if (torsoLen > 0.05) { // 米制下躯干应远大于 5cm，否则视为 world 数据异常
        // 驼背：肩相对髋（原点）偏离竖直的角度（度）。只取前后(z)分量、去掉左右(x)，
        //   歪身/侧倾不再被算成驼背；前倾/后仰双向都算偏离（判定层按绝对值）。
        slouch = deg(Math.atan2(Math.abs(shW.z), Math.abs(shW.y)));
        // 头过低：鼻相对肩的高度除以肩高（基线约 0.5 上下）。
        //   除以肩高可扣除「身体前倾」的影响——前倾时鼻、肩同步下降，比值不变，
        //   只有头单独低下来（脖子弯）比值才变小，与驼背检测解耦。
        headDrop = (noseW.y - shW.y) / Math.max(shW.y, 0.1);
        usedWorld = true;
      }
    }
    if (!usedWorld) {
      // 兜底（归一化坐标）：驼背用 z 深度差近似倾角；头过低用图像 y 差
      slouch = deg(Math.atan2(hipN.z - shoulderN.z, torso2D));
      headDrop = (shoulderN.y - noseN.y) / torso2D;
    }

    return { slouch, headDrop, tilt: tiltDeg, usedWorld };
  }

  global.SitGuardMeasure = { measurePose };
})(window);
