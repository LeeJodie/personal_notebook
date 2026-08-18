"""Runtime setup shared by the MeloTTS server and model bootstrap."""

from __future__ import annotations

import os
import re
from pathlib import Path


def prepare_runtime(service_dir: Path) -> None:
    os.environ.setdefault("HF_HOME", str(service_dir / "huggingface-cache"))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(service_dir / "huggingface-cache"))
    os.environ.setdefault("XDG_CACHE_HOME", str(service_dir / "cache"))
    os.environ.setdefault("CACHED_PATH_CACHE_ROOT", str(service_dir / "cache" / "cached-path"))
    os.environ.setdefault("NLTK_DATA", str(service_dir / "cache" / "nltk-data"))

    # The upstream package eagerly imports all language frontends while a TTS
    # instance is created. Those frontends each construct a Hugging Face
    # tokenizer, even though this deployment only offers the Chinese voice and
    # intentionally disables BERT for CPU latency. Supply the minimal tokenizer
    # interface required by the G2P frontends so startup remains fully offline.
    if os.environ.get("MELOTTS_DISABLE_BERT", "1") == "1":
        from transformers import AutoTokenizer

        class _LightweightTokenizer:
            def tokenize(self, text: str) -> list[str]:
                return re.findall(r"[A-Za-z0-9]+|[^\s]", text)

        if not getattr(AutoTokenizer, "_shengyue_low_latency", False):
            AutoTokenizer.from_pretrained = staticmethod(lambda *args, **kwargs: _LightweightTokenizer())
            AutoTokenizer._shengyue_low_latency = True

    # MeloTTS imports every language frontend during package import. Its Japanese
    # frontend instantiates MeCab even for Chinese-only use, whereas the package
    # already depends on the small `unidic_lite` dictionary. Explicitly direct
    # MeCab to that bundled dictionary instead of downloading full UniDic.
    import MeCab
    import unidic_lite

    if not getattr(MeCab, "_shengyue_lite_dictionary", False):
        # mecab-python3 calls this function when each Tagger is constructed.
        # Supplying the lite dictionary here preserves its original Tagger class
        # and argument handling while avoiding the optional full UniDic download.
        MeCab.try_import_unidic = lambda: str(Path(unidic_lite.DICDIR))
        MeCab._shengyue_lite_dictionary = True
