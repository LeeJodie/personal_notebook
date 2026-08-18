"""Download and warm the Chinese MeloTTS assets into this project directory."""

from __future__ import annotations

import os
from pathlib import Path

from runtime import prepare_runtime

SERVICE_DIR = Path(__file__).resolve().parent
prepare_runtime(SERVICE_DIR)

from melo.api import TTS  # noqa: E402


def main() -> None:
    import nltk

    nltk_dir = SERVICE_DIR / "cache" / "nltk-data"
    nltk_dir.mkdir(parents=True, exist_ok=True)
    nltk.download("averaged_perceptron_tagger_eng", download_dir=str(nltk_dir), quiet=True)
    nltk.download("cmudict", download_dir=str(nltk_dir), quiet=True)
    tts = TTS(language="ZH", device=os.environ.get("MELOTTS_DEVICE", "cpu"))
    tts.hps.data.disable_bert = os.environ.get("MELOTTS_DISABLE_BERT", "1") == "1"
    speaker_id = next(iter(tts.hps.data.spk2id.values()))
    # A short inference verifies the complete Chinese synthesis path. The
    # default CPU profile uses zero BERT features for low latency; set
    # MELOTTS_DISABLE_BERT=0 when a full BERT model is packaged separately.
    tts.tts_to_file("中文模型预热。", speaker_id, output_path=None, quiet=True)
    print(f"MeloTTS Chinese assets are ready in {SERVICE_DIR}")


if __name__ == "__main__":
    main()
