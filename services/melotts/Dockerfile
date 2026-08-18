FROM python:3.10-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/melotts/MeloTTS \
    HF_HOME=/opt/melotts/huggingface-cache \
    TRANSFORMERS_CACHE=/opt/melotts/huggingface-cache \
    XDG_CACHE_HOME=/opt/melotts/cache \
    MELOTTS_DISABLE_BERT=1

RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/melotts
COPY MeloTTS/ /opt/melotts/MeloTTS/
COPY huggingface-cache/ /opt/melotts/huggingface-cache/
COPY cache/ /opt/melotts/cache/
COPY runtime.py /opt/melotts/runtime.py
COPY server.py /opt/melotts/server.py

RUN python -m pip install --no-cache-dir --upgrade 'pip<25' 'setuptools<81' \
    && python -m pip install --no-cache-dir -r MeloTTS/requirements.txt

EXPOSE 9876
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9876"]
