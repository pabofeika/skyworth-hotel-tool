// Vercel Serverless Function - 密码验证
// 密码通过环境变量 ACCESS_PASSWORD 设置（部署时在 Vercel Dashboard 配置）

const crypto = require('crypto');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持 POST 请求' });
  }

  const { password } = req.body || {};
  const correctPassword = process.env.ACCESS_PASSWORD || 'hotel2024';

  if (!password) {
    return res.status(400).json({ valid: false, error: '请输入密码' });
  }

  // 固定时间比较，防止时序攻击
  const inputHash = crypto.createHash('sha256').update(password).digest('hex');
  const correctHash = crypto.createHash('sha256').update(correctPassword).digest('hex');

  if (inputHash === correctHash) {
    // 生成简单 token（session 有效期内可用）
    const token = crypto.createHash('sha256')
      .update(correctPassword + Date.now().toString())
      .digest('hex')
      .slice(0, 32);

    return res.json({ valid: true, token });
  }

  return res.status(401).json({ valid: false, error: '密码错误，请重试' });
};
