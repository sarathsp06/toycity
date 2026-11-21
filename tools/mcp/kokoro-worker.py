# Text to speech for Toy City agents with Kokoro (kokoro-onnx): loads the model once, then reads one
# JSON request per line on stdin {"text", "voice", "speed", "out"} and answers {"ok", "seconds"} per line.
# Started by server.mjs: python kokoro-worker.py <model.onnx> <voices.bin>
import sys, json
import kokoro_onnx, soundfile as sf

model = kokoro_onnx.Kokoro(sys.argv[1], sys.argv[2])
print(json.dumps({"ready": True, "voices": sorted(model.get_voices())}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
        samples, rate = model.create(req["text"], voice=req.get("voice") or "af_heart", speed=float(req.get("speed") or 1.0))
        sf.write(req["out"], samples, rate, subtype="PCM_16")
        print(json.dumps({"ok": True, "seconds": len(samples) / rate}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}), flush=True)
