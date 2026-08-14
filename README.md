# 声阅 · 智能文档阅读

可交互的高保真前端原型，用于验证“URL/文件导入 → 异步转换 → H5 阅读/TTS → 下载与分享 → 用户私有知识库”产品流程。

- 产品与架构方案：[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- 前后端联调契约：[`public/openapi.yaml`](public/openapi.yaml)

原型中的 URL 导入已连接真实服务端抓取，抓取结果会贯穿 Reader、浏览器 TTS、单 HTML 导出和临时分享链接；抓取失败会明确报错，不会使用内置示例冒充网页内容。生产用 Crawl4AI 0.9.2 容器位于 [`services/crawler`](services/crawler)，体验站在尚未绑定容器时使用 Worker 正文提取器。Office/PDF 解析、分享链接持久化与知识库持久化尚待接入。

## 本地启动

前置条件：Node.js `>=22.13.0`。

```bash
npm ci
npm run dev
```

浏览器打开 `http://localhost:3000/`。如果 3000 端口已被占用，终端会显示实际可用地址；用 `Ctrl + C` 停止服务。

验证构建和测试：

```bash
npm run build
npm test
```

## 体验范围

- URL 导入：抓取真实网页正文，支持浏览器 TTS、H5 一键下载。
- 分享：阅读页可生成带有效期的临时链接、复制/系统转发、限制 H5 下载并关闭链接；本地服务重启后临时链接会失效。
- 文件：支持选择与校验格式。服务端 Office/PDF 解析尚未连接，因此不会伪造转换结果。

完整的生产数据与权限设计见 [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)，前后端联调以 [`public/openapi.yaml`](public/openapi.yaml) 为准。
