# Knowledge index

该服务用 FastEmbed 生成中文向量并写入 Qdrant。Worker 只通过私有 HTTP binding 调用它，所有写入与查询均携带并强制过滤 `tenant_id`、`owner_user_id`。

本地环境需要先运行 Qdrant：

```bash
docker run --rm -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant:v1.14.1
docker build -t shengyue-knowledge-index .
docker run --rm -p 8080:8080 -e QDRANT_URL=http://host.docker.internal:6333 shengyue-knowledge-index
```

模型首次启动会下载 `BAAI/bge-small-zh-v1.5`。生产中请将模型缓存预烘焙进镜像或挂载只读缓存，并把服务以 `knowledge_index` 私有 HTTP binding 注册给 Sites。未配置该 binding 时，Worker 自动回退到 D1 的用户隔离关键词检索。
