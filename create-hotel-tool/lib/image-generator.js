/**
 * 酒店图片生成模块
 * 服务端 Canvas 渲染：欢迎图 + Logo
 * 注意：canvas 在 Vercel 可能不可用，每次调用时懒加载
 */

const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const PMS_BG_PATH = path.join(ASSETS_DIR, 'pms-bg.png');
const FONT_PATH = path.join(ASSETS_DIR, 'AlimamaShuHeiTi.ttf');

let _canvas = null;
function getCanvas() {
  if (!_canvas) _canvas = require('canvas');
  return _canvas;
}

// 注册阿里妈妈字体（Logo 用）
try {
  getCanvas().registerFont(FONT_PATH, { family: 'AlimamaLogo' });
} catch (e) {
  console.warn('[image-gen] 字体注册失败，Logo 将使用系统默认字体:', e.message);
}

/** 根据文字换行 */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let cur = '';
  for (const c of text) {
    const test = cur + c;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = c;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 生成欢迎页背景图（酒店名 + 欢迎文字叠加 PMS 背景）
 * @param {string} hotelName - 酒店名称
 * @returns {Promise<Buffer>} PNG Buffer
 */
async function generateWelcomeImage(hotelName) {
  const { createCanvas, loadImage } = getCanvas();
  const bgImg = await loadImage(PMS_BG_PATH);
  const canvas = createCanvas(bgImg.width, bgImg.height);
  const ctx = canvas.getContext('2d');

  // 绘制背景
  ctx.drawImage(bgImg, 0, 0, bgImg.width, bgImg.height);

  const name = hotelName || '酒店';
  const text = `欢迎下榻${name}`.replace(/\{酒店\}/g, name);

  // 样式参数（与前端 hotel-welcome-generator.html 保持一致）
  const fontSize = 26;
  const lineHeight = 40;
  const color = '#ffffff';
  const shadowColor = '#000000';
  const posRatioX = 0.5;   // 50%
  const posRatioY = 0.3;   // 30%
  const maxWidthRatio = 0.9; // 90%

  const mw = maxWidthRatio * canvas.width;
  const cx = canvas.width * posRatioX;
  const cy = canvas.height * posRatioY;

  ctx.font = `normal ${fontSize}px "Source Han Sans","Noto Sans SC","PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  const lines = wrapText(ctx, text, mw);
  const th = lines.length * lineHeight;
  let sy = cy - th / 2 + lineHeight / 2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, sy + i * lineHeight);
  }

  return canvas.toBuffer('image/jpeg', { quality: 0.85 });
}

/**
 * 生成 Logo 图片（透明背景 + 阿里妈妈字体文字）
 * @param {string} hotelName - 酒店名称
 * @returns {Promise<Buffer>} PNG Buffer
 */
async function generateLogoImage(hotelName) {
  const text = hotelName || 'Logo 文字';
  // 超过8个字用50px，否则60px
  const fontSize = text.length > 8 ? 50 : 60;
  const charSpacing = 2;
  const height = 70;

  // 暂存 canvas 测量文字宽度
  const { createCanvas } = getCanvas();
  const measureCanvas = createCanvas(1, 1);
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = `normal ${fontSize}px "AlimamaLogo","Alimama ShuHeiTi",sans-serif`;

  const chars = text.split('');
  let totalWidth = 0;
  chars.forEach((c, i) => {
    if (i > 0) totalWidth += charSpacing;
    totalWidth += measureCtx.measureText(c).width;
  });

  const canvas = createCanvas(totalWidth, height);
  const ctx = canvas.getContext('2d');

  // 透明背景
  ctx.clearRect(0, 0, totalWidth, height);

  // 绘制文字（左对齐）
  ctx.font = `normal ${fontSize}px "AlimamaLogo","Alimama ShuHeiTi",sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  let cx = 0;
  chars.forEach((c) => {
    ctx.fillText(c, cx, height / 2);
    cx += ctx.measureText(c).width + charSpacing;
  });

  return canvas.toBuffer('image/png');
}

module.exports = { generateWelcomeImage, generateLogoImage };
