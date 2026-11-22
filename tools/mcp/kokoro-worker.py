# Text to speech for Toy City agents with Kokoro (kokoro-onnx): loads the model once, then reads one
# JSON request per line on stdin {"id", "text", "voice", "speed"} and answers one line per request
# {"id", "ok", "seconds", "wav"} (wav: 16-bit WAV as base64). The id is echoed so a late or lost
# reply can never be taken for the next request's. Started by speech.mjs:
#   python -I kokoro-worker.py <model.onnx> <voices.bin>
import sys, json, io, base64
import kokoro_onnx, soundfile as sf

model = kokoro_onnx.Kokoro(sys.argv[1], sys.argv[2])
print(json.dumps({"ready": True, "voices": sorted(model.get_voices())}), flush=True)
for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        samples, rate = model.create(req["text"], voice=req.get("voice") or "af_heart", speed=float(req.get("speed") or 1.0))
        buf = io.BytesIO()
        sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
        print(json.dumps({"id": req.get("id"), "ok": True, "seconds": len(samples) / rate, "wav": base64.b64encode(buf.getvalue()).decode()}), flush=True)
    except Exception as e:
        print(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "ok": False, "error": str(e)[:300]}), flush=True)
