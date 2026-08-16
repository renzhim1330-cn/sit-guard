#!/usr/bin/env python3
"""生成「坐姿小卫士」默认语音（13 条 mp3）到 app/audio/。

用法：
    pip install edge-tts
    python app/generate_voice.py
    # 可选参数：
    #   --voice zh-CN-XiaoxiaoNeural   声线（默认：晓晓，温暖女声）
    #   --rate  -5%%                    语速（负=慢，正=快）
    #   --pitch +8Hz                   音高
    # 列出全部可用中文声线：edge-tts --list-voices | findstr zh-CN

生成后把 app/audio/ 提交进仓库，所有设备（含移动端）即可离线播放默认语音。
"""
import argparse
import asyncio
import os
import sys

try:
    import edge_tts
except ImportError:
    print("缺少 edge-tts：请先运行  pip install edge-tts", file=sys.stderr)
    sys.exit(1)

# 与 app/voice.js 的 SCRIPTS 保持一致（类别-序号 = 文件名）
SCRIPTS = {
    "slouch":    ["腰背挺直～", "背要挺直哦～"],
    "headDrop":  ["头抬起来一点哦～", "脑袋抬起来一点～"],
    "tilt":      ["身体坐正，别歪哦～", "坐直一点，别歪啦～"],
    "fallback":  ["坐端正哦～", "换个舒服又端正的姿势～"],
    "praise":    ["坐正啦，真棒！", "背挺直了，真棒！", "好样的，继续保持～"],
    "start":     ["开始学习啦，加油～"],
    "end":       ["学习结束，休息一下吧～"],
}

DEFAULT_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")


async def gen_one(text: str, out: str, voice: str, rate: str, pitch: str, retries: int = 3) -> None:
    for attempt in range(retries):
        try:
            tts = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            await tts.save(out)
            if os.path.getsize(out) > 0:
                return
            print(f"    警告：{out} 为空，重试 {attempt + 1}/{retries}…")
        except Exception as e:  # noqa: BLE001 —— edge-tts 接口偶发 NoAudioReceived/网络错误
            print(f"    失败（{e.__class__.__name__}），重试 {attempt + 1}/{retries}…")
        await asyncio.sleep(2 * (attempt + 1))
    try:
        os.remove(out)
    except OSError:
        pass
    raise RuntimeError(f"生成失败（已重试 {retries} 次）：{out}")


async def gen_all(outdir: str, voice: str, rate: str, pitch: str) -> list[str]:
    os.makedirs(outdir, exist_ok=True)
    total = sum(len(v) for v in SCRIPTS.values())
    failed: list[str] = []
    done = 0
    for cat, lines in SCRIPTS.items():
        for i, text in enumerate(lines):
            out = os.path.join(outdir, f"{cat}-{i}.mp3")
            print(f"[{done + 1}/{total}] {os.path.basename(out)}  ←  {text}")
            try:
                await gen_one(text, out, voice, rate, pitch)
            except RuntimeError as e:
                print(f"    ❌ {e}")
                failed.append(os.path.basename(out))
            done += 1
    if failed:
        print(f"完成（{total - len(failed)}/{total}），失败 {len(failed)} 条：{', '.join(failed)}（可重跑本脚本续生成）")
    else:
        print(f"完成：{total} 条已写入 {outdir}")
    return failed


def main() -> None:
    # 控制台 UTF-8，避免中文输出乱码
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural", help="edge-tts 声线（默认晓晓）")
    ap.add_argument("--rate", default="-5%", help="语速，如 -5%%（稍慢）")
    ap.add_argument("--pitch", default="+8Hz", help="音高，如 +8Hz")
    ap.add_argument("--outdir", default=DEFAULT_OUTDIR)
    args = ap.parse_args()
    failed = asyncio.run(gen_all(args.outdir, args.voice, args.rate, args.pitch))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
