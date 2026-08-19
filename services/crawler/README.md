# Crawl4AI 抓取服务

该容器是生产环境的真实 URL 抓取器，输出与前端 Reader 相同的结构化 JSON。

对政府政策页，服务优先使用 Crawl4AI 的原始 Markdown，避免精简提取丢失正文后半部分。北京政务页面会将 `#mainText .view` 作为正文根节点；主题分类、发文机构、PDF 等来源信息会通过 `displayMetadata` 返回，供阅读页展示，但不会进入正文段落或 TTS。

```bash
docker build -t shengyue-crawler services/crawler
docker run --rm -p 8080:8080 shengyue-crawler
curl -X POST http://localhost:8080/v1/crawl \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.beijing.gov.cn/"}'
```

部署后将它作为私有 HTTP 服务绑定到站点，绑定名为 `crawler`；站点 Worker 会通过 `CUSTOMER_HTTP_CRAWLER` 调用它。未配置私有绑定时，体验站使用服务端 HTML 正文提取器；两条路径都不允许以内置示例替代抓取结果。
