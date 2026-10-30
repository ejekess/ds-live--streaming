"""常驻 TTS worker：读 JSONL 请求 → 合成 mp3 → 回一行结果。

为什么常驻：edge-tts 每次启动都要初始化 aiohttp + 建连接，单次冷启动约 2.5 秒；
直播里每条回复都等 2.5 秒是不能接受的。常驻后单句通常 300–600ms。

协议（一行一条）：
  入  {"id":"v_1","text":"你好呀","out":"D:/.../x.mp3","voice":"zh-CN-XiaoyiNeural","pitch":"+12Hz","rate":"-20%"}
  出  {"id":"v_1","ok":true,"ms":420}   或   {"id":"v_1","ok":false,"error":"..."}

依赖 edge_tts（本项目装在 data/pylibs，靠 PYTHONPATH 注入）。
"""

import asyncio
import json
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import edge_tts
except Exception as exc:  # noqa: BLE001
    print(json.dumps({"id": None, "ok": False, "error": f"import edge_tts failed: {exc}"}), flush=True)
    sys.exit(1)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def synth(req):
    started = time.time()
    comm = edge_tts.Communicate(
        req["text"],
        req.get("voice") or "zh-CN-XiaoyiNeural",
        pitch=req.get("pitch") or "+0Hz",
        rate=req.get("rate") or "+0%",
    )
    await comm.save(req["out"])
    emit({"id": req.get("id"), "ok": True, "ms": int((time.time() - started) * 1000)})


async def main():
    emit({"id": None, "ok": True, "hello": True})
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            emit({"id": None, "ok": False, "error": f"bad json: {exc}"})
            continue
        try:
            await synth(req)
        except Exception as exc:  # noqa: BLE001
            emit({"id": req.get("id"), "ok": False, "error": str(exc)})


asyncio.run(main())
