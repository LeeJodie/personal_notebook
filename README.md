# 声阅 · 智能文档阅读

可交互的高保真前端原型，用于验证“URL/文件导入 → 异步转换 → H5 阅读/TTS → 下载与分享 → 用户私有知识库”产品流程。

- 产品与架构方案：[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- 前后端联调契约：[`public/openapi.yaml`](public/openapi.yaml)

URL 导入已连接真实服务端抓取，并将 Reader JSON、H5、知识分块与分享记录保存到 D1/R2；抓取失败会明确报错，不会使用内置示例冒充网页内容。Markdown 与 TXT 在 Worker 中直接解析；DOCX、PDF、XLSX 由隔离的 [`services/document_processor`](services/document_processor) 服务解析。生产环境将 Crawl4AI 与 document-processor 作为私有 HTTP 服务绑定，避免上传文件暴露到公网。

## 本地启动

前置条件：Node.js `>=22.13.0`。

```bash
npm ci
npm run dev
```

首次在本机解析 DOCX、PDF、XLSX 时，还需准备解析服务：

```bash
uv venv .venv-document-processor
uv pip install --python .venv-document-processor/bin/python -r services/document_processor/requirements.txt
npm run dev:processor
```

网页链接通过真实 Crawl4AI 服务抓取；首次使用时，在另一个终端准备并启动它：

```bash
npm run setup:crawler
npm run dev:crawler
```

私有 MeloTTS（CPU 低延迟）首次准备并启动：

```bash
npm run setup:tts-model
npm run dev:tts
```

浏览器打开 `http://localhost:3000/`。如果 3000 端口已被占用，终端会显示实际可用地址；用 `Ctrl + C` 停止服务。

验证构建和测试：

```bash
npm run build
npm test
```

## 体验范围

- URL 导入：抓取真实网页正文，持久化生成阅读页、H5、知识分块，支持浏览器 TTS 与下载。
- 文件：Markdown 与 TXT 可在本地直接完成保存、解析、H5 生成和检索；DOCX、PDF、XLSX 在本地先运行 `npm run dev:processor`，再运行 `npm run dev`，即可完成同一链路。导出工具附加的 14 位时间戳会自动从阅读标题中移除。生产环境应配置 document-processor 私有绑定。
- 身份与隔离：主工作台必须注册/登录后才能使用；部署后的访问使用平台提供的 ChatGPT 身份，每个请求都在服务端注入 `tenant_id` 与 `user_id` 条件。本机注册和登录以中国大陆手机号为唯一账号标识，手机号归一化为 `+86` 格式并建立唯一索引；每个手机号获得独立的 user_id、tenant_id、对象存储路径与知识库查询条件。密码使用 PBKDF2 派生后保存、会话使用 HttpOnly cookie，便于验证多用户数据隔离；该机制只用于 localhost，不能用于生产认证。用户显式生成的分享链接保持只读公开访问，以支持转发。
- 分享：资料所有者可生成带有效期与 H5 下载权限的链接，并可立即撤销。链接 token 只存哈希，不会写入数据库明文。
- 检索：默认使用用户隔离的 D1 关键词分块检索；部署 [`services/knowledge_index`](services/knowledge_index) 并配置私有绑定后，自动切换到 FastEmbed + Qdrant 语义召回。
- 私有 TTS：[`services/melotts`](services/melotts) 已接入官方 MeloTTS 中文模型。移动端默认使用 MeloTTS 的“中文自然女声”，暂不展示音色选择；私有服务不可用时自动回退浏览器语音。生产环境通过 `CUSTOMER_HTTP_TTS` 私有绑定接入，浏览器不会直接访问模型服务。

完整的生产数据与权限设计见 [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)，前后端联调以 [`public/openapi.yaml`](public/openapi.yaml) 为准。
