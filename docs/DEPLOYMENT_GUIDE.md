# 声阅部署与交接指南

本指南面向拿到仓库的第三方开发、运维或演示人员，说明如何在一台 macOS/Linux 主机上部署“声阅”的完整本地私有栈。

部署完成后可使用以下能力：网页（含微信公众号兼容抓取）、DOCX/PDF/XLSX/MD/TXT 导入、H5 阅读页、私有 MeloTTS、联网 EdgeTTS、资料隔离、下载与分享链接。

## 1. 部署模式与边界

当前仓库提供的是**单机一体化部署**：网页应用、Crawl4AI、文档解析器和 MeloTTS 都运行在同一台机器。

| 服务 | 监听地址 | 端口 | 用途 |
| --- | --- | --- | --- |
| Web 应用 | `0.0.0.0` | `3000` | 用户界面与 API |
| Crawl4AI | `127.0.0.1` | `8780` | URL 正文抓取 |
| 文档解析器 | `127.0.0.1` | `8765` | DOCX/PDF/XLSX 解析 |
| MeloTTS | `127.0.0.1` | `9876` | 私有 TTS 合成 |

后三个私有服务不暴露到局域网或公网，浏览器只能通过 Web 应用访问它们。

## 2. 前置条件

- macOS 或 Linux（Windows 建议使用 WSL2）
- Node.js `22.13` 或更高版本
- Python 3、pip
- Git、curl
- 可访问 npm、PyPI、GitHub 与 Hugging Face/模型下载源的网络
- 建议至少 8 GB 内存、10 GB 可用磁盘；首次下载模型和 Chromium 会耗时较长

验证环境：

```bash
node --version
python3 --version
git --version
curl --version
```

## 3. 首次部署

```bash
git clone https://github.com/LeeJodie/personal_notebook.git shengyue-reader
cd shengyue-reader
./deploy.sh
```

`deploy.sh` 会自动完成以下工作：

1. 安装前端依赖；
2. 创建 Python 虚拟环境并安装 Crawl4AI、Chromium；
3. 安装文档解析依赖；
4. 拉取官方 MeloTTS 源码；
5. 下载私有中文模型；
6. 启动所有服务并等待健康检查通过。

完成后访问：

```text
http://localhost:3000
```

首次打开时请注册一个中国大陆手机号账号；不同手机号的数据、原文件、阅读页和知识库记录在服务端按用户隔离。

## 4. 日常启动、重启与验证

```bash
./start.sh       # 启动尚未运行的服务
./restart.sh     # 重启本项目管理的全部服务
npm test         # 构建并运行测试
```

服务健康检查：

```bash
curl http://127.0.0.1:8780/healthz   # Crawl4AI
curl http://127.0.0.1:8765/healthz   # 文档解析器
curl http://127.0.0.1:9876/health    # MeloTTS
```

日志与进程 PID 位于 `.local/`，不纳入 Git：

```bash
tail -f .local/logs/web.log
tail -f .local/logs/crawler.log
tail -f .local/logs/processor.log
tail -f .local/logs/tts.log
```

## 5. 手机与局域网访问

部署机与手机处于同一局域网时，先获取部署机 IP：

```bash
# macOS 示例
ipconfig getifaddr en0

# Linux 示例
hostname -I
```

然后在手机浏览器打开：

```text
http://部署机局域网IP:3000
```

例如 `http://192.168.1.20:3000`。`localhost:3000` 仅代表**当前设备**，不能直接发送给手机或其他人。

分享链接会使用用户访问站点时的域名生成。因此在公网部署场景中，应让用户通过最终 HTTPS 域名进入站点，再生成分享链接。

## 6. 朗读模式

- **本地模式 · MeloTTS**：默认模式，朗读文本不离开部署机；CPU 环境下首段合成和长文连续合成会有计算耗时。
- **联网模式 · EdgeTTS**：用户主动切换后，将当前朗读片段发往 Microsoft Edge 语音服务，获得更多音色；部署机需要可访问公网。

如有 GPU 并已准备对应 PyTorch，可在启动前设置：

```bash
MELOTTS_DEVICE=cuda ./restart.sh
```

默认 CPU 低延迟配置为 `MELOTTS_DEVICE=cpu`、`MELOTTS_DISABLE_BERT=1`。

## 7. 常见问题排查

### 7.1 页面打不开或服务未启动

依次查看 `.local/logs/` 中对应日志，随后运行：

```bash
./restart.sh
```

若 3000 端口冲突，先确认占用程序或调整启动端口；私有服务端口应保持 `8780`、`8765`、`9876` 与应用配置一致。

### 7.2 URL 导入失败

- 确认 crawler 健康检查返回 `{"status":"ok"}`；
- 政府网站和微信公众号会使用站点专用正文提取；
- 如果目标站要求登录、图形验证码或无权限访问，系统会拒绝保存验证页。请改为复制正文到剪贴板导入，或上传已授权文件。

### 7.3 DOCX、PDF、XLSX 上传失败

先确认文档解析服务：

```bash
curl http://127.0.0.1:8765/healthz
tail -f .local/logs/processor.log
```

MD/TXT 由应用直接解析；Markdown 的题目、问答和句末逻辑换行会被保留为独立阅读/TTS 段落。

### 7.4 本地朗读失败

```bash
curl http://127.0.0.1:9876/health
tail -f .local/logs/tts.log
```

模型首次加载会较慢；如机器内存不足，停止其他占用资源的程序后重启服务。也可在阅读页手动切到联网 EdgeTTS。

## 8. 数据、备份与安全

- 运行时日志、PID、Crawl4AI 缓存位于 `.local/`；
- 本地开发数据由应用运行时存储维护，升级或迁移前应先备份该运行目录及部署平台的数据存储；
- 原文件、阅读页、知识分块和分享记录必须保留用户/租户条件，不能绕过 API 直接开放存储桶；
- 公开分享链接是只读的，任何持有链接的人都可访问其对应资料。包含敏感资料时请不要生成分享链接，或在使用后撤销；
- 不要将 `8780`、`8765`、`9876` 直接映射到公网。

## 9. 公网生产部署

本地脚本适用于演示、内网试用和单机交付。正式公网部署还需要：

1. 用 Nginx/Caddy 或云负载均衡为 Web 应用提供 HTTPS；
2. 配置可被手机访问的正式域名；中国内地服务器使用域名通常需要完成 ICP 备案；
3. 使用短信验证码、企业 SSO 或成熟身份系统替换本地演示账号认证；
4. 将数据库、对象存储和备份迁移到受管服务；
5. 将 crawler、processor、MeloTTS 放到内网容器，并增加限流、队列、监控与告警；
6. 根据并发目标配置 TTS 副本和音频缓存，CPU 免费实例不适合承诺 200 并发。

国内 CloudBase 的迁移说明见 [CLOUDBASE_DEPLOYMENT.md](./CLOUDBASE_DEPLOYMENT.md)，产品数据与权限设计见 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。
