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
from typing import Any, Literal

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
TtsMode = Literal["local", "online"]
EDGE_VOICES = [
    {"id": "zh-CN-XiaoxiaoNeural", "label": "晓晓 · 女声", "language": "zh-CN"},
    {"id": "zh-CN-XiaoyiNeural", "label": "晓伊 · 女声", "language": "zh-CN"},
    {"id": "zh-CN-YunxiNeural", "label": "云希 · 男声", "language": "zh-CN"},
    {"id": "zh-CN-YunjianNeural", "label": "云健 · 男声", "language": "zh-CN"},
]

prepare_runtime(SERVICE_DIR)

melo_tts: Any | None = None
inference_lock = threading.Lock()
URL_PATTERN = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)
UNSUPPORTED_TEXT_PATTERN = re.compile(r"[^\u4e00-\u9fa5A-Za-z0-9\s!?…,.\-']+")
DATE_PATTERN = re.compile(r"(?P<year>\d{4})年(?P<month>\d{1,2})月(?P<day>\d{1,2})日")
SHORT_DATE_PATTERN = re.compile(r"(?<!年)(?P<month>\d{1,2})月(?P<day>\d{1,2})日")
TIME_PATTERN = re.compile(r"(?<!\d)(?P<hour>[01]?\d|2[0-3]):(?P<minute>[0-5]\d)(?!\d)")
MOBILE_PHONE_PATTERN = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
LANDLINE_PHONE_PATTERN = re.compile(r"(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)")
LABELED_LOCAL_PHONE_PATTERN = re.compile(
    r"(?P<label>(?:(?:联系|咨询|报名|值班|服务)?)电话\s*[：:])\s*(?P<number>\d{7,8})(?!\d)"
)
# Segmentation can start directly at a local phone number and lose the label
# from the preceding audio request. A standalone 7–8 digit run is much safer
# read digit-by-digit than as a Mandarin cardinal number.
BARE_LONG_NUMBER_PATTERN = re.compile(r"(?<!\d)\d{7,8}(?!\d)")
VERSION_PATTERN = re.compile(r"(?<!\d)(?P<major>\d+)\.(?P<minor>\d+)(?=(?:版|版本))")
CHINESE_DIGITS = "零一二三四五六七八九"
CHINESE_UNITS = ("", "十", "百", "千")


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice_id: str = Field(min_length=1, max_length=120)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    mode: TtsMode = "local"


def voices_from_model() -> list[dict[str, str]]:
    if melo_tts is None:
        return []
    speaker_ids = getattr(melo_tts.hps.data, "spk2id", {})
    # MeloTTS stores this as its HParams wrapper rather than a normal dict.
    # Iterating that wrapper calls __getitem__ with integers and raises; its
    # public items() API works for both HParams and regular mappings.
    speaker_items = speaker_ids.items() if hasattr(speaker_ids, "items") else []
    return [
        {
            "id": speaker_id,
            "label": "中文自然女声" if speaker_id == "ZH" else f"MeloTTS {speaker_id}",
            "language": "zh-CN",
        }
        for speaker_id, _ in speaker_items
    ]


def edge_rate(speed: float) -> str:
    """Translate the shared 0.5–2.0 playback scale to Edge prosody rate."""
    percent = round((speed - 1) * 100)
    return f"{percent:+d}%"


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


def integer_to_chinese(value: int) -> str:
    """Read a small non-negative integer naturally in Mandarin."""
    if value == 0:
        return CHINESE_DIGITS[0]
    if value > 9_999:
        # Dates use digit-by-digit years and this fallback is deliberately
        # conservative for unrecognised long numbers.
        return "".join(CHINESE_DIGITS[int(digit)] for digit in str(value))
    pieces: list[str] = []
    pending_zero = False
    for index, digit_char in enumerate(str(value)):
        digit = int(digit_char)
        unit_index = len(str(value)) - index - 1
        if digit == 0:
            pending_zero = bool(pieces)
            continue
        if pending_zero:
            pieces.append(CHINESE_DIGITS[0])
            pending_zero = False
        if not (digit == 1 and unit_index == 1 and not pieces):
            pieces.append(CHINESE_DIGITS[digit])
        pieces.append(CHINESE_UNITS[unit_index])
    return "".join(pieces)


def digits_to_chinese(value: str) -> str:
    return "".join(CHINESE_DIGITS[int(digit)] for digit in value)


def normalize_spoken_numbers(text: str) -> str:
    """Turn machine-formatted dates, times and phones into spoken Mandarin.

    MeloTTS correctly synthesizes Chinese characters, but Arabic numeral reading
    is intentionally context-agnostic in its upstream frontend.  Do this before
    synthesis rather than altering the visible source document.
    """
    def replace_date(match: re.Match[str]) -> str:
        return (
            f"{digits_to_chinese(match.group('year'))}年"
            f"{integer_to_chinese(int(match.group('month')))}月"
            f"{integer_to_chinese(int(match.group('day')))}日"
        )

    def replace_short_date(match: re.Match[str]) -> str:
        return (
            f"{integer_to_chinese(int(match.group('month')))}月"
            f"{integer_to_chinese(int(match.group('day')))}日"
        )

    def replace_time(match: re.Match[str]) -> str:
        hour = integer_to_chinese(int(match.group("hour")))
        minute = int(match.group("minute"))
        if minute == 0:
            return f"{hour}点"
        if minute < 10:
            return f"{hour}点零{integer_to_chinese(minute)}分"
        return f"{hour}点{integer_to_chinese(minute)}分"

    def replace_phone(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        # A small pause between area code and local number is clearer than
        # treating it as a regular cardinal number.
        if len(digits) in (10, 11) and digits.startswith("0"):
            area_length = len(digits) - 8
            return f"{digits_to_chinese(digits[:area_length])}，{digits_to_chinese(digits[area_length:])}"
        return "，".join(digits_to_chinese(digits))

    def replace_labeled_local_phone(match: re.Match[str]) -> str:
        # A bare 7–8 digit number is ambiguous in ordinary prose. Treat it as
        # a phone only when the nearby label explicitly establishes the intent.
        return f"{match.group('label')}{digits_to_chinese(match.group('number'))}"

    text = DATE_PATTERN.sub(replace_date, text)
    text = SHORT_DATE_PATTERN.sub(replace_short_date, text)
    text = TIME_PATTERN.sub(replace_time, text)
    text = LABELED_LOCAL_PHONE_PATTERN.sub(replace_labeled_local_phone, text)
    text = MOBILE_PHONE_PATTERN.sub(replace_phone, text)
    text = LANDLINE_PHONE_PATTERN.sub(replace_phone, text)
    text = BARE_LONG_NUMBER_PATTERN.sub(lambda match: digits_to_chinese(match.group(0)), text)
    return VERSION_PATTERN.sub(
        lambda match: f"{integer_to_chinese(int(match.group('major')))}点{digits_to_chinese(match.group('minor'))}",
        text,
    )


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
    value = normalize_spoken_numbers(value)
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


async def synthesize_edge(request: SynthesisRequest) -> bytes:
    if request.voice_id not in {voice["id"] for voice in EDGE_VOICES}:
        raise KeyError(request.voice_id)
    try:
        import edge_tts
    except ImportError as error:
        raise RuntimeError("EdgeTTS 未安装；请重新执行 ./deploy.sh 或安装 edge-tts。") from error
    audio: list[bytes] = []
    communicator = edge_tts.Communicate(
        normalize_synthesis_text(request.text),
        request.voice_id,
        rate=edge_rate(request.speed),
    )
    async for chunk in communicator.stream():
        if chunk.get("type") == "audio":
            audio.append(chunk["data"])
    if not audio:
        raise RuntimeError("EdgeTTS 未返回音频，请检查部署机网络后重试。")
    return b"".join(audio)


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
def voices(mode: TtsMode = "local") -> dict[str, Any]:
    if mode == "online":
        return {"provider": "edge-tts", "model": "Microsoft Edge online TTS", "items": EDGE_VOICES}
    if melo_tts is None:
        return JSONResponse({"message": "MeloTTS is starting"}, status_code=503)
    return {"provider": "melotts", "model": "MeloTTS-Chinese", "items": voices_from_model()}


@app.post("/v1/synthesize")
async def synthesize_audio(request: SynthesisRequest) -> Response:
    try:
        if request.mode == "online":
            audio = await synthesize_edge(request)
            media_type = "audio/mpeg"
            provider = "EdgeTTS"
            model = "Microsoft Edge online TTS"
        else:
            audio = synthesize(request)
            media_type = "audio/wav"
            provider = "MeloTTS"
            model = "MeloTTS-Chinese"
    except KeyError:
        raise HTTPException(status_code=422, detail="Unknown MeloTTS voice_id") from None
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except (AssertionError, IndexError, ValueError):
        raise HTTPException(status_code=422, detail="这段文本包含暂不支持的字符，请切换浏览器语音或调整正文后重试。") from None
    return Response(
        content=audio,
        media_type=media_type,
        headers={"cache-control": "no-store", "x-tts-provider": provider, "x-tts-model": model},
    )
