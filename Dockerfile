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
FROM node:22-slim AS build
WORKDIR /app

# 依赖层缓存：只拷清单装依赖（根 lockfile + 三个子包清单），源码变更不失效
# HUSKY=0：容器内无 .git，跳过 prepare 钩子安装（husky 在无 git 目录会报错）
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN HUSKY=0 npm ci --no-audit --no-fund

# 源码层：拷代码并构建 shared → server → client
COPY shared ./shared
COPY server ./server
RUN npm run build --prefix shared
RUN npm run build --prefix server
COPY client ./client
RUN npm run build --prefix client

# ---------- 运行时阶段 ----------
FROM node:22-slim
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

# 为 shared/server 两个 workspace 装生产依赖（client 是静态产物，不装）
# 运行时阶段 --omit=dev 会裁掉根 devDep（husky），但 npm 仍执行根 prepare 脚本；
# prepare 已改为 "husky || exit 0"，husky 缺失时自动跳过（见根 package.json）
RUN HUSKY=0 npm ci --omit=dev --no-audit --no-fund -w shared -w server

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
