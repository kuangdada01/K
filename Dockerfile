# ============================================================
# 霜晨月 Docker 镜像
# 多阶段构建：shared/server/client 编译 → 精简运行时
# 运行时需提供环境变量（JWT_SECRET/SMTP_*/ADMIN_EMAIL 等）
# 或挂载 .env 到 /app/.env
#
# E4 修复：
# 1. 运行阶段以非 root 用户（app）运行；
# 2. 依赖安装先于源码 COPY（只拷 package*.json 装依赖），
#    源码变更不再使依赖层缓存全部失效；
# 3. 运行阶段只拷 shared 的 dist + package.json（不再携带 dev 依赖）。
# ============================================================

# ---------- 构建阶段 ----------
FROM node:22-slim AS build
WORKDIR /app

# 依赖层缓存：shared/server 无 file: 交叉依赖，先只拷清单装依赖
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/
RUN cd shared && npm ci --no-audit --no-fund
RUN cd server && npm ci --no-audit --no-fund

# 源码层：拷代码并构建 shared → server
COPY shared ./shared
COPY server ./server
RUN cd shared && npm run build
RUN cd server && npm run build

# client 依赖 file:../shared，须在 shared 源码/产物就位后安装
COPY client/package*.json ./client/
RUN cd client && npm ci --no-audit --no-fund
COPY client ./client
RUN cd client && npm run build

# ---------- 运行时阶段 ----------
FROM node:22-slim
# ffmpeg：视频转码用（缺失时服务端自动降级为原样保留，非强依赖）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# 只拷 shared 的产物与清单（运行时 npm ci 会按 file: 依赖装 @k/shared，
# 不需要 shared 下的 dev 依赖/源码）
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/package-lock.json ./server/package-lock.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

RUN cd server && npm ci --omit=dev --no-audit --no-fund

# E4：非 root 运行
# k.db 预建为空文件（不声明 VOLUME）：新版 Docker/containerd 拒绝把卷挂到已存在的
# 文件上（"cannot mount volume over existing file"），文件卷声明会让 docker run 直接 125。
# 不挂载时 DB 落在容器可写层（stop/start 数据保留，删容器才丢）；要持久化用
#   -v <宿主路径>/k.db:/app/server/k.db   （文件挂载）
#   或 -e DB_PATH=/data/k.db -v <宿主目录>:/data   （目录挂载，推荐）
# uploads/uploads_private/books 必须预建目录：镜像内不存在的 VOLUME 路径会被
# Docker 以 root:root 自动创建，非 root 的 app 用户无法写入，上传会静默 500。
RUN useradd -r -m app \
  && touch /app/server/k.db \
  && mkdir -p /app/server/uploads /app/server/uploads_private /app/server/books /app/client/public/music \
  && chown -R app:app /app
USER app

# 持久化数据目录（数据库文件见上方说明，不作为文件卷声明）
VOLUME ["/app/server/uploads", "/app/server/uploads_private", "/app/server/books"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
