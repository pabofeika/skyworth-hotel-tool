#!/bin/bash
# ============================================================
# 创建酒店工具 - 启动器
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
echo "  创建酒店工具  v1.0"
echo "============================================"
echo ""
echo "📌 正在启动服务（带 DeepSeek AI 拼音转换）..."

# 检查端口 3000
if lsof -ti:3000 &>/dev/null; then
  echo "⚠️  检测到旧进程，正在重启..."
  lsof -ti:3000 | xargs kill -9 2>/dev/null
  sleep 1
fi

# 自动打开浏览器
(sleep 2 && open "http://localhost:3000") &

# 启动服务器（带 DeepSeek API Key）
DEEPSEEK_API_KEY=[REDACTED_API_KEY] node server.js

echo ""
echo "服务已停止。"
