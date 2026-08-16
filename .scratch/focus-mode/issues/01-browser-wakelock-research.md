Type: research
Status: resolved

# 浏览器屏幕常亮与后台运行能力边界

## Question

专注模式（黑屏遮罩）依赖「屏幕保持常亮 + 页面持续运行」。核实以下平台事实（用高可信来源：MDN、caniuse、web.dev、W3C 规范、Apple/Google 官方文档）：

1. **Screen Wake Lock**：各平台支持情况与行为——iOS Safari 16.4+ / Android Chrome 84+ / 桌面 Chrome 与 Edge；自动释放时机（标签页隐藏、最小化、退出全屏时是否释放）；iOS 上是否真的能防止自动锁屏；是否需要 HTTPS
2. **无 Wake Lock 时**：iOS 15 / 16.0–16.3 与老版 Android Chrome 上，页面可见但屏幕被系统自动锁定时，页面会发生什么（挂起？getUserMedia / MediaPipe 推理 / 语音播放是否停止）；解锁回到 App 后是否需要重新获取摄像头权限、页面是否需要重载
3. **黑屏遮罩下的持续运行**：全屏黑色覆盖层（屏幕常亮）对 getUserMedia / MediaPipe / WebAudio 语音播放有无影响；iOS / Android 摄像头使用指示灯在「页面内黑屏」时的行为（是否仍亮）
4. **降级选项**：`navigator.vibrate` 支持矩阵（iOS 是否支持）；检测 Wake Lock 是否可用的可靠方法（`'wakeLock' in navigator` 是否足够）
5. **省电参考**：OLED vs LCD 纯黑屏耗电差异；手机摄像头 + 姿态推理连续 40 分钟的耗电 / 发热量级参考

解析方式：`/research` 子代理调研，结论写入 `research/01-screen-wakelock.md`；本票 `## Answer` 记录要点。

## Answer

**调研完成，完整文档：`research/01-screen-wakelock.md`（每条结论附来源 URL）。**

- **Wake Lock**：iOS Safari 16.4+、Android Chrome 84+（85+ 默认）、桌面 Chrome 85+/Edge 90+/Firefox 126+；必须 HTTPS；能真正阻止锁屏，但文档不可见（切走/最小化/屏幕熄灭）即自动释放，低电量/省电模式会拒绝请求；iOS 无需额外设置
- **锁屏后果**：iOS 锁屏后页面挂起（JS/WebGL/音频/摄像头全停），解锁回来**无需重授摄像头**但页面可能已被内存回收重载（WebKit bug 300782）；Android 后台标签页被节流/冻结（Chrome 133+ 省电模式冻结 CPU 密集页，但**豁免使用摄像头/麦克风的标签页**），厂商省电策略可能杀进程；**没有任何 Web API 能在锁屏后继续运行**（system wake lock 已被官方放弃）
- **黑屏遮罩**：visibilityState 是标签页级概念，页内覆盖层不影响检测运行 ✓；摄像头指示灯（iOS 绿点 / Android 相机指示）由系统状态栏绘制，黑屏下仍显示；**无 API 可查询"摄像头使用中"**
- **降级**：vibrate iOS 完全不支持（Android 可用）；Wake Lock 检测 = `'wakeLock' in navigator` + request 包 try/catch + 用户手势内发起 + visibilitychange 重取；隐藏循环视频 hack 官方不认可，不采用
- **省电**：OLED 黑像素省电（室内亮度仅省 3–9%，100% 亮度省 39–47%）、LCD 背光常亮几乎不省；40 分钟推理耗电无官方测量（标注未找到可靠来源）
- **两个关键风险（影响实现）**：① iOS standalone PWA（添加到主屏幕）中 Wake Lock 历史不可靠（WebKit bug 254545）——不能假设生效，需降级提示；② iOS 内存压力下 40 分钟 MediaPipe 会话可能被终止重载——恢复逻辑必须健壮（visibilitychange/pageshow 恢复：重取摄像头、重启会话、基准丢失时重新校准），降级方案细节见研究文档「对专注模式的影响」
