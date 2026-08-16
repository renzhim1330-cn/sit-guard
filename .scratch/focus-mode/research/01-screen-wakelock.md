# Screen Wake Lock 与专注模式平台事实核查（研究结论）

> 票号：`issues/01-browser-wakelock-research.md`（research）
> 目标载体：纯前端 PWA（无后端），手机/平板**前置摄像头** + MediaPipe Pose Landmarker（WASM/WebGL）+ WebAudio/语音合成提醒。
> 新功能「专注模式」：点击开始学习 → 应用内**纯黑遮罩**（屏幕保持点亮、仅内容全黑），检测与语音提醒照常运行。
> 关键依赖：屏幕不能被系统自动锁屏（否则检测中断）。
> 数据抓取时间：2026-07（caniuse 页面数据、MDN / Chrome / WebKit / Apple / AOSP 官方文档当前版本）。

---

## 一、结论速览（TL;DR）

**Screen Wake Lock API 是唯一被广泛支持的「防自动锁屏」平台能力：iOS Safari 16.4+、Android Chrome 84+、桌面 Chrome 85+ / Edge 90+ / Firefox 126+ 均可用，能真正阻止系统锁屏；但锁屏一旦发生，任何纯 Web 页面都无法继续运行——平台不存在「锁屏后继续跑」的 API（当年的 system wake lock 已被 W3C/Chrome 明确放弃）。**

对专注模式意味着三件事：

1. **成立**：黑屏遮罩（页面内 DOM 覆盖层）不影响检测运行——只要标签页保持前台可见、并持有有效的 screen wake lock，getUserMedia / MediaPipe / WebAudio 全部照常。
2. **必须降级**：iOS 上「添加到主屏幕」的 standalone PWA 中 Wake Lock 历史上不可用（WebKit bug 254545），且 iOS 16.x 时期在 visibilitychange 后重新获取会抛 `NotAllowedError`（bug 255363）——真机需按「可用则用、不可用则提示」处理。
3. **平台约束**：系统锁屏 = 检测必然中断（iOS 挂起页面、Android 冻结标签页），无 Web API 可避免；只能靠 Wake Lock 把锁屏挡在发生之前，并在锁屏恢复后给出恢复逻辑。

---

## 二、第 1 组：Screen Wake Lock API

### 1.1 支持矩阵

| 平台 | 结论 | 来源 |
|---|---|---|
| **iOS Safari** | **16.4 起支持**（caniuse：iOS Safari 3.2–16.3 不支持，16.4–26.x 支持）；WebKit 官方博客确认 Safari 16.4 引入 Screen Wake Lock API | [caniuse/wake-lock](https://caniuse.com/wake-lock)、[WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) |
| **Android Chrome** | **支持**。官方宣布 Chrome 84 发布该 API（[web.dev](https://web.dev/wakelock/)）；caniuse 将 Chrome 71–84 标为「需 `#experimental-web-platform-features` flag」、**85+ 默认开启** | [caniuse/wake-lock](https://caniuse.com/wake-lock)、[web.dev/wakelock](https://web.dev/wakelock/) |
| **桌面 Chrome / Edge** | Chrome 85+ 默认支持；Edge 90+ 默认支持（79–89 需 flag） | [caniuse/wake-lock](https://caniuse.com/wake-lock) |
| **桌面 Firefox** | **126 起支持**（124–125 需 `dom.screenwakelock.enabled` flag，126+ 默认开启） | [caniuse/wake-lock](https://caniuse.com/wake-lock)、[MDN Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) |
| 其他 | Opera 73+、Samsung Internet 14+ 支持；caniuse 全球可用率约 94%（2026-07） | [caniuse/wake-lock](https://caniuse.com/wake-lock) |

> 注意：caniuse 将本特性列为 Baseline 2025-03（2025 年 3 月起主流设备/浏览器齐备）。

### 1.2 行为

- **能阻止屏幕熄灭/锁屏**：API 用途即「prevent devices from dimming, locking or turning off the screen」([caniuse 描述](https://caniuse.com/wake-lock)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API))。
- **自动释放时机**：文档不可见时自动释放——切走标签页/窗口、最小化、切到别的 App、屏幕熄灭时（[web.dev：minimize a tab or window, or switch away](https://web.dev/wakelock/)；[MDN：document not active or visible 时由系统释放](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)）。
- **请求可能被拒**：系统省电模式、低电量、或文档不活跃/不可见时 `request()` 会被拒绝（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)、[web.dev](https://web.dev/wakelock/)）。
- **必须 HTTPS**：secure context 才可用（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)、[web.dev](https://web.dev/wakelock/)）。
- **iOS 是否需要额外设置**：**无需**。WebKit 官方发布说明未提及任何设置要求，Safari 浏览器内直接可用（[WebKit blog](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)）。
- **iOS 特有问题（重点）**：
  - **standalone PWA（添加到主屏幕）中不可用**：WebKit bug 254545（2023-03 报告：Safari 浏览器内正常、Home Screen Web App 内不生效）——WebKit 侧以「提供 API 给 Safari 团队采纳」关闭（RESOLVED FIXED），但评论区直到 iOS 17.0.1 仍未修复，WebKit 官方建议向 Apple 反馈；2024-05 W3C 邮件列表仍有人报告 Chrome on iOS 的 Home Screen 快捷方式上不一致（[bug 254545](https://bugs.webkit.org/show_bug.cgi?id=254545)、[W3C 邮件](https://lists.w3.org/Archives/Public/public-device-apis-log/2024May/0192.html)）。
  - **visibilitychange 后重新获取可能 `NotAllowedError: Permission was denied`**：bug 255363（iOS 16.4，从主屏幕返回 Safari 后重取被拒，因 WebKit 要求 transient activation）；WebKit 已于 2023-04 修复（[bug 255363](https://bugs.webkit.org/show_bug.cgi?id=255363)），但实际 iOS 版本上的表现需真机回归。

### 1.3 请求 / 释放的正确用法

- `navigator.wakeLock.request('screen')` 返回 `Promise<WakeLockSentinel>`；**必须 try/catch**（浏览器可能因低电量/省电模式拒绝）（[web.dev](https://web.dev/wakelock/)）。
- 持有 sentinel 引用；监听 sentinel 的 `release` 事件；需要时手动 `sentinel.release()`（[web.dev](https://web.dev/wakelock/)）。
- **visibilitychange 重新获取**：官方推荐模式——`visibilitychange` 时若 `document.visibilityState === 'visible'` 则重新 `request()`（[web.dev](https://web.dev/wakelock/)）。
- **特性检测**：`if ('wakeLock' in navigator)`（[MDN 示例](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)）。注意：检测通过 ≠ 请求成功，仍需 try/catch。

---

## 三、第 2 组：无 Wake Lock 时，屏幕自动锁定的后果

### 2.1 iOS（Safari）

- **锁屏/退后台 → 页面被挂起，JS 计时器、WebGL、音频、摄像头全停**：
  - iOS 对「用户不主动使用的 App」：退到后台只是「通往挂起的短暂过渡」，挂起是 iOS 的节电手段（[Apple 归档文档 App Programming Guide · Background Execution](https://developer.apple.com/library/archive/documentation/iPhone/Conceptual/iPhoneOSProgrammingGuide/BackgroundExecution/BackgroundExecution.html)）。
  - 屏幕熄灭 → 页面进入 hidden 状态（MDN：visibilityState 为 hidden 的情形包含「device's screen is off」）；hidden 状态下 `requestAnimationFrame` 回调停止、`setTimeout` 等被节流（[MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)）。
  - 摄像头：官方 SDK 文档确认 iOS 上（Safari/Chrome/Firefox）浏览器进后台后，对方看到的是**黑块**（视频流停止）（[AWS Chime SDK FAQ](https://github.com/aws/amazon-chime-sdk-js/blob/main/guides/07_FAQs.md)）。
- **解锁回到 App**：
  - **不需要重新授权摄像头**：媒体权限按来源（origin）长期保存，授予后不重复询问（W3C media-capture 工作组 2014 讨论确认权限长期有效；[W3C 邮件存档](https://lists.w3.org/Archives/Public/public-media-capture/2014May/0303.html)；MDN 错误语义中仅「当前会话拒绝/全局拒绝」会抛 `NotAllowedError`，[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)）。
  - **页面可能被系统终止并重新加载**：iOS Safari 在内存压力下会终止 WebGL/纹理重的页面并立即重载（WebKit bug 300782，2025-10 报告，状态 NEW；[bug 300782](https://bugs.webkit.org/show_bug.cgi?id=300782)）。连续 40 分钟 MediaPipe（WebGL/WASM + 摄像头）正是这类页面的典型候选，**不能假设回来时页面还在**。

### 2.2 Android（Chrome）

- **屏幕自动锁定 → 标签页节流/冻结**：屏幕熄灭 → 页面 hidden → 定时器节流、rAF 停止（[MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)）；Chrome 会对后台标签页做资源回收——官方 Chromium 策略文档写明「后台 ≥5 分钟可能被冻结（freeze）」，同时注明 Chrome 会**用启发式规则避免冻结在做有用工作的标签页（播放声音/流视频/通知）**（[Chromium TabFreezingEnabled 策略](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/policy/resources/templates/policy_definitions/Miscellaneous/TabFreezingEnabled.yaml)）。
- **Chrome 133+ 额外冻结**：开启「省电模式（Energy Saver）」时，满足条件的 CPU 密集型后台标签页会被冻结（冻结 = 事件处理器、定时器、Promise 回调全部暂停）；**关键豁免：正在使用摄像头/麦克风/屏幕捕获或持有活跃 RTC 连接的标签页组不会被冻结**（[Chrome 官方博客 Freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver)）。
- **摄像头后台行为**：Android Chrome 进后台后视频流被静音/停帧（官方 SDK 文档：Chrome in Android 显示 frozen tile）（[AWS Chime SDK FAQ](https://github.com/aws/amazon-chime-sdk-js/blob/main/guides/07_FAQs.md)）。
- **厂商省电策略可能杀后台标签页**：小米 / 华为 / OPPO / vivo / 三星等厂商有激进的电池优化，会杀掉「后台」应用进程（包括浏览器标签页所在的进程）；社区维护的 dontkillmyapp.com 持续追踪各厂商的此类行为（Xiaomi / Huawei / OnePlus / Samsung 等被点名）（[dontkillmyapp.com](https://dontkillmyapp.com/)）。此来源为社区维护，非官方文档，但被业内广泛引用。

### 2.3 有没有任何 Web API 能让页面在系统锁屏后继续运行？

**答案：没有。** 依据：

- Chrome/Google 官方明确放弃「system wake lock」（防止 CPU 待机、让应用在屏幕关闭后继续运行的锁类型），只保留 screen wake lock（[web.dev：We aren't proceeding with this type](https://web.dev/wakelock/)）。
- 页面生命周期机制决定：一旦 hidden，浏览器可冻结（timers/fetch 回调不再运行）或直接丢弃页面（任何 JS 都不运行）（[Page Lifecycle API · Frozen/Discarded 状态](https://developer.chrome.com/articles/page-lifecycle-api)）。
- Wake Lock 的作用边界就是「阻止锁屏发生」；锁屏一旦发生，页面即进入隐藏/挂起路径，Web 侧无任何补救 API（[MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)）。

---

## 四、第 3 组：黑屏遮罩下的持续运行

### 3.1 页面可见（屏幕亮、只是覆盖层全黑）时是否照常运行

**结论：照常，不受影响。** visibilityState 是「标签页级」概念：页面是前台标签页且窗口未最小化即为 `visible`（[MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)）；页内 DOM/CSS 覆盖层（黑屏遮罩）不改变标签页可见性，因此不会触发任何节流/暂停，getUserMedia、MediaPipe（WASM/WebGL）、WebAudio 全部持续运行。需要满足的唯一外部条件是：标签页保持前台 + 系统不解锁屏（即持有 wake lock）。

### 3.2 摄像头使用指示灯（iOS 绿点 / Android 相机指示）

- **结论：仍然显示。** 指示灯由**系统绘制在状态栏/系统 UI 上**，与应用页面内容无关：
  - iOS：iOS 14+ 起，App 使用摄像头/麦克风时状态栏显示橙色点（麦克风）或**绿色点（摄像头，或摄像头+麦克风）**（[Apple Support HT211876](https://support.apple.com/en-us/HT211876)）。
  - Android：Android 12+ 在状态栏显示摄像头/麦克风「使用中」指示，由 System UI 依据 app ops 绘制（[AOSP · Privacy indicators](https://source.android.com/docs/core/permissions/privacy-indicators)）。
  - 因此黑屏遮罩只遮住页面内容，状态栏的指示灯照常可见（此为基于上述「指示灯属于系统 UI」文档表述的合理推断）。
- **有没有 API 查询「摄像头是否被系统标记为使用中」：未发现任何 Web API 提供此信息**（在 MDN 摄像头相关 API 与 W3C 规范中均无此能力）——标注：未找到可靠来源（不存在此类 API 的公开记录）。App 只能通过自身 `MediaStreamTrack.readyState` 感知本地流状态，无法读取系统指示灯。

---

## 五、第 4 组：降级与增强选项

### 4.1 navigator.vibrate 支持矩阵

| 平台 | 结论 | 来源 |
|---|---|---|
| **iOS Safari** | **完全不支持**（caniuse：Safari 3.1–26.x、iOS Safari 3.2–26.x 全部不支持） | [caniuse/vibration](https://caniuse.com/vibration) |
| Android Chrome / Samsung Internet | 支持（Chrome for Android 支持；Chrome 桌面 30+、Edge 79+、Samsung Internet 4+） | [caniuse/vibration](https://caniuse.com/vibration) |
| Firefox | 桌面 11–128 支持、**129+ 已移除**；Firefox for Android 当前版本标注不支持 | [caniuse/vibration](https://caniuse.com/vibration) |

结论：vibrate 在 iOS 上不可用，**不能作为 iOS 的提醒降级手段**；Android 上可作为语音提醒的补充（需 feature-detect）。

### 4.2 检测 Wake Lock 可用性的可靠方法

- `'wakeLock' in navigator` 是官方示例使用的标准特性检测（[MDN 示例](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)），**但不够**：检测通过不代表请求成功——`request()` 仍可能因低电量、省电模式、文档不可见等原因拒绝（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)、[web.dev](https://web.dev/wakelock/)），iOS 上还出现过 visibilitychange 重取抛 `NotAllowedError` 的历史问题（[bug 255363](https://bugs.webkit.org/show_bug.cgi?id=255363)）。
- **可靠做法**：`'wakeLock' in navigator` 做门面检测 + `request()` 包 try/catch（捕获 `NotAllowedError` 等）+ 在用户手势（点击「开始学习」）内发起首次请求 + `visibilitychange` 恢复时重试（[web.dev 示例](https://web.dev/wakelock/)）。

### 4.3 其他防锁屏技巧（如隐藏循环播放视频）

- **存在但不可靠**：隐藏的静音循环视频是 Wake Lock 普及前的常见 hack（典型实现如 NoSleep.js）；社区高赞回答记录了该 hack（[SO：Can I prevent phone from sleep on a webpage](https://stackoverflow.com/questions/6106747/can-i-prevent-phone-from-sleep-on-a-webpage)）。
- Google 官方称 Wake Lock 的推出正是为了「减少 hacky 且可能耗电的变通方案」——即官方不认可此类 hack 的可靠性（[web.dev/wakelock](https://web.dev/wakelock/)）；NoSleep.js 的回答亦注明其存在「reliability/performance issues on some platforms」（[SO 同页](https://stackoverflow.com/questions/6106747/can-i-prevent-phone-from-sleep-on-a-webpage)）。
- 结论：**不采用**；Wake Lock 是唯一值得依赖的机制，hack 仅作「未找到可靠来源」级别的备注。

---

## 六、第 5 组：省电参考

### 5.1 OLED vs LCD 显示纯黑的耗电差异

- **OLED**：无背光，像素自发光——**黑色像素不发光、耗电低**；深色模式省电幅度主要由**屏幕亮度**决定：30%–50% 亮度下切深色模式平均只省 **3%–9%** 功率，100% 亮度下省 **39%–47%**（普渡大学 MobiSys 2021 实测研究，官方新闻稿：[EurekAlert](https://www.eurekalert.org/news-releases/923727)）。
- **LCD**：**背光常亮**，显示黑色并不能关闭背光，深色/纯黑几乎不省电（同上研究：「OLED 没有背光、LCD 有背光」是两者耗电差异的根源）。
- Google 也公开确认过深色可省电（2018-11 官方表态报道：[Android Police](https://www.androidpolice.com/2018/11/09/google-admits-much-white-space-apps-bad-battery-life/)）。
- 结论：专注模式的全黑遮罩在 **OLED 屏上有省电收益、LCD 屏上几乎无收益**；且收益集中在像素发光功耗，屏幕背光/面板驱动与整机待机功耗仍然存在。

### 5.2 前置摄像头 + 轻量姿态推理连续 40 分钟的量级参考

- **官方没有发布「连续运行 40 分钟」的毫安时/发热测量**——标注：未找到可靠来源（MediaPipe 官方只发布模型性能/FPS 基准，不做整机功耗声明）。
- 可参考的量级（均来自本仓库已有研究或官方数据，属**推断性量级**，非整机实测）：
  - MediaPipe Pose Landmarker lite 模型单帧推理：Pixel 3（TFLite GPU）约 20 ms；WebGL 下 iPhone 12 / Pixel 5 可达 ≥20 FPS（[`.scratch/posture-app/research/01-pose-estimation.md`](../../posture-app/research/01-pose-estimation.md) 汇总的官方基准）。
  - 相机采集 + WASM/WebGL 推理 + 屏幕常亮三者叠加，属于**持续中高负载场景**，整机续航会显著短于纯浏览/纯待机；具体 mAh 随设备、亮度、模型档位差异很大，需真机实测才能给数。
  - 降耗建议方向（依据上述事实）：优先 `pose_landmarker_lite` + 降低推理频率（如 15 FPS 检测即可满足坐姿判定） + OLED 设备上黑屏遮罩本身有省电收益（见 5.1）。

---

## 七、对专注模式的影响

### 成立的假设（可直接采用）

1. **黑屏遮罩不中断检测**——只要标签页前台可见，getUserMedia / MediaPipe / WebAudio 全部照常（见第 3 组·3.1）。黑屏遮罩 = 页面内覆盖层，不改变 visibilityState。
2. **Wake Lock 能真正防止自动锁屏**——iOS Safari 16.4+、Android Chrome 84+、桌面 Chrome/Edge/Firefox 126+（见第 1 组·1.1）。这是让「40 分钟学习不锁屏」成立的唯一平台级手段。
3. **iOS 摄像头授权在锁屏恢复后无需重授**，但流已停止、页面可能已被重载（见第 2 组·2.1）——因此「恢复」逻辑必须健壮（见下）。

### 需要降级的假设

1. **iOS standalone PWA（添加到主屏幕）中 Wake Lock 不可靠**——历史上不可用（bug 254545），2024 年仍有不一致报告（见第 1 组·1.2）。专注模式若以「安装到主屏幕」为主要形态，**不能假设 wake lock 一定生效**。
2. **iOS 上 visibilitychange 后重新获取可能抛 `NotAllowedError`**（见第 1 组·1.2，bug 255363 已修但需真机验证）——重新获取不能静默失败，要暴露给用户。
3. **系统锁屏（电源键/超时兜底）后无法后台运行**——这是平台硬约束（见第 2 组·2.3），锁屏 = 检测中断；「继续运行」不在 Web 能力范围内。
4. **内存压力下页面可能被 iOS 终止并重载**（见第 2 组·2.1，bug 300782）——40 分钟 MediaPipe 会话不能假设页面状态（姿态基准、学习时长）仍在内存里。
5. **Android 厂商省电策略可能杀后台标签页**（见第 2 组·2.2）——专注模式全程前台运行，受影响较小，但「退到后台再回来」路径不可依赖。

### 降级方案建议

1. **Wake Lock 获取策略**：进入专注模式（用户点击手势内）即 `navigator.wakeLock.request('screen')`，try/catch；`visibilitychange` 回到可见时重新获取；`release` 事件触发时更新 UI 状态（「屏幕保护已开启/未开启」）。
2. **失败降级**：请求被拒或 `'wakeLock' in navigator` 为 false（iOS < 16.4、standalone PWA 场景）→ 进入专注模式前明确提示「本设备/浏览器无法保持屏幕常亮，学习过程中可能锁屏」，仍允许使用（检测在锁屏前照常工作）。
3. **锁屏/中断恢复**：监听 `visibilitychange` 与 `pageshow`（判别是否 bfcache/重载恢复，依据 [Page Lifecycle API](https://developer.chrome.com/articles/page-lifecycle-api)）；恢复后：重新请求摄像头（`getUserMedia`）、重启 MediaPipe 会话、将学习时长计入「本次会话」而非「连续时长」，并在基准丢失时重新校准姿势基准——不做静默假设。
4. **不要用隐藏视频等 hack 防锁屏**（见第 4 组·4.3）——不可靠且耗电，唯一依赖 Wake Lock。
5. **省电**：黑屏遮罩在 OLED 设备上有像素级省电收益（LCD 无，见第 5 组·5.1）；推理用 lite 模型并适当降频（见第 5 组·5.2）；提醒用语音（iOS 无 vibrate，见第 4 组·4.1），Android 可叠加 vibrate（需 feature-detect）。
6. **真机回归清单**：iPhone（Safari 内 + 主屏幕 PWA 两种形态）× iOS 16.4/17/18/26；Android（Chrome）× 小米/华为/OPPO 至少各一台；重点验证：40 分钟不锁屏、锁屏后解锁恢复、standalone PWA 的 wake lock 表现（见第 1 组·1.2 已知风险）。
