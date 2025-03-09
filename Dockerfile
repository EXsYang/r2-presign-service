# 使用更具体的基础镜像版本
FROM node:18.19-alpine3.18

# 添加必要的工具和依赖
RUN apk add --no-cache \
    curl \
    wget \
    tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apk del tzdata

# 创建非 root 用户
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 设置工作目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖 (使用 npm install 而不是 npm ci)
RUN npm install --production \
    && npm cache clean --force

# 复制应用文件
COPY presign-service.js .
COPY .env .

# 创建日志目录并设置权限
RUN mkdir -p /app/logs \
    && chown -R appuser:appgroup /app

# 切换到非 root 用户
USER appuser

# 设置环境变量
ENV NODE_ENV=production \
    PORT=3005

# 添加健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:$PORT/health || exit 1

# 暴露端口
EXPOSE $PORT

# 启动命令
CMD ["node", "presign-service.js"]
