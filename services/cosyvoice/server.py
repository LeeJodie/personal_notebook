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

# CosyVoice loads official wetext resources on first start. Keep every
# deployment asset beside this service rather than in a developer home cache.
os.environ.setdefault("MODELSCOPE_CACHE", str(SERVICE_DIR / "modelscope-cache"))
os.environ.setdefault("HF_HOME", str(SERVICE_DIR / "huggingface-cache"))

for path in (COSYVOICE_DIR, COSYVOICE_DIR / "third_party" / "Matcha-TTS"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

cosyvoice: Any | None = None
inference_lock = threading.Lock()


def use_project_wetext_cache() -> None:
    """Prevent wetext from checking ModelScope whenever the service starts.

    CosyVoice imports ``wetext.Normalizer`` inside its frontend constructor.
    The normalizer otherwise calls ``snapshot_download`` even when the files
    are cached.  The adapter supplies the packaged FST paths directly, so a
    private deployment needs no outbound network dependency at runtime.
    """

    import wetext
    from wetext import Normalizer as WetextNormalizer

    wetext_dir = SERVICE_DIR / "modelscope-cache" / "hub" / "pengzhendong" / "wetext"
    required_paths = [
        wetext_dir / "zh" / "tn" / "tagger.fst",
        wetext_dir / "zh" / "tn" / "verbalizer.fst",
        wetext_dir / "en" / "tn" / "tagger.fst",
        wetext_dir / "en" / "tn" / "verbalizer.fst",
    ]
    if not all(path.is_file() for path in required_paths):
        raise RuntimeError(f"Packaged wetext resources were not found: {wetext_dir}")

    class ProjectWetextNormalizer(WetextNormalizer):
        def __init__(self, *args: Any, **kwargs: Any):
            if args or kwargs.get("tagger_path") is not None or kwargs.get("verbalizer_path") is not None:
                super().__init__(*args, **kwargs)
                return
            # CosyVoice creates the Chinese normalizer with an explicit
            # remove_erhua keyword, then creates the English normalizer with
            # defaults. Both are TN mode for the SFT reader pipeline.
            language = "zh" if "remove_erhua" in kwargs else "en"
            operator = str(kwargs.get("operator", "tn"))
            if operator != "tn":
                super().__init__(*args, **kwargs)
                return
            verbalizer_name = "verbalizer_remove_erhua.fst" if kwargs.get("remove_erhua") else "verbalizer.fst"
            super().__init__(
                tagger_path=str(wetext_dir / language / "tn" / "tagger.fst"),
                verbalizer_path=str(wetext_dir / language / "tn" / verbalizer_name),
                lang=language,
                operator="tn",
            )

    wetext.Normalizer = ProjectWetextNormalizer


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


def speaker_language(speaker_id: str) -> str:
    if speaker_id.startswith("英文"):
        return "en-US"
    if speaker_id.startswith("日语"):
        return "ja-JP"
    if speaker_id.startswith("韩语"):
        return "ko-KR"
    if speaker_id.startswith("粤语"):
        return "zh-HK"
    return "zh-CN"


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
    use_project_wetext_cache()
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
            {"id": speaker, "label": speaker_label(speaker), "language": speaker_language(speaker)}
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
