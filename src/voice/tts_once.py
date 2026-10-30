"""一次性 TTS：读请求文件 → 合成 → 写结果文件。

为什么需要它：常驻 worker 用的是管道 stdio，但在某些受限环境（沙箱、
CI、没有控制台的守护进程）里 `spawn(..., stdio:'pipe')` 会直接 EPERM。
这个脚本只用 argv + 文件，`stdio:'ignore'` 就能跑，作为兜底通道。

代价是每次都要付 Python 启动 + import 的时间（约 2.5 秒），
所以只在管道不可用时才走这条路。

入（JSON 文件）：
  {"text":"你好呀","out":"D:/.../x.mp3","voice":"zh-CN-XiaoyiNeural","pitch":"+12Hz","rate":"-20%"}
出（同目录同名 .res.json）：
  {"ok":true,"ms":420}  /  {"ok":false,"error":"..."}
"""

import json
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    if len(sys.argv) < 2:
        return 2
    req_path = sys.argv[1]
    with open(req_path, "r", encoding="utf-8") as fh:
        req = json.load(fh)

    started = time.time()
    try:
        import asyncio
        import edge_tts

        asyncio.run(
            edge_tts.Communicate(
                req["text"],
                req.get("voice") or "zh-CN-XiaoyiNeural",
                pitch=req.get("pitch") or "+0Hz",
                rate=req.get("rate") or "+0%",
            ).save(req["out"])
        )
        result = {"ok": True, "ms": int((time.time() - started) * 1000)}
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "error": str(exc)}

    with open(req_path + ".res.json", "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    return 0 if result.get("ok") else 1


sys.exit(main())
