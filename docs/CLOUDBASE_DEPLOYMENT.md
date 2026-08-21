# CloudBase 国内部署迁移说明

## 目标平台

推荐使用腾讯云 CloudBase 上海地域：静态网站托管提供国内 CDN 和 HTTPS，云函数或云托管承接 API，云存储保存原文件与 H5，PostgreSQL/MySQL 保存账户、资料、分享与检索索引。免费体验环境适合联调；正式发布应转为正式套餐并绑定已备案域名。

官方资料：

- [静态网站托管](https://cloud.tencent.com/document/product/876/46900)
- [HTTP 云函数](https://cloud.tencent.com/document/product/876/46899)
- [免费体验与套餐资源](https://cloud.tencent.com/document/product/876/127357)

## 运行服务映射

| 当前组件 | CloudBase 对应服务 | 说明 |
| --- | --- | --- |
| Vite/React 前端 | 静态网站托管 | 站点根路径与 `/share/:token` 均由前端路由接管。 |
| `worker/index.ts` API | HTTP 云函数或云托管 | 需将 Cloudflare Worker Request/D1/R2 适配为 Node HTTP + CloudBase SDK。 |
| D1 | CloudBase PostgreSQL 或 MySQL | 迁移 `documents`、`document_chunks`、`document_shares`、`local_users`、`local_sessions`。 |
| R2 | CloudBase 云存储 | 保留现有 `tenant/user/document` 对象路径规则。 |
| `services/crawler` | 云托管容器 | Crawl4AI 作为内网 HTTP 服务。 |
| `services/document_processor` | 云托管容器 | 文档解析作为内网 HTTP 服务。 |
| `services/melotts` | 云托管容器 | MeloTTS 只在内网开放；API 服务通过服务发现调用。 |

## 发布前必须完成

1. 使用资料所有人的腾讯云账号创建上海地域 CloudBase 环境并完成实名认证。
2. 创建数据库、云存储与云托管服务；生产环境不要使用 ChatGPT Site 的身份头。
3. 接入手机号验证码登录或企业 SSO；服务端从会话解析 `user_id` 与 `tenant_id`。
4. 将三个 Python 服务部署为内网容器，并仅向 API 服务开放。
5. 用 HTTPS 自定义域名发布；中国内地自定义域名需要完成 ICP 备案。
6. 启用对象存储私有读写、分享令牌到期/撤销、TTS 限流和审计日志。

### 免费环境上的 MeloTTS 体验边界

`services/melotts/Dockerfile` 可直接作为 CloudBase 云托管的构建入口，且已遵从平台的 `PORT` 约定。体验环境应仅创建 `0–1` 个 CPU 副本、仅允许内网访问，并将健康检查配置为 `/health` 与不低于 90 秒的启动延迟。

免费环境只有每月 3000 资源点；CloudBase 当前将云托管 CPU 以 `55 点/(核·小时)` 计量，因此一核实例即使不处理请求，连续运行约 54 小时就会消耗完这部分额度。它仅适合部署验证和少量演示朗读，不能承诺持续可用、低首包延迟或 200 并发。正式版本应采用 GPU 或有容量保障的 CPU 副本、音频缓存及队列。

## 当前代码的迁移边界

本仓库现在可直接在本机完成 MeloTTS 与前端联调；但 `worker/` 依赖 Cloudflare 的 D1 和 R2 接口，不能把构建产物直接上传到 CloudBase 后当作生产 API 使用。前端可以先部署到 CloudBase，后端则需按上表完成一次适配迁移后再切流。这样不会把用户文档、分享令牌或私有 TTS 暴露到公网。
