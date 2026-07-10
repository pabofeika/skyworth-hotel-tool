#!/bin/bash
# CloudBase 一键部署脚本
# 执行前请确保已安装: npm i -g @cloudbase/cli

set -e

PROJECT_DIR="/Users/skyworth/ZCodeProject/skyworth-hotel-tool/hotel-templates"
ENV_ID="leon-d8g5sxb3n3c6ba2d7"

echo "🚀 开始部署到 CloudBase 静态托管..."
echo "   环境: $ENV_ID"
echo ""

cd "$PROJECT_DIR"

# 方式1: 直接用 hosting deploy
echo "📤 上传文件..."
tcb hosting deploy ./ -e "$ENV_ID"

echo ""
echo "✅ 部署完成！"
echo "🔗 访问地址: https://leon-d8g5sxb3n3c6ba2d7-1442466300.tcloudbaseapp.com"
echo "🔑 默认密码: hotel2024"
