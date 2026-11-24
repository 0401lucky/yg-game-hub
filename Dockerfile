# 全量开发依赖只用于类型检查和 Vite 多页面构建。
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && node tools/copy-runtime.ts

# 后端由 Node 24 原生剥离类型，仅保留三项生产依赖和运行源码。
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3001

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 再拷业务代码
COPY --from=build /app/backend ./backend
COPY --from=build /app/dist ./dist
COPY --from=build /app/runtime-games ./games

# 运行期数据（账号库、每日统计）：挂卷覆盖，别写进镜像层
VOLUME ["/app/backend/data"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.ts"]
