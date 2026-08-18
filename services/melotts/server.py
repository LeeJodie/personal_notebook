"""Private MeloTTS adapter for the ShengYue reader.

MeloTTS runs as an internal-only service and keeps the same small API exposed
by the previous provider: list the available voices and return a WAV payload
for a bounded text segment.  The Worker remains the only public entry point.
"""

from __future__ import annotations

import io
import os
import re
import threading
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from runtime import prepare_runtime

SERVICE_DIR = Path(__file__).resolve().parent
MAX_TEXT_CHARS = 1_500
MODEL_LANGUAGE = "ZH"
LOW_LATENCY_MODE = os.environ.get("MELOTTS_DISABLE_BERT", "1") == "1"

prepare_runtime(SERVICE_DIR)

melo_tts: Any | None = None
inference_lock = threading.Lock()
URL_PATTERN = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)
UNSUPPORTED_TEXT_PATTERN = re.compile(r"[^\u4e00-\u9fa5A-Za-z0-9\s!?…,.\-']+")


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice_id: str = Field(min_length=1, max_length=120)
    speed: float = Field(default=1.0, ge=0.75, le=1.25)


def voices_from_model() -> list[dict[str, str]]:
    if melo_tts is None:
        return []
    speaker_ids = vars(getattr(melo_tts.hps.data, "spk2id", {}))
    return [
        {
            "id": speaker_id,
            "label": "中文自然女声" if speaker_id == "ZH" else f"MeloTTS {speaker_id}",
            "language": "zh-CN",
        }
        for speaker_id in speaker_ids
    ]


def local_model_paths() -> tuple[str, str]:
    snapshots = SERVICE_DIR / "huggingface-cache" / "hub" / "models--myshell-ai--MeloTTS-Chinese" / "snapshots"
    candidates = sorted(snapshots.glob("*"))
    if not candidates:
        raise RuntimeError("MeloTTS 中文模型未安装；请先执行 npm run setup:tts-model。")
    model_dir = candidates[-1]
    config_path = model_dir / "config.json"
    checkpoint_path = model_dir / "checkpoint.pth"
    if not config_path.is_file() or not checkpoint_path.is_file():
        raise RuntimeError("MeloTTS 中文模型文件不完整；请重新执行 npm run setup:tts-model。")
    return str(config_path), str(checkpoint_path)


def normalize_synthesis_text(text: str) -> str:
    """Limit input to the characters accepted by MeloTTS's Chinese frontend.

    Converted documents frequently contain source URLs, decorative glyphs and
    office-format control characters.  MeloTTS's upstream G2P asserts on some
    of those characters; URLs carry no useful spoken content, so remove them
    and turn other unsupported glyphs into natural pauses.
    """
    value = unicodedata.normalize("NFKC", text)
    value = URL_PATTERN.sub("，", value)
    value = value.translate(str.maketrans({
        "：": ",", "；": ",", "，": ",", "。": ".", "！": "!", "？": "?",
        "、": ",", "·": ",", "—": "-", "–": "-", "…": "…", "\n": ".",
    }))
    value = UNSUPPORTED_TEXT_PATTERN.sub("，", value)
    value = re.sub(r"\s+", " ", value).strip(" ,.-")
    if not value:
        raise ValueError("没有可供朗读的文本内容。")
    return value


def synthesize(request: SynthesisRequest) -> bytes:
    if melo_tts is None:
        raise RuntimeError("MeloTTS model has not loaded")
    speaker_ids = melo_tts.hps.data.spk2id
    if request.voice_id not in speaker_ids:
        raise KeyError(request.voice_id)
    text = normalize_synthesis_text(request.text)
    with inference_lock:
        audio = melo_tts.tts_to_file(
            text,
            speaker_ids[request.voice_id],
            output_path=None,
            speed=request.speed,
            quiet=True,
        )
    buffer = io.BytesIO()
    sf.write(buffer, np.asarray(audio, dtype=np.float32), melo_tts.hps.data.sampling_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global melo_tts
    from melo.api import TTS

    # MeloTTS automatically selects an available accelerator. CPU is explicitly
    # supported by the official API and is the default for this local package.
    config_path, checkpoint_path = local_model_paths()
    melo_tts = TTS(
        language=MODEL_LANGUAGE,
        device=os.environ.get("MELOTTS_DEVICE", "cpu"),
        config_path=config_path,
        ckpt_path=checkpoint_path,
    )
    if LOW_LATENCY_MODE:
        melo_tts.hps.data.disable_bert = True
    yield
    melo_tts = None


app = FastAPI(title="ShengYue MeloTTS", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ready" if melo_tts is not None else "starting",
        "provider": "MeloTTS",
        "model": "MeloTTS-Chinese",
        "accelerator": melo_tts.device if melo_tts is not None else None,
        "low_latency_mode": LOW_LATENCY_MODE,
        "voice_count": len(voices_from_model()),
    }


@app.get("/v1/voices")
def voices() -> dict[str, Any]:
    if melo_tts is None:
        return JSONResponse({"message": "MeloTTS is starting"}, status_code=503)
    return {"provider": "melotts", "model": "MeloTTS-Chinese", "items": voices_from_model()}


@app.post("/v1/synthesize")
def synthesize_wav(request: SynthesisRequest) -> Response:
    try:
        audio = synthesize(request)
    except KeyError:
        raise HTTPException(status_code=422, detail="Unknown MeloTTS voice_id") from None
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except (AssertionError, IndexError, ValueError):
        raise HTTPException(status_code=422, detail="这段文本包含暂不支持的字符，请切换浏览器语音或调整正文后重试。") from None
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"cache-control": "no-store", "x-tts-provider": "MeloTTS", "x-tts-model": "MeloTTS-Chinese"},
    )
