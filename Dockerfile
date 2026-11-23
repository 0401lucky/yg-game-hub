# 单阶段即可：本项目前端免构建，运行时只有 express / ws / dotenv 三个依赖
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3001

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
RUN npm ci --omit=dev && npm cache clean --force

# 再拷业务代码
COPY backend ./backend
COPY web ./web
COPY games ./games

# 运行期数据（账号库、每日统计）：挂卷覆盖，别写进镜像层
VOLUME ["/app/backend/data"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.cjs"]
