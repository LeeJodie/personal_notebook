# Document processor

隔离的 Python 解析服务，处理 DOCX、MD、TXT、PDF、XLSX，并输出声阅统一 Reader JSON。它不保存原始文件：Worker 从 R2 读取文件流后经私有 HTTP 绑定发送给服务，随后把 Reader JSON、H5 和知识分块持久化回 D1/R2。

本地运行：

```bash
docker build -t shengyue-document-processor .
docker run --rm -p 8765:8080 shengyue-document-processor
```

生产部署时，将服务注册为 Sites 私有 HTTP tunnel，绑定别名为 `document_processor`；Worker 会通过 `CUSTOMER_HTTP_DOCUMENT_PROCESSOR` 调用 `/v1/parse`。服务应运行于无公网出口、只读根文件系统、受 CPU/内存/超时限制的容器中。
