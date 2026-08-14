# 声阅：智能文档阅读与用户知识库实施方案

## 1. 结论与建设范围

建议采用“同步接入 + 异步处理 + 对象存储 + 用户级知识索引”的架构。前端上传或提交 URL 后立即拿到 `job_id`，通过 SSE 接收实时进度；后台按文件类型进入不同 Worker 池，最终生成结构化 Reader JSON、可导出 H5、原文件下载链接及用户私有知识索引。

本期建设分三个边界：

1. **前端体验层**：导入、处理进度、阅读器、TTS 播放器、导出、私有知识库和 API 契约展示。
2. **内容处理平面**：Crawl4AI、Office/PDF/Markdown 解析、安全清洗、统一文档 AST、H5 渲染。
3. **数据与知识平面**：用户/租户隔离、原文件与产物存储、文本分块、Embedding、向量检索、全文检索和删除级联。

## 2. 目标架构

```mermaid
flowchart LR
    U["Web / H5 客户端"] --> G["API Gateway / BFF"]
    U --> O["S3 / OSS 直传"]
    G --> A["OIDC 身份服务"]
    G --> P["PostgreSQL"]
    G --> R["Redis"]
    G --> Q["RabbitMQ / Kafka"]
    Q --> C["Crawl4AI Worker"]
    Q --> D["Document Worker"]
    Q --> X["Index Worker"]
    C --> O
    D --> O
    C --> H["统一 Document AST + H5 Renderer"]
    D --> H
    H --> O
    H --> X
    X --> V["pgvector / Qdrant"]
    G --> T["TTS Gateway"]
    T --> TP["云 TTS / 私有 TTS 提供方"]
    T --> O
```

### 推荐技术组合

| 分层 | 建议 | 说明 |
|---|---|---|
| Web | React / Next.js + TypeScript | Reader 和播放器作为独立组件，支持桌面和移动端 |
| API | FastAPI + Pydantic | Python 生态与 Crawl4AI/文档解析管线配合好，异步 I/O 完整 |
| 队列 | RabbitMQ + Celery，或 Kafka + 自研 Worker | MVP 优先 RabbitMQ/Celery；若日任务达十万级再转 Kafka |
| 缓存/限流 | Redis Cluster | 幂等键、任务状态、SSE 事件、用户配额、分布式锁 |
| 业务数据 | PostgreSQL 16+ | 文档元数据、任务、产物、音色配置、审计日志；启用 RLS |
| 文件 | S3 / 阿里云 OSS / MinIO | 原文件、中间产物、H5、图片、音频分片 |
| 检索 | PostgreSQL FTS + pgvector | 首期足够；达到千万向量级可换 Qdrant/Milvus |
| 可观测 | OpenTelemetry + Prometheus + Grafana + Loki | 跨 API、队列、Worker、TTS 的 trace_id |

## 3. 内容处理管线

### 3.1 URL

1. API 对 URL 做 scheme、DNS、IP 段和重定向校验，阻断 `localhost`、内网 IP、云 metadata 地址，避免 SSRF。
2. 任务投递给 Crawl4AI Worker，设置域名级并发和全局超时。
3. Crawl4AI 输出 clean markdown / HTML、页面 metadata、图片列表和原始快照。
4. 内容经 DOMPurify/Bleach 白名单清洗，移除脚本、iframe、事件属性和非安全 URL。
5. 转成统一 Document AST，再输出 Reader JSON 与 H5。

### 3.2 文件

| 格式 | 解析路径 |
|---|---|
| DOCX | Mammoth / python-docx 提取结构；复杂版式辅以 LibreOffice -> PDF 对照 |
| DOC | 隔离容器内 LibreOffice headless 先转 DOCX/PDF，严禁宏执行 |
| MD | markdown-it / markdown-it-py，再做 HTML 白名单清洗 |
| XLS/XLSX | openpyxl/xlrd，按 sheet 生成可滚动表格、摘要和分页；限制最大单元格数 |
| PPT/PPTX | LibreOffice 归一化 + python-pptx 提取标题/正文/备注，每页生成预览图 |
| PDF | PyMuPDF/pdfplumber 提取；扫描件进 PaddleOCR；表格可用 Camelot/Table Transformer |

解析后的统一 AST 至少包含：`document -> sections -> blocks`，block 类型为 `heading | paragraph | list | table | image | quote | code | page_break`，并保留 `source_page`、`source_bbox`、`language`和 `alt_text`。

### 3.3 H5 产物

- **在线 H5**：轻量 HTML shell + Reader JSON，TTS 通过 API 流式播放，可对段落做字级/句级高亮。
- **单文件导出**：CSS/Reader JSON 内联，使用 Web Speech API 保留基础 TTS；图片小于阈值时可 base64 内联。
- **完整离线包**：ZIP 包含 `index.html`、assets 和已合成音频，音色在导出前固化。
- 导出记录需记录内容版本和 `content_hash`，原文发生变化时重建产物。

## 4. TTS 设计

1. `GET /v1/tts/voices` 返回可用音色、语言、性别/风格、预览音频和供应商。
2. 播放时以 section/paragraph 为分片单位，提前合成当前片和后两片，降低首包时延。
3. 缓存键：`sha256(text + voice_id + rate + pitch + provider_version)`。
4. API 返回音频分片 URL 与 word/mark timing，前端实现边读边播与语句高亮。
5. 供应商做 adapter，可接 Azure/Google/阿里云/火山/私有模型；上层 API 不感知具体供应商。

## 5. 用户级知识库

### 5.1 隔离规则

- JWT 包含 `tenant_id`、`user_id`、`roles`，服务端从验证后的 token 解析，不接受业务请求传入两个字段。
- PostgreSQL 所有用户数据表包含 `tenant_id` 和 `owner_user_id`，启用 Row Level Security。
- 对象键固定为 `tenants/{tenant_id}/users/{user_id}/documents/{document_id}/...`。
- 向量数据同时携带 tenant/user metadata；检索层强制 filter，只有明确共享的 ACL 才能扩大范围。
- 日志不记录原文、临时下载 URL 和 token；管理员读取用户内容必须有独立审批与审计事件。

### 5.2 核心数据表

- `documents`：来源、所有者、文件 metadata、状态、当前版本。
- `document_versions`：原文 hash、AST 产物、H5 产物、解析器版本。
- `jobs` / `job_events`：处理进度、尝试次数、可重试错误、trace_id。
- `knowledge_chunks`：分块文本、来源页、标题路径、token 数、embedding 版本。
- `artifacts`：原文件、H5、预览图、音频的 object key、MIME、大小、hash。
- `document_acl`：未来支持用户/组共享；MVP 默认只写 owner。

## 6. 200 并发方案

### 并发口径

“200 并发”应验收为 200 个同时在线用户可上传、查状态、阅读和发起 TTS，而不是强制 200 个 CPU 密集型 Office/PDF 转换同时运行。转换使用有界 Worker 池和队列背压，否则会因 LibreOffice/OCR 占满 CPU 和内存而雪崩。

### 初始容量建议

- API Gateway：6 副本，2 vCPU / 4 GB，每副本 80~120 个异步连接。
- Crawl4AI：12~24 并发 context，域名级限制 2，单页 45 秒硬超时。
- Office Worker：8~16 个隔离容器，每容器 1 任务，1~2 vCPU / 2 GB。
- PDF/OCR Worker：CPU 解析 16 并发；OCR 独立 GPU/CPU 队列。
- Index Worker：8~16 并发，Embedding 请求微批处理。
- TTS：账号配额内 40~80 合成任务，对重复文本命中对象存储缓存。
- PostgreSQL：主库 4~8 vCPU，PgBouncer 事务池；Redis 使用哨兵或 Cluster。

### 性能验收线

| 场景 | 目标 |
|---|---|
| 200 VU 提交任务 | P95 < 500 ms，错误率 < 0.5% |
| 200 VU 查询文档/列表 | P95 < 300 ms |
| SSE | 事件端到端延迟 P95 < 1 s，断线可从 `Last-Event-ID` 续传 |
| 100 MB 文件上传 | 数据直传对象存储，API 不中转文件字节 |
| TTS 首包 | 缓存命中 P95 < 300 ms，未命中 P95 < 2 s（受供应商影响） |
| 服务端错误 | 5xx < 0.2%，队列无丢失，重试不产生重复文档 |

使用 k6 做 200 VU 混合场景，比例建议：列表/阅读 50%、状态/SSE 25%、上传会话 10%、URL 任务 10%、TTS 5%。另做 2 倍峰值的 5 分钟突刺和 2 小时稳定性测试。

## 7. 安全与韧性

- 文件限制 200 MB，双重校验扩展名/MIME/magic bytes，先进 ClamAV 扫描再解析。
- Office 解析容器无网络、只读根文件系统、临时目录配额、CPU/内存/时间限制，任务后销毁。
- 上传会话和下载 URL 短时有效；对象存储默认私有并启用服务端加密。
- 所有创建类 API 接受 `Idempotency-Key`，Worker 按 `(tenant_id, idempotency_key)` 去重。
- 失败分为可重试与不可重试；可重试错误指数退避，超限进 DLQ。
- 数据删除为一个 Saga，确保 metadata、对象、向量、搜索索引和 TTS 缓存最终一致。

## 8. 实施阶段

### 阶段 A：可联调 MVP（2~3 周）

- OIDC/JWT、上传直传、URL 导入、任务队列、SSE。
- DOCX/MD/PDF 与 Crawl4AI；统一 AST、Reader JSON、单文件 H5 导出。
- 浏览器 TTS + 一家云 TTS adapter。
- 用户级文档列表、pgvector 检索、删除级联。

### 阶段 B：格式与语音完整化（2~3 周）

- DOC/XLS/XLSX/PPT/PPTX、扫描 PDF OCR、复杂表格。
- 多 TTS 供应商、音频预取、文字高亮、离线 ZIP 包。
- 内容版本、重新处理、管理员任务查看。

### 阶段 C：容量与上线（1~2 周）

- 200 VU 容量测试、自动扩容、故障注入、备份恢复演练。
- WAF、限流、审计报表、告警、SLO 看板、灰度发布和回滚。

## 9. 前后端联调规则

- 契约以 `public/openapi.yaml` 为唯一事实源，合并请求中做 lint 和 breaking-change 检查。
- 前端从 OpenAPI 生成 TypeScript SDK，不手写 request/response 类型。
- 列表分页统一 cursor；时间为 RFC 3339 UTC；ID 为 UUIDv7。
- 错误统一为 RFC 9457 `application/problem+json`，并带 `code`、`trace_id`、`retryable`。
- 开发环境提供 Mock Server 与 8 类格式的固定 fixture，以便前端人员不依赖真实解析服务。

## 10. 本原型的边界

当前仓库中的 UI 是可交互高保真原型：真实支持本地文件选择、格式校验、浏览器音色选择与朗读、单 HTML 导出和原文件回下载。转换进度、资料解析和知识库数据为交互模拟，待后端按 OpenAPI 契约实现后替换。
