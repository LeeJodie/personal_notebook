FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/cosyvoice/CosyVoice:/opt/cosyvoice/CosyVoice/third_party/Matcha-TTS \
    COSYVOICE_MODEL_DIR=/opt/cosyvoice/models/CosyVoice-300M-SFT \
    MODELSCOPE_CACHE=/opt/cosyvoice/modelscope-cache \
    HF_HOME=/opt/cosyvoice/huggingface-cache

RUN apt-get update && apt-get install -y --no-install-recommends python3.10 python3-pip sox libsox-dev ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/cosyvoice
COPY CosyVoice/ /opt/cosyvoice/CosyVoice/
COPY models/ /opt/cosyvoice/models/
COPY modelscope-cache/ /opt/cosyvoice/modelscope-cache/
COPY server.py /opt/cosyvoice/server.py

RUN python3.10 -m pip install --no-cache-dir --upgrade 'pip<25' 'setuptools<81' \
    && python3.10 -m pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu121 -r CosyVoice/requirements.txt

EXPOSE 9876
CMD ["python3.10", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9876"]
