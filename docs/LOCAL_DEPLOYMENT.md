# 本地部署指南

本仓库可在一台 macOS 或 Linux 主机上以“应用 + Crawl4AI + 文档解析 + 私有 MeloTTS”方式运行。首次部署需要联网下载 Node/Python 依赖、Chromium 与 MeloTTS 中文模型；后续运行不再重复安装。

## 前置条件

- Node.js 22 或更新版本
- Python 3 与 pip
- Git、curl
- 建议至少 8 GB 内存、10 GB 可用磁盘空间

首次执行：

```bash
git clone https://github.com/LeeJodie/personal_notebook.git shengyue-reader
cd shengyue-reader
./deploy.sh
```

`deploy.sh` 会自动安装 `uv`、前端依赖、Crawl4AI/Chromium、DOCX/PDF/XLSX 解析环境，拉取官方 MeloTTS 源码并下载中文模型，最后启动全部服务。

## 日常使用

```bash
./start.sh     # 启动尚未运行的服务
./restart.sh   # 重启由脚本管理的全部服务
```

浏览器访问 `http://localhost:3000`。脚本会将网页服务监听在 `0.0.0.0`，同一局域网中的手机可使用部署机的局域网 IP 加端口访问，例如 `http://192.168.1.20:3000`。不要将 `localhost` 分享给其他设备。

`Crawl4AI`、文档处理器和 `MeloTTS` 只监听 `127.0.0.1`，不会直接暴露到局域网或公网。运行日志位于 `.local/logs/`，例如：

```bash
tail -f .local/logs/tts.log
```

## 可选配置

- 默认使用 CPU 私有 MeloTTS：`MELOTTS_DEVICE=cpu`、`MELOTTS_DISABLE_BERT=1`。阅读页默认选择“本地模式”。
- 用户可手动切换到“联网 EdgeTTS”，该模式会将当次朗读文本发送至 Microsoft Edge 语音服务，以换取更多中文音色；部署机必须可访问公网。
- 有可用 GPU 时可在启动前设置 `MELOTTS_DEVICE=cuda`；请先确认 PyTorch 安装了相应 GPU 支持。
- `restart.sh` 仅停止 `.local/pids/` 中由这些脚本记录的进程，不会影响机器上的其他服务。

首次模型加载或 CPU 机器上的合成可能需要一些时间；服务可用性可通过 `http://127.0.0.1:9876/health` 检查。
