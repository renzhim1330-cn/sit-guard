# app/audio — 内置默认语音

13 条 mp3（约 9–17 KB/条），由 `generate_voice.py` 用 edge-tts（声线 `zh-CN-XiaoxiaoNeural`，温暖女声）生成。

**播放链**：家长录音 > 内置 mp3 > 系统 TTS > 提示音。内置 mp3 随仓库部署，移动端用 `<audio>` 播放，不依赖系统 TTS 引擎。

## 重新生成

```powershell
pip install edge-tts
python app/generate_voice.py
```

可选参数：`--voice`（声线，默认晓晓）、`--rate`（语速，默认 -5% 稍慢）、`--pitch`（音高，默认 +8Hz）。
列出全部中文声线：`edge-tts --list-voices | findstr zh-CN`

## 手动替换（不用 Python 也行）

用任意 TTS 工具（TTSMaker 等）按下列文件名导出 13 条 mp3 覆盖即可（文案必须与界面一致）：

| 文件 | 文案 |
|---|---|
| `slouch-0.mp3` / `slouch-1.mp3` | 背挺直～ / 背要挺直哦～ |
| `headDrop-0.mp3` / `headDrop-1.mp3` | 头抬起来一点哦～ / 脑袋抬起来一点～ |
| `tilt-0.mp3` / `tilt-1.mp3` | 身体坐正，别歪哦～ / 坐直一点，别歪啦～ |
| `fallback-0.mp3` / `fallback-1.mp3` | 坐端正哦～ / 换个舒服又端正的姿势～ |
| `praise-0.mp3` / `praise-1.mp3` / `praise-2.mp3` | 坐正啦，真棒！ / 背挺直了，真棒！ / 好样的，继续保持～ |
| `start-0.mp3` | 开始学习啦，加油～ |
| `end-0.mp3` | 学习结束，休息一下吧～ |
