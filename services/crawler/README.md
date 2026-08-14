# Crawl4AI 抓取服务

该容器是生产环境的真实 URL 抓取器，输出与前端 Reader 相同的结构化 JSON。

```bash
docker build -t shengyue-crawler services/crawler
docker run --rm -p 8080:8080 shengyue-crawler
curl -X POST http://localhost:8080/v1/crawl \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.beijing.gov.cn/"}'
```

部署后将它作为私有 HTTP 服务绑定到站点，绑定名为 `crawler`；站点 Worker 会通过 `CUSTOMER_HTTP_CRAWLER` 调用它。未配置私有绑定时，体验站使用服务端 HTML 正文提取器；两条路径都不允许以内置示例替代抓取结果。
