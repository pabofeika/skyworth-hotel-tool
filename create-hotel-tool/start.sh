#!/bin/bash
# ============================================================
# 创建酒店工具 - 启动器
# 通过 .env 文件加载配置，不硬编码敏感信息
# ============================================================

# 项目根目录
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 实际项目目录
if [ -d "$PROJECT_DIR/create-hotel-tool" ]; then
  PROJECT_DIR="$PROJECT_DIR/create-hotel-tool"
fi

cd "$PROJECT_DIR" || { echo "❌ 找不到项目目录"; exit 1; }

echo "============================================"
echo "  创建酒店工具  v1.0"
echo "============================================"
echo ""

# 检查 .env 文件是否存在
if [ -f ".env" ]; then
  echo "📌 从 .env 文件加载配置..."
  export $(grep -v '^#' .env | xargs)
else
  echo "⚠️  未找到 .env 文件，使用默认配置"
  echo "   请复制 .env.example 为 .env 并填入真实凭据"
fi

echo "📌 正在启动服务..."

# 检查端口 3000
if lsof -ti:3000 &>/dev/null; then
  echo "⚠️  检测到旧进程，正在重启..."
  lsof -ti:3000 | xargs kill -9 2>/dev/null
  sleep 1
fi

# 自动打开浏览器
(sleep 2 && open "http://localhost:3000") &

# 启动服务器（配置从 .env 读取）
node server.js

echo ""
echo "服务已停止。"
