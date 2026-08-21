# MeloTTS 私有 TTS 服务

该目录将官方 MeloTTS 源码、中文模型缓存和声阅适配层放在同一项目目录内。适配服务仅提供内部接口：`/health`、`/v1/voices` 和 `/v1/synthesize`；浏览器仍只通过应用 Worker 访问。

## 本机准备与启动

```bash
uv venv services/melotts/.venv --python 3.10
uv pip install --python services/melotts/.venv/bin/python -r services/melotts/MeloTTS/requirements.txt
uv pip install --python services/melotts/.venv/bin/python -e services/melotts/MeloTTS --no-deps
npm run setup:tts-model
npm run dev:tts
```

`setup:tts-model` 会将官方中文声学模型下载到 `services/melotts/huggingface-cache`。适配层使用依赖内置的轻量 MeCab 词典，中文部署无需额外下载完整日文词典。默认开启 `MELOTTS_DISABLE_BERT=1` 的 CPU 低延迟模式，以零 BERT 特征换取更低时延；若部署环境已准备好完整 BERT 权重，可设为 `0` 优先发音质量。部署时将缓存目录与服务一同打包；模型服务绑定在 `127.0.0.1:9876`，不对公网暴露。

## 生产部署

MeloTTS 官方项目声明 CPU 可以用于实时推理；本服务仍应以实测的首包与实时因子决定副本数。生产环境通过 `CUSTOMER_HTTP_TTS` 私有 HTTP 绑定接入，并限制每个模型副本的推理并发。构建内含已下载模型的镜像：

```bash
docker build -f services/melotts/Dockerfile -t shengyue-melotts services/melotts
```

## CloudBase 免费环境体验部署

本镜像已适配 CloudBase 云托管：平台注入 `PORT`，服务会监听该端口；本机仍使用 `9876`。

在 CloudBase 上海免费体验环境创建云托管服务时，使用本目录作为构建上下文，选择 `services/melotts/Dockerfile`，并设定：

- 服务名：`shengyue-melotts`
- 监听端口：`8080`
- 规格：先使用最低 CPU 规格；副本范围 `0–1`
- 健康检查路径：`/health`，初始延迟至少 `90` 秒
- 网络：仅开启**内网访问**，不要开启公网访问
- 环境变量：`MELOTTS_DEVICE=cpu`、`MELOTTS_DISABLE_BERT=1`

免费环境的 3000 资源点只适合短时体验。MeloTTS 需加载约 200 MB 模型且 CPU 推理耗时明显；将最小副本设为 `0` 可以避免空闲持续消耗资源，但首次朗读会有冷启动。不能把云托管的内部地址发送给手机，手机只能访问应用生成的 HTTPS 分享链接；应用 API 在校验分享 token 后再从内网调用本服务。
