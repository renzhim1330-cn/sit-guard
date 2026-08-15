# 姿势估计技术选型与可行性（研究结论）

> 票号：`issues/01-pose-estimation-feasibility.md`（research）
> 目标载体：网页 App（PWA），手机 / 平板浏览器 + **前置摄像头**，姿态估计全程在设备本地完成。
> 需判定的三类姿态：**驼背、头过低、侧倾**——要求覆盖鼻 / 耳 / 肩 / 髋关键点。
> 定位：儿童创意作品，轻量、可现场演示、无后端、纯前端。

---

## 一、结论速览（TL;DR）

**推荐：MediaPipe Pose Landmarker（`@mediapipe/tasks-vision`），模型用 `pose_landmarker_lite`（约 5.5 MB），优先 CDN 加载。**

核心理由（详见后文）：
1. 唯一仍在积极维护、且由 Google 官方持续发布的方案（最新 `1.0.1`，2026-07-31）。
2. 输出 **33 个关键点 + 3D world landmarks（米制深度）**，鼻/耳/肩/髋全部覆盖，并且能直接用 z 坐标判「头过低/驼背」这类**前后向**位移——其余候选只有 2D (x, y)，判深度更难。
3. 移动端实测：同一 BlazePose 家族的 lite 模型在 Pixel 3（TFLite GPU）上约 **20 ms**；WebGL 下 iPhone 12 / Pixel 5 也达 ≥20 FPS（见性能节）。中端手机 / iPad 9 代用 lite 模型满足 ≥20 FPS 目标。
4. 加载简单：CDN 一行 `vision_bundle.mjs` + `FilesetResolver.forVisionTasks(...)`，无 TensorFlow.js 全家桶依赖。

---

## 二、候选库对比表

| 候选 | 维护状态 | 模型体积 | 关键点数 | 移动端浏览器推理速度（官方数据） | 关键点覆盖（鼻/耳/肩/髋） |
|---|---|---|---|---|---|
| **MediaPipe Pose Landmarker**（`@mediapipe/tasks-vision`） | ✅ **活跃**（最新 `1.0.1`，2026-07-31） | lite **5.51 MB** / full 8.96 MB / heavy 29.24 MB（float16 `.task`，实测 HEAD） | **33**（含 3D world landmarks） | Pixel 3 TFLite GPU：lite 20ms / full 25ms / heavy 53ms；WebGL：iPhone12 ≈34、Pixel5 ≈12（BlazePose-TFJS 基线） | ✅ 鼻(0)、耳(7/8)、肩(11/12)、髋(23/24) 全有 + 3D |
| MoveNet（`@tensorflow-models/pose-detection`） | ⚠️ 停滞（最新 `2.1.3`，2023-08-29） | Lightning ≈4.8 MB / Thunder ≈10.6 MB（tf.hub 托管） | **17**（仅 2D） | WebGL：iPhone12 Lightning 51 / Thunder 43 FPS；Pixel5 34 / 12 FPS | ✅ COCO 17 点含鼻/耳/肩/髋；无 z |
| 旧版 `@mediapipe/pose` | ❌ **已废弃**（0.5.x，2023-02-04；2023-05-10 官方宣告升级到 Tasks） | 同 BlazePose lite/full/heavy | 33 | 与上同源 | ✅ 但 API 已停更 |
| YOLOv8-pose（ONNX Runtime Web） | ⚠️ 需自组装（ultralytics + `onnxruntime-web` 1.27.0） | yolov8n-pose ONNX ≈3.4 MB + ORT 运行时（WASM 数 MB） | **17**（仅 2D） | 无官方浏览器 FPS 表；WebGPU 后端在 iOS 老版本不可用 | ✅ COCO 17 点；无 z |
| PoseNet | ❌ **已废弃**（官方注明被 pose-detection 取代） | 旧版 tfjs 模型 | 17（2D） | 慢于 MoveNet | ✅ 但过时 |

> 模型体积出处：MediaPipe 三个 `.task` 文件体积为对官方 Google Storage 文件 `Content-Length` 的实测（见 §五链接）；MoveNet 体积为 tf.hub/Kaggle 模型卡的约数。

---

## 三、各候选详细评估

### 3.1 MediaPipe Pose Landmarker（推荐）

- **来源与维护**：Google AI Edge 官方，代码在 [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe)，npm 包 [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision)，**最新 `1.0.1`（2026-07-31）**，持续发版（0.10.x 长期线 + 2026 年 1.0.x）。
- **模型**：三个 bundle——`pose_landmarker_lite` / `_full` / `_heavy`，均为 float16，输入 224×224（检测器）+ 256×256（landmark 器），基于 MobileNetV2 类似结构 + BlazePose + GHUM（[官方 Models 说明](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker#models)）。
- **体积（实测 HEAD Content-Length）**：
  - `pose_landmarker_lite.task` = **5,777,746 B ≈ 5.51 MB**
  - `pose_landmarker_full.task` = 9,398,198 B ≈ 8.96 MB
  - `pose_landmarker_heavy.task` = 30,664,242 B ≈ 29.24 MB
- **输出**：每个 pose 33 个 landmark（`x/y/z/visibility/presence`）+ **WorldLandmarks**（米制 3D，髋中心为原点）+ 可选 segmentation mask（[web 指南](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)）。**这是关键优势：z / world 坐标可直接估「头过低 / 驼背」的前后向位移，无需相机标定。**
- **Web 运行后端**：`FilesetResolver.forVisionTasks(wasm 路径)` 后，`createFromOptions` 的 `Delegate` 取 `CPU`（默认，WASM）或 `GPU`。**GPU delegate 走 WebGL（OffscreenCanvas），WebGPU 尚未支持**（官方 issue [WebGPU support for Vision Tasks #5826](https://github.com/google-ai-edge/mediapipe/issues/5826) 仍 open）。
- **同步阻塞注意**：`detect()/detectForVideo()` 同步执行、阻塞主线程，官方建议放进 Web Worker（[web 指南](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)）。
- **浏览器要求**：官方 setup 文档只写 "Chrome or Safari"（[setup_web](https://ai.google.dev/edge/mediapipe/solutions/setup_web)）。

### 3.2 MoveNet（备选）

- **来源**：[tensorflow/tfjs-models · pose-detection · MoveNet](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md)。
- **关键点**：17 个 COCO 关键点（仅 2D `x/y/score`，无深度）。
- **变体**：`SINGLEPOSE_LIGHTNING`（输入 192，默认）/ `SINGLEPOSE_THUNDER`（256，更准更慢）/ `MULTIPOSE_LIGHTNING`。
- **官方移动端基准（WebGL）**：iPhone 12 = Lightning **51** / Thunder **43** FPS；Pixel 5 = **34** / **12** FPS（[MoveNet README · Performance](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md#performance)）。
- **劣势**：包最后一次发版 `2.1.3`（2023-08-29），长期停滞；依赖 tfjs-core + converter + backend-webgl（或 wasm），链重；无 3D 深度，判「头过低/驼背」只能靠 2D 几何。

### 3.3 旧版 `@mediapipe/pose`（不推荐）

- 是 MediaPipe **Legacy Solution**，官方在 2023-05-10 起升级到新 MediaPipe Tasks（[legacy pose.md](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md) 顶部 Attention）。
- npm [`@mediapipe/pose`](https://www.npmjs.com/package/@mediapipe/pose) 停在 `0.5.1675469404`（2023-02-04），不再维护；用法与现网大量旧教程一致（`new Pose(...)` + `@mediapipe/camera_utils`），但应避免新项目采用。

### 3.4 YOLOv8-pose（ONNX Runtime Web，不推荐本场景）

- Ultralytics [pose 任务文档](https://docs.ultralytics.com/tasks/pose/)：COCO-pose 17 关键点，可导出 ONNX。
- 浏览器运行需 [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web)（最新 `1.27.0`），后端 WASM（CPU）/ WebGL / WebGPU（[ORT Web 教程](https://onnxruntime.ai/docs/tutorials/web/)）。
- **劣势**：需自行写预处理 + NMS + 后处理拼装（无官方开箱 web pose 管线）；WebGPU 后端在 iOS Safari 26+ 才可用，老设备只能走更慢的 WASM；整体工程量和体积都不利于「轻量、现场演示」。

### 3.5 PoseNet（不推荐）

- 官方 README 明确 **deprecated**：`This package is deprecated in favor of the new pose-detection package`（[posenet README](https://github.com/tensorflow/tfjs-models/blob/master/posenet/README.md)）。
- 17 关键点、无深度、精度与速度均落后，直接排除。

---

## 四、移动浏览器兼容性结论

以下版本来自 [caniuse](https://caniuse.com) 数据（`webgl2` / `webgpu` / `stream` 三项）与 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

| 能力 | iOS Safari | Android Chrome（≈桌面 Chrome） | 对本项目的影响 |
|---|---|---|---|
| `getUserMedia`（前置摄像头） | **11.0+** | **Chrome 53+**（Android 随 Chrome） | 摄像头可用门槛很低 |
| HTTPS / 安全上下文 | `getUserMedia` **仅在安全上下文可用**（HTTPS 或 `localhost`），MDN 明确要求 | 同左 | **现场演示需 HTTPS 部署或 localhost**；`http://` 局域网 IP 会失败 |
| WebGL 2.0（GPU 加速） | **15.0+** | Chrome 56+ | MediaPipe GPU delegate 的门槛；**iOS Safari 15+ 才能 GPU 加速** |
| WebGPU | **26.0+**（2025 年新版本才有） | Chrome 113+（桌面，早期实验）/ Android Chrome 121+ 稳定 | 太新，老 iPad / 千元安卓机不可用；**本项目不要依赖 WebGPU** |
| WebAssembly（CPU 回退） | 11+ | 长期支持 | MediaPipe `Delegate: CPU` 的兜底路径，几乎处处可用 |

**结论**：
- **iOS Safari 最低建议目标 = 15+**（WebGL2 GPU 加速的分水岭；iPad 第 9 代预装 iOS 15，满足）。若只求「能用」可下探到 iOS 11（WASM/CPU + getUserMedia），但速度与发热风险上升。
- **Android Chrome**：现代版本（Chrome 56+）WebGL2 均可用，无实质门槛。
- **MediaPipe Tasks 的 GPU delegate = WebGL2，不是 WebGPU**（WebGPU 仍是 open feature request），所以别把 WebGPU 当硬依赖。
- **必须 HTTPS**（或 localhost）才能拿到前置摄像头；这是所有候选共同的硬约束。

---

## 五、性能数据与出处

1. **MediaPipe BlazePose 家族（legacy，同源模型）**——[google-ai-edge/mediapipe · docs/solutions/pose.md](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md)：
   - Pixel 3（TFLite GPU）：Heavy 53 ms、Full 25 ms、**Lite 20 ms**（≈50 FPS）。
   - 质量（PCK@0.2，Yoga/Dance/HIIT）：Lite 90.2 / 92.5 / 93.5，Full 95.5 / 96.3 / 95.7。
2. **BlazePose（TF.js runtime，WebGL）**——[tfjs-models · blazepose_tfjs README](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/blazepose_tfjs/README.md)：
   - iPhone 12：lite 34 / full 30 FPS；Pixel 5：lite 12 / full 11 / heavy 5 FPS（TF.js WebGL 运行时）。
   - 同表 MediaPipe Runtime（WASM+GPU）：Pixel 5 lite 32 / full 22 FPS——**原生 MediaPipe 运行时明显快于 TF.js 运行时**。
3. **MoveNet（TF.js WebGL）**——[tfjs-models · movenet README](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md)：
   - iPhone 12：Lightning 51 / Thunder 43 / Multipose 24 FPS；Pixel 5：34 / 12 / 8 FPS。

**对「中端手机 / iPad 9 代 ≥20 FPS」的判断**：
- MediaPipe `lite`（20 ms @ Pixel 3 原生 GPU）与 MoveNet Lightning（iPhone12 51 / Pixel5 34）都满足 **≥20 FPS**。
- `full`（25 ms @ Pixel 3）在较新设备上也能到 20 FPS 左右，但为**稳保 20 FPS 且降低发热**，现场演示优先 `lite`；若精度不足再上调 `full`。
- 发热：单帧推理越重越热；lite 模型 + `requestAnimationFrame` 按需采样（不必每帧都跑）+ 关闭 `outputSegmentationMasks` 可显著降负载。

---

## 六、关键点覆盖核对

三类姿态所需关键点与候选覆盖：

| 姿态 | 需要的关键点 | MediaPipe(33) | MoveNet(17) | YOLOv8-pose(17) |
|---|---|---|---|---|
| 头过低 | 鼻、耳（头相对肩的高度） | ✅ 鼻(0)、左右耳(7/8) + z 深度 | ✅ 鼻、左右耳 | ✅ 鼻、左右耳 |
| 驼背（含探头） | 耳/鼻相对肩髋的前后位移 | ✅ 耳、肩(11/12)、髋(23/24) + **world z** | ⚠️ 仅 2D，难判前后 | ⚠️ 仅 2D |
| 侧倾 | 左右肩 / 左右耳 / 左右髋对称性 | ✅ 全部 + 3D | ✅ 2D | ✅ 2D |

**决定项**：只有 MediaPipe 输出 3D world landmarks，能用 z 轴区分「头过低 / 驼背」这类**前后向**姿态，其它候选都只能靠 2D 几何近似，鲁棒性差。

---

## 七、最终推荐方案

### 选型
**MediaPipe Pose Landmarker（`@mediapipe/tasks-vision`）＋ `pose_landmarker_lite` 模型。**

### 理由
1. 唯一**活跃维护**且官方持续的方案，社区与文档最全。
2. 33 关键点 + 3D world landmarks，**鼻/耳/肩/髋全覆盖**，且能用 z 坐标判「头过低/驼背」的前后位移。
3. 移动端性能达标（lite 原生 GPU ≈20 ms），中端手机 / iPad 9 代可 ≥20 FPS。
4. 无 TensorFlow.js 依赖链，CDN 一行加载，符合「轻量、纯前端、现场演示」。

### 加载方式（推荐 CDN，便于无构建现场演示）
```html
<!-- head 内引入（官方 web 指南推荐） -->
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs"
        crossorigin="anonymous"></script>
```
```js
const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm"
);
const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath:
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    delegate: "GPU",            // WebGL2；老设备回退 "CPU"(WASM)
  },
  runningMode: "VIDEO",
  numPoses: 1,
});
```
- 若走 **npm**：`npm install @mediapipe/tasks-vision`，`FilesetResolver.forVisionTasks` 指向本地 `node_modules/.../wasm` 或将 `.task` 与 wasm 打包到静态资源。
- 建议 `detectForVideo()` 放进 **Web Worker** 避免阻塞主线程（官方示例：[pose-landmarker.worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/pose-landmarker.worker.ts)）。

### 建议版本号
- **`@mediapipe/tasks-vision@1.0.1`**（当前最新稳定，2026-07-31）。**显式锁定版本，勿用 `@latest`** 以免现场翻车；如遇 1.0.x 回归，回退到长期稳定线 **`0.10.21`**。
- 模型锁定 `pose_landmarker_lite/float16/latest/`（或自行固定 `/1/` 版本路径并本地托管以完全离线）。

### 备选
若 MediaPipe 因故不可用，**MoveNet（`@tensorflow-models/pose-detection` Lightning）** 是次选（17 点 2D，iPhone12 51 / Pixel5 34 FPS），但需自行用 2D 几何近似判前后向姿态，且该包已停滞维护。

---

## 八、主要出处链接

**MediaPipe（官方）**
- Pose Landmarker 总览：https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
- Pose Landmarker Web 指南：https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js
- Web 环境 setup：https://ai.google.dev/edge/mediapipe/solutions/setup_web
- WebGPU 支持请求（仍 open）：https://github.com/google-ai-edge/mediapipe/issues/5826
- Legacy Pose（升级声明 + 性能/质量表）：https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md

**TensorFlow.js（官方）**
- pose-detection 总 README（COCO/BlazePose 关键点图）：https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/README.md
- MoveNet README（17 点 + FPS 表）：https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md
- BlazePose TFJS README（体积 + FPS 表）：https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/blazepose_tfjs/README.md
- PoseNet（deprecated 声明）：https://github.com/tensorflow/tfjs-models/blob/master/posenet/README.md

**兼容性**
- caniuse WebGL2 / WebGPU / getUserMedia：https://caniuse.com/webgl2 · https://caniuse.com/webgpu · https://caniuse.com/stream
- MDN getUserMedia（安全上下文要求）：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia

**其它**
- Ultralytics YOLOv8 Pose（17 关键点）：https://docs.ultralytics.com/tasks/pose/
- ONNX Runtime Web 教程：https://onnxruntime.ai/docs/tutorials/web/
- npm：`@mediapipe/tasks-vision` / `@mediapipe/pose` / `@tensorflow-models/pose-detection` / `onnxruntime-web`
