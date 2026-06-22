#!/bin/bash
# ============================================================
# 创建酒店工具 - 启动器（正式环境）
# 双击此文件即可启动服务并自动打开浏览器
# ============================================================

# 项目根目录
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 实际项目目录
if [ -d "$PROJECT_DIR/create-hotel-tool" ]; then
  PROJECT_DIR="$PROJECT_DIR/create-hotel-tool"
fi

cd "$PROJECT_DIR" || { echo "❌ 找不到项目目录"; exit 1; }

echo "============================================"
echo "  创建酒店工具  v1.0（正式环境）"
echo "============================================"
echo ""
echo "📌 正在启动服务（正式环境: https://cooshare.coocaa.com/hotel, FID=404）..."

# 检查端口 3000
if lsof -ti:3000 &>/dev/null; then
  echo "⚠️  检测到旧进程，正在重启..."
  lsof -ti:3000 | xargs kill -9 2>/dev/null
  sleep 1
fi

# 自动打开浏览器
(sleep 2 && open "http://localhost:3000") &

# 启动服务器（正式环境: FID=404）
HOTEL_URL=https://cooshare.coocaa.com/hotel \
FID=404 \
DEEPSEEK_API_KEY=[REDACTED_API_KEY] \
DEEPSEEK_API_URL=http://[REDACTED_HOST]/v1/chat/completions \
node server.js

echo ""
echo "服务已停止。"
