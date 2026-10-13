# ============================================================
# 霜晨月 Docker 镜像（npm workspaces 版）
# 多阶段构建：shared/server/client 编译 → 精简运行时
# 运行时需提供环境变量（JWT_SECRET/SMTP_*/ADMIN_EMAIL 等）
# 或挂载 .env 到 /app/.env
#
# npm workspaces 迁移说明：
# - 根 npm ci 一次安装全部三个 workspace（依赖单一根 lockfile）；
#   子目录内 npm ci 不再适用（npm 不支持在 workspace 内单独 ci）。
# - 运行时只装 shared/server 两个 workspace 的生产依赖
#   （-w shared -w server），client 是纯静态产物不装依赖。
#
# 历史修复保留：
# E4: 非 root（app）运行；依赖先于源码 COPY（缓存友好）。
# E5: shared 的 dist 运行时要 require('zod') 等生产依赖——workspaces 下
#     根 node_modules 统一 hoist，npm ci -w 会为指定 workspace 装齐依赖树。
# ============================================================

# ---------- 构建阶段 ----------
FROM node:24-slim AS build
WORKDIR /app

# 依赖层缓存：只拷清单装依赖（根 lockfile + 三个子包清单），源码变更不失效
# HUSKY=0：容器内无 .git，跳过 prepare 钩子安装（husky 在无 git 目录会报错）
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN HUSKY=0 npm ci --no-audit --no-fund

# 源码层：拷代码并构建 shared → server → client
# ★ shared 的构建必须在 COPY server **之前**（2026-10-11 修复缓存连坐）：
#   COPY server 在前的话，任何 server 源码改动都会使后续的 build shared 层
#   一起失效重建 —— 恰恰违背了本文件"依赖先于源码、缓存友好"的设计（E4）
COPY shared ./shared
RUN npm run build --prefix shared
COPY server ./server
RUN npm run build --prefix server
COPY client ./client
RUN npm run build --prefix client

# 生产依赖树（B2）：在独立目录按 lockfile 精确安装一次，runtime 直接 COPY ——
# 原实现 runtime 阶段再联网 `npm ci --omit=dev`：双倍下载 + 二次 registry 可用性风险。
# 目录布局（三个 package.json + 同一 lockfile）与 /app 完全一致，-w 语义不变。
RUN mkdir -p /tmp/prod/shared /tmp/prod/server /tmp/prod/client \
  && cp package.json package-lock.json /tmp/prod/ \
  && cp shared/package.json /tmp/prod/shared/ \
  && cp server/package.json /tmp/prod/server/ \
  && cp client/package.json /tmp/prod/client/ \
  && cd /tmp/prod && HUSKY=0 npm ci --omit=dev --no-audit --no-fund -w shared -w server

# ---------- 运行时阶段 ----------
FROM node:24-slim
# ffmpeg：视频转码用（缺失时服务端自动降级为原样保留，非强依赖）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# 只拷产物与清单（不需要 dev 依赖/源码）
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
# client/public 必须单独拷贝：/api/music 扫描的是 client/public/music（见 src/config.ts
# 的 PATHS.music），而不是 client/dist/music。此前运行时阶段只拷 client/dist，
# 并且仅 mkdir 了一个空的 client/public/music，导致容器里音乐列表恒为空。
COPY --from=build /app/client/public ./client/public

# 生产依赖树直接来自 build 阶段的预装目录（B2），不再联网安装。
# node_modules/@k/shared 是**相对**符号链接（→ ../shared），落到 /app 后
# 仍解析到真正的 shared 目录（其 dist 在上方 COPY）。
COPY --from=build /tmp/prod/node_modules ./node_modules

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

# 音乐目录用卷挂载：镜像内不含 mp3（client/public/music 在 .gitignore 中），
# 不挂载时 /api/music 返回空列表属预期行为
VOLUME ["/app/server/uploads", "/app/server/uploads_private", "/app/server/books", "/app/client/public/music"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
