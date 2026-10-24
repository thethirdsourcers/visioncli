"""Long-lived Chatterbox Turbo TTS worker for the visioncli overlay (the same protocol as kokoro_server.py).

Reads JSON lines {"id", "text"} on stdin and answers {"id", "path"} (a WAV file) or {"id", "error"} on stdout. Prints
{"ready": true} once the model is loaded. Uses the MLX build (Apple Silicon), about 1.6x faster than real time; speed
isn't a model option, so the player speeds the audio up.
Run: uv run --python 3.11 --with mlx-audio --with soundfile python chatterbox_server.py OUT_DIR
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model

out_dir = sys.argv[1]
model = load_model("mlx-community/chatterbox-turbo-4bit")
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid = req.get("id")
    try:
        audio = np.concatenate([np.array(r.audio) for r in model.generate(req["text"], verbose=False)])
        path = os.path.join(out_dir, f"tts-cb-{os.getpid()}-{rid}.wav")
        sf.write(path, audio, model.sample_rate)
        print(json.dumps({"id": rid, "path": path}), flush=True)
    except Exception as e:  # keep serving
        print(json.dumps({"id": rid, "error": str(e)}), flush=True)
