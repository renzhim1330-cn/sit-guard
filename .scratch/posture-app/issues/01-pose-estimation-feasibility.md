Type: research
Status: resolved

# 姿势估计技术选型与可行性

## Question

为「网页 App + 手机 / 平板前置摄像头实时坐姿检测」选定姿势估计技术方案，并确认可行性：

1. **候选库**：MediaPipe Pose Landmarker（`@mediapipe/tasks-vision`）、TensorFlow.js MoveNet、旧版 `@mediapipe/pose`、YOLOv8-pose（ONNX Runtime Web）、PoseNet——各自的维护状态、模型体积、输出关键点数（33 / 17）、移动端浏览器实测推理速度。
2. **移动浏览器兼容性**：iOS Safari（最低版本要求）、Android Chrome 对 WebGL / WebGPU、`getUserMedia` 前置摄像头、HTTPS 限制的支持现状。
3. **性能**：中端手机 / 平板（如 iPad 第 9 代、千元安卓机）能否实时（≥20 FPS），是否明显发热。
4. **关键点覆盖**：检测「驼背、头过低、侧倾」需要鼻 / 耳 / 肩 / 髋等关键点，各候选是否覆盖。
5. **结论**：给出推荐方案 + 理由 + 加载方式（CDN / npm）+ 建议版本。

解析方式：`/research` 子代理查官方文档与高可信一手来源，结论全文写入 `.scratch/posture-app/research/01-pose-estimation.md`，本文件 `## Answer` 记录要点并链接过去。

## Answer

**推荐：MediaPipe Pose Landmarker（`@mediapipe/tasks-vision`）+ `pose_landmarker_lite` 模型，CDN 加载，锁定版本 `1.0.1`。**

- 唯一仍在活跃维护的官方方案（最新 1.0.1，2026-07-31）；输出 **33 关键点 + 3D world landmarks**，鼻/耳/肩/髋全覆盖，且能用 z 坐标判「头过低/驼背」的前后位移（其余候选仅 2D）。
- 体积：lite ≈ **5.5 MB**（full 8.96 / heavy 29.24 MB，实测）；移动端 lite 原生 GPU ≈ 20 ms，iPhone12/Pixel5 WebGL ≥20 FPS，中端手机 / iPad 9 代可满足 ≥20 FPS。
- 兼容性：前置摄像头需 **HTTPS**（或 localhost）；GPU 加速走 **WebGL2**（iOS Safari 15+，Android Chrome 56+），**WebGPU 不可依赖**（iOS Safari 26+ 才有，且 MediaPipe 视觉任务尚未支持）。
- 淘汰：旧版 `@mediapipe/pose`（2023 废弃）、PoseNet（deprecated）、MoveNet/YOLOv8-pose（停滞/需自组装且无 3D 深度）——次选为 MoveNet Lightning。

完整结论与出处见 [research/01-pose-estimation.md](../research/01-pose-estimation.md)。
