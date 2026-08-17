# CosyVoice 私有 TTS 服务

该目录将官方 CosyVoice 源码、模型权重和声阅适配层放在同一项目目录内，便于离线打包：

- `CosyVoice/`：从 `QwenAudio/CosyVoice` 克隆的官方源码（本地部署资产，不提交主仓库）。
- `models/CosyVoice-300M-SFT/`：官方 ModelScope 多说话人模型（本地部署资产，不提交主仓库）。
- `modelscope-cache/`：CosyVoice 的官方 wetext 文本规范化资源（本地部署资产，不提交主仓库）。
- `.venv/`：项目内 Python 3.10 运行环境（本地部署资产，不提交主仓库）。
- `server.py`：仅供声阅 Worker 调用的适配服务；提供 `/health`、`/v1/voices` 和 `/v1/synthesize`。

## 默认模型

使用 `iic/CosyVoice-300M-SFT`。它能通过 `list_available_spks()` 输出内置说话人，因此阅读器的音色下拉框可直接显示并切换声音。官方的 Fun-CosyVoice 3 模型适合参考音频驱动的零样本音色克隆；需要用户上传/授权参考音频时，可在此服务中作为第二种模式接入。

## 本机运行

首次准备：

```bash
uv venv services/cosyvoice/.venv --python 3.10
uv pip install --index-strategy unsafe-best-match --no-build-isolation \
  --python services/cosyvoice/.venv/bin/python \
  -r services/cosyvoice/CosyVoice/requirements.txt
npm run setup:tts-model
```

启动私有服务和应用：

```bash
npm run dev:tts
npm run dev
```

服务仅绑定 `127.0.0.1:9876`。阅读器登录后会向 Worker 请求音色；音色下拉框会同时提供浏览器即时语音和 CosyVoice 私有音色，默认使用浏览器语音，用户可随时切换。CPU 本机运行时，300M 模型的生成速度会显著低于实时播放；阅读器会显示“正在生成音频”、用短片段降低首次等待，并允许点击暂停取消。需要连续整篇朗读时请使用 GPU 部署。

## 生产部署

部署为无公网入口的 GPU 服务，并配置 Sites 私有 HTTP 绑定 `CUSTOMER_HTTP_TTS`。Worker 只通过 `http://tts.internal` 访问它，浏览器不会直接接触服务端口。生产环境应使用 NVIDIA GPU、限制单实例并发、设置请求大小与超时，并按 GPU 副本数扩容；Apple 芯片本机模式仅适合功能体验和调试，不适合作为 200 并发的生产节点。

构建含模型的私有镜像：

```bash
docker build -f services/cosyvoice/Dockerfile -t shengyue-cosyvoice services/cosyvoice
```

官方 CosyVoice 仓库与模型遵循其各自的许可证及使用条款；上线前应按企业的模型许可与音色授权流程审查。
