"""Download the official multi-speaker CosyVoice model into this project."""

from pathlib import Path

from modelscope import snapshot_download

SERVICE_DIR = Path(__file__).resolve().parent
MODEL_DIR = SERVICE_DIR / "models" / "CosyVoice-300M-SFT"

# `CosyVoice` defaults to Python/PyTorch inference in this project.  The
# ModelScope snapshot also contains optional JIT and TensorRT artefacts, which
# are not loaded by `server.py` and add several gigabytes to an offline bundle.
RUNTIME_FILES = [
    "cosyvoice.yaml",
    "campplus.onnx",
    "speech_tokenizer_v1.onnx",
    "spk2info.pt",
    "llm.pt",
    "flow.pt",
    "hift.pt",
]


if __name__ == "__main__":
    MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        "iic/CosyVoice-300M-SFT",
        local_dir=str(MODEL_DIR),
        allow_patterns=RUNTIME_FILES,
    )
    print(f"CosyVoice model ready: {MODEL_DIR}")
