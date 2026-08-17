"""Private CosyVoice adapter for the ShengYue reader.

The upstream project remains in ``services/cosyvoice/CosyVoice`` and model
weights stay in ``services/cosyvoice/models`` so both can be packaged beside
the application without exposing a public TTS endpoint.  This adapter provides
the small, stable contract the Worker needs: enumerate SFT speakers and return
one WAV response for a bounded text segment.
"""

from __future__ import annotations

import io
import os
import sys
import threading
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

SERVICE_DIR = Path(__file__).resolve().parent
COSYVOICE_DIR = SERVICE_DIR / "CosyVoice"
DEFAULT_MODEL_DIR = SERVICE_DIR / "models" / "CosyVoice-300M-SFT"
MODEL_DIR = Path(os.environ.get("COSYVOICE_MODEL_DIR", str(DEFAULT_MODEL_DIR))).expanduser()
MAX_TEXT_CHARS = 1_500

for path in (COSYVOICE_DIR, COSYVOICE_DIR / "third_party" / "Matcha-TTS"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

cosyvoice: Any | None = None
inference_lock = threading.Lock()


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice_id: str = Field(min_length=1, max_length=120)
    speed: float = Field(default=1.0, ge=0.75, le=1.25)


def speaker_label(speaker_id: str) -> str:
    labels = {
        "中文女": "中文女声",
        "中文男": "中文男声",
        "粤语女": "粤语女声",
        "英文女": "英文女声",
        "英文男": "英文男声",
        "日语男": "日语男声",
        "日语女": "日语女声",
        "韩语女": "韩语女声",
    }
    return labels.get(speaker_id, speaker_id)


def wav_from_outputs(outputs: Any, sample_rate: int) -> bytes:
    frames: list[bytes] = []
    for output in outputs:
        samples = output["tts_speech"].detach().cpu().numpy().reshape(-1)
        pcm16 = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
        frames.append(pcm16.tobytes())
    if not frames:
        raise ValueError("CosyVoice did not produce audio")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(frames))
    return buffer.getvalue()


def synthesize(request: SynthesisRequest) -> bytes:
    if cosyvoice is None:
        raise RuntimeError("CosyVoice model has not loaded")
    if request.voice_id not in cosyvoice.list_available_spks():
        raise KeyError(request.voice_id)
    with inference_lock:
        outputs = cosyvoice.inference_sft(request.text, request.voice_id, stream=False, speed=request.speed)
        return wav_from_outputs(outputs, cosyvoice.sample_rate)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global cosyvoice
    if not COSYVOICE_DIR.is_dir():
        raise RuntimeError(f"CosyVoice source was not found: {COSYVOICE_DIR}")
    if not MODEL_DIR.is_dir():
        raise RuntimeError(f"CosyVoice SFT model was not found: {MODEL_DIR}. Run npm run setup:tts-model first.")
    from cosyvoice.cli.cosyvoice import AutoModel

    cosyvoice = AutoModel(model_dir=str(MODEL_DIR), load_jit=False, load_trt=False, fp16=False)
    yield
    cosyvoice = None


app = FastAPI(title="ShengYue CosyVoice", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ready" if cosyvoice is not None else "starting",
        "provider": "CosyVoice",
        "model": MODEL_DIR.name,
        "voice_count": len(cosyvoice.list_available_spks()) if cosyvoice is not None else 0,
    }


@app.get("/v1/voices")
def voices() -> dict[str, Any]:
    if cosyvoice is None:
        return JSONResponse({"message": "CosyVoice is starting"}, status_code=503)
    return {
        "provider": "cosyvoice",
        "model": MODEL_DIR.name,
        "items": [
            {"id": speaker, "label": speaker_label(speaker), "language": "zh-CN"}
            for speaker in cosyvoice.list_available_spks()
        ],
    }


@app.post("/v1/synthesize")
def synthesize_wav(request: SynthesisRequest) -> Response:
    try:
        audio = synthesize(request)
    except KeyError:
        raise HTTPException(status_code=422, detail="Unknown CosyVoice voice_id") from None
    except ValueError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"cache-control": "no-store", "x-tts-provider": "CosyVoice", "x-tts-model": MODEL_DIR.name},
    )
