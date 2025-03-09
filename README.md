# r2-presign-service-CloudFlareR2 预签名服务

R2 预签名服务是一个专为 Cloudflare R2 对象存储设计的高性能预签名 URL 生成服务。它允许您安全地生成临时 URL 用于上传和下载文件，同时提供完整的访问控制和安全保障。

## 主要功能

- 生成安全的上传和下载预签名 URL
- 支持大文件上传和下载
- 灵活的 CORS 配置
- 健康检查和日志监控
- Docker 容器化部署

## 快速开始

### 使用 Docker Compose 部署

1. 克隆仓库

```bash
git clone https://github.com/yourusername/r2-presign-service.git
cd r2-presign-service
```

2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件填入您的 R2 凭据
```

3. 启动服务

```bash
docker-compose up -d
```

4. 验证服务状态

```bash
curl http://localhost:3005/health
```

## 详细说明

### 技术架构

R2 预签名服务基于 Node.js 和 Express 框架构建，使用 AWS SDK 与 Cloudflare R2 对象存储兼容的 S3 API 进行交互。服务通过生成预签名 URL 实现安全的文件上传和下载功能，无需将 R2 凭据暴露给客户端。

### 配置说明

#### 环境变量

服务通过环境变量进行配置，主要包括以下几类:

##### R2 配置

- `R2_ACCOUNT_ID`: Cloudflare 账户 ID
- `R2_ACCESS_KEY_ID`: R2 访问密钥 ID
- `R2_SECRET_ACCESS_KEY`: R2 访问密钥
- `R2_BUCKET_NAME`: R2 存储桶名称
- `R2_PUBLIC_URL`: 公共访问 URL 前缀，如 https://cdn.example.com/

##### CORS 配置

- `CORS_ORIGINS`: 允许的跨域来源，多个来源使用逗号分隔
- `CORS_METHODS`: 允许的 HTTP 方法，默认为 "GET,POST,PUT,DELETE,OPTIONS"
- `CORS_MAX_AGE`: CORS 预检请求的有效期，单位为秒

##### 上传配置

- `MAX_FILE_SIZE`: 最大允许上传的文件大小，如 "500mb"
- `ALLOWED_FILE_TYPES`: 允许上传的文件类型，多个类型使用逗号分隔
- `CACHE_CONTROL`: 上传文件的缓存控制头

##### 日志配置

- `LOG_LEVEL`: 日志级别，可选值为 "debug", "info", "warn", "error"

### Docker Compose 示例

```yaml
version: '3'

services:
  presign-service:
    build: .
    container_name: r2-presign-service
    restart: always
    ports:
      - "3005:3005"
    environment:
      - NODE_ENV=production
      - PORT=3005
      # R2 配置
      - R2_ACCOUNT_ID=${R2_ACCOUNT_ID}
      - R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
      - R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
      - R2_BUCKET_NAME=${R2_BUCKET_NAME}
      - R2_PUBLIC_URL=${R2_PUBLIC_URL}
      # CORS 配置
      - CORS_ORIGINS=${CORS_ORIGINS}
      - CORS_METHODS=${CORS_METHODS}
      - CORS_MAX_AGE=${CORS_MAX_AGE}
      # 上传配置
      - MAX_FILE_SIZE=${MAX_FILE_SIZE}
      - ALLOWED_FILE_TYPES=${ALLOWED_FILE_TYPES}
      - CACHE_CONTROL=${CACHE_CONTROL}
      # 日志配置
      - LOG_LEVEL=${LOG_LEVEL}
    volumes:
      - /mydata/R2/logs:/app/logs
      - .env:/app/.env:ro
    networks:
      - fiora-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3005/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "5"

networks:
  fiora-network:
    external: true
```

### Docker 运行命令

如果您不使用 Docker Compose，也可以直接使用 Docker 命令启动服务：

```bash
docker run -d --name r2-presign-service \
  --network fiora-network \
  -p 3005:3005 \
  -e PORT=3005 \
  -e R2_ACCOUNT_ID=your_account_id \
  -e R2_ACCESS_KEY_ID=your_access_key \
  -e R2_SECRET_ACCESS_KEY=your_secret_key \
  -e R2_BUCKET_NAME=your_bucket_name \
  -e R2_PUBLIC_URL=https://cdn.example.com/ \
  -e CORS_ORIGINS=https://example.com,http://localhost:3000 \
  -e NODE_ENV=production \
  -e MAX_FILE_SIZE=500mb \
  -v /mydata/R2/logs:/app/logs \
  --restart always \
  --health-cmd "curl -f http://localhost:3005/health || exit 1" \
  --health-interval 30s \
  --health-timeout 10s \
  --health-retries 3 \
  --health-start-period 30s \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  shirous/r2-presign-service:latest
```

## API 说明

### 健康检查

**GET /health**返回服务健康状态。**响应示例:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2025-03-09T13:20:00Z"
}
```

### 生成上传预签名 URL

**POST /api/presign/upload**生成用于上传文件的预签名 URL。**请求参数:**

```json
{
  "fileName": "example.jpg",
  "contentType": "image/jpeg",
  "expiration": 3600
}
```

**响应示例:**

```json
{
  "url": "https://endpoint.r2.cloudflarestorage.com/bucket-name/path/to/file?X-Amz-Algorithm=...",
  "key": "path/to/file",
  "expiration": 3600
}
```

### 生成下载预签名 URL

**GET /api/presign/download?key=path/to/file**生成用于下载文件的预签名 URL。**请求参数:**

- `key`: 存储在 R2 中的文件路径
- `expiration` (可选): URL 有效期，单位为秒，默认为 3600

**响应示例:**

```json
{
  "url": "https://endpoint.r2.cloudflarestorage.com/bucket-name/path/to/file?X-Amz-Algorithm=...",
  "expiration": 3600
}
```

## 安全考虑

### 访问控制

服务使用 Cloudflare R2 的 API 密钥进行认证，这些凭据应该被视为敏感信息，不应暴露在客户端代码中。预签名 URL 允许临时访问特定资源，而无需共享 R2 凭据。

### CORS 设置

为了允许从特定域进行请求，服务支持配置 CORS 规则。请确保 `CORS_ORIGINS` 环境变量只包含您信任的域。

### 文件大小限制

通过 `MAX_FILE_SIZE` 环境变量可以限制上传文件的最大大小，以防止资源滥用。

## 性能优化

### 缓存控制

使用 `CACHE_CONTROL` 环境变量可以设置上传文件的缓存控制头，优化内容分发性能。

### 健康监控

服务内置了健康检查端点，可与 Docker 的健康检查功能集成，实现自动重启不健康的容器。

### 日志管理

服务日志保存在 `/app/logs` 目录中，通过 Docker 卷挂载到主机的 `/mydata/R2/logs` 目录。日志级别可通过 `LOG_LEVEL` 环境变量配置。

## 故障排除

### 常见问题

1. **预签名 URL 无效或过期**
   - 检查服务器与客户端的时钟是否同步
   - 验证预签名 URL 的有效期是否足够长
2. **CORS 错误**
   - 确保 `CORS_ORIGINS` 环境变量包含所有需要访问服务的域
   - 检查请求头是否符合 CORS 要求
3. **上传大文件失败**
   - 检查 `MAX_FILE_SIZE` 设置是否足够大
   - 验证网络连接的稳定性

### 日志查看

```bash
# 查看容器日志
docker logs r2-presign-service

# 查看特定日期的日志文件
cat /mydata/R2/logs/access-YYYY-MM-DD.log
```

## 构建自己的镜像

如果您需要自定义服务，可以构建自己的 Docker 镜像：

```bash
# 克隆仓库
git clone https://github.com/yourusername/r2-presign-service.git
cd r2-presign-service

# 构建镜像
docker build -t yourusername/r2-presign-service:latest .

# 推送到 Docker Hub
docker push yourusername/r2-presign-service:latest
```

## 贡献指南

欢迎通过以下方式为项目做出贡献：

1. 提交 Issue 报告 bug 或提出功能请求
2. 提交 Pull Request 改进代码或文档

请确保提交的代码遵循项目的编码规范，并包含适当的测试。

## 许可证

本项目采用 MIT 许可证。详见 [LICENSE](https://you.com/LICENSE) 文件。

------

有关更多信息，请访问我们的官方文档或联系技术支持。
