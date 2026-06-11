FROM node:22-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm install --production

# 复制源码
COPY server.js .
COPY public/ ./public/

# 端口由 CloudBase 环境变量指定
EXPOSE 3000

CMD ["node", "server.js"]
