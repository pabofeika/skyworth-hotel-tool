// ============================================================
// 创建酒店 - 本地自动化工具
// 创维酒店管理系统：自动创建酒店 + 复制模板 + 欢迎词 + 账号
// ============================================================

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { generateWelcomeImage, generateLogoImage } = require('./lib/image-generator');

// ==================== 配置 ====================
const CONFIG = {
  // 酒店管理系统
  hotelUrl: process.env.HOTEL_URL || 'https://cooshare.coocaa.com/hotel',
  fid: parseInt(process.env.FID || '404'),
  loginUsername: process.env.LOGIN_USERNAME || 'n8n',
  loginPassword: process.env.LOGIN_PASSWORD || '5877e26c078d6409fde54d508bf25721',
  sourceHotelId: parseInt(process.env.SOURCE_HOTEL_ID || '214'),

  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || 'sk-b8X8vZ424xsFLpRUlGWQQQ',
  deepseekApiUrl: process.env.DEEPSEEK_API_URL || 'http://139.199.17.11/v1/chat/completions',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',

  // 用户密码哈希
  userPasswordHash: process.env.USER_PASSWORD_HASH || '202cb962ac59075b964b07152d234b70',

  port: parseInt(process.env.PORT || '3000'),

  // 网络请求超时（毫秒）
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),

  // 刷机平台
  huashiUrl: process.env.HUASHI_URL || 'https://skyworth-business.com/huashi-api',
  huashiUsername: process.env.HUASHI_USERNAME || 'chenlingN8N',
  huashiPassword: process.env.HUASHI_PASSWORD || 'chenlingN8N',

  // 输入验证
  maxHotelNameLength: parseInt(process.env.MAX_HOTEL_NAME_LENGTH || '100'),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10'),
};

// ==================== 刷机平台 API ====================

let _huashiToken = null;
let _huashiTokenExpire = 0;

/** 登录刷机平台，获取 token */
async function huashiLogin() {
  if (!CONFIG.huashiUrl) {
    throw new Error('刷机平台 URL 未配置');
  }
  const http = createHttpClient();
  const url = `${CONFIG.huashiUrl}/admin/login`;
  const body = {
    username: CONFIG.huashiUsername,
    password: CONFIG.huashiPassword,
    uuid: '23f99116-60ea-4f15-8508-28d54a1d03b3',
    captcha: '1234',
    loginType: '1',
    phone: '',
  };
  const res = await http.post(url, body, { headers: { 'Content-Type': 'application/json' } });
  if (res.data && res.data.code === 0 && res.data.data && res.data.data.token) {
    _huashiToken = res.data.data.token;
    _huashiTokenExpire = Date.now() + (res.data.data.expire || 43200) * 1000;
    return _huashiToken;
  }
  throw new Error(`刷机平台登录失败: ${JSON.stringify(res.data)}`);
}

/** 确保 token 有效 */
async function ensureHuashiToken() {
  if (!_huashiToken || Date.now() >= _huashiTokenExpire - 60000) {
    return await huashiLogin();
  }
  return _huashiToken;
}

/** 创建门店 */
async function huashiCreateShop(shopName) {
  const token = await ensureHuashiToken();
  const http = createHttpClient();
  const url = `${CONFIG.huashiUrl}/web/huashishop`;
  const res = await http.post(url, { projectShop: shopName, shopUsers: [] }, {
    headers: { 'Content-Type': 'application/json', token },
  });
  if (res.data && res.data.code === 0) {
    return res.data;
  }
  throw new Error(`创建门店失败: ${JSON.stringify(res.data)}`);
}

/** 上传文件：小于10M直接上传，大于10M分片上传，返回 fileKey */
async function huashiUploadFile(fileContent, fileName, token) {
  const http = createHttpClient();
  const buf = Buffer.from(fileContent, 'utf-8');
  const md5 = crypto.createHash('md5').update(fileContent).digest('hex');
  const fileSize = buf.length;

  if (fileSize < 10 * 1024 * 1024) {
    // 小于10M：直接上传（使用 FormData）
    const form = new FormData();
    form.append('file', buf, { filename: fileName, contentType: 'text/plain' });
    form.append('md5Code', md5);

    const res = await http.post(`${CONFIG.huashiUrl}/web/cos/upload`, form, {
      headers: { ...form.getHeaders(), token },
      maxBodyLength: 1024 * 1024,
    });
    if (res.data && res.data.code === 0 && res.data.data) {
      return res.data.data.fileKey;
    }
    throw new Error(`文件上传失败: ${JSON.stringify(res.data)}`);
  }

  // 大于等于10M：分片上传（init → uploadPart → complete）
  const key = crypto.randomUUID();
  const initRes = await http.get(`${CONFIG.huashiUrl}/web/cos/init`, {
    params: { key, _t: Date.now() },
    headers: { token },
  });
  if (!initRes.data || initRes.data.code !== 0) {
    throw new Error(`文件分片上传init失败: ${JSON.stringify(initRes.data)}`);
  }
  const { uploadId } = initRes.data;

  // uploadPart: 用 FormData
  const partForm = new FormData();
  partForm.append('key', key);
  partForm.append('partNumber', '1');
  partForm.append('partSize', String(fileSize));
  partForm.append('uploadId', uploadId);
  partForm.append('file', buf, { filename: fileName, contentType: 'text/plain' });

  await http.post(`${CONFIG.huashiUrl}/web/cos/uploadPart`, partForm, {
    headers: { ...partForm.getHeaders(), token },
    maxBodyLength: 1024 * 1024,
  });

  // complete: 合并
  const completeRes = await http.post(`${CONFIG.huashiUrl}/web/cos/complete`, {
    key, uploadId, fileName,
    md5Code: md5,
    totalSize: String(fileSize),
  }, {
    headers: { 'Content-Type': 'application/json', token },
  });

  if (completeRes.data && completeRes.data.code === 0 && completeRes.data.data) {
    return completeRes.data.data.fileKey;
  }
  throw new Error(`文件分片上传complete失败: ${JSON.stringify(completeRes.data)}`);
}

/** 创建预设配置（含刷机码生成），返回 { configId, flashCode } */
async function huashiCreateConfig(hotelName, pinyinName) {
  if (!CONFIG.huashiUrl) {
    console.log('[huashi] 刷机平台未配置，跳过预设配置创建');
    return null;
  }

  const token = await ensureHuashiToken();
  const http = createHttpClient();

  // 先去查门店列表，找到匹配的门店 ID
  const shopRes = await http.get(`${CONFIG.huashiUrl}/web/huashishop/queryAllStoreAddr`, {
    headers: { token },
  });
  let shopId = null;
  if (shopRes.data && shopRes.data.code === 0 && shopRes.data.data) {
    const match = shopRes.data.data.find(s => s.projectShop === hotelName);
    if (match) shopId = match.id;
  }

  const today = getTodayStr();
  const endDate = new Date(Date.now() + 40 * 86400000);
  const endDateStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} 00:00:00`;

  const loginContent = `IP=193.112.221.196:80/hotel\nROOM_NUM=\nUN=${pinyinName}\nPWD=123`;

  // 上传 login.txt 并获取 fileKey — 失败则抛出异常
  const fileKey = await huashiUploadFile(loginContent, 'login.txt', token);
  console.log(`[huashi] login.txt 上传成功, fileKey: ${fileKey}`);

  const body = {
    activeNumber: null,
    projectCount: 1,
    projectName: hotelName,
    projectShop: shopId || '',
    city: '深圳市',
    county: '宝安区',
    createDate: today,
    updateDate: today,
    outageStartupStatus: '0',
    projectEndDate: endDateStr,
    preFiles: `/system/coocaa_hotel/login.txt`,
    preFileList: [{
      fileKey: fileKey,
      fileName: 'login.txt',
      filePath: '/system/coocaa_hotel/login.txt'
    }],
    configInfo: loginContent,
    commentary: `酒店创建: ${hotelName} (${pinyinName})`,
  };

  const res = await http.post(`${CONFIG.huashiUrl}/web/huashiconfig`, body, {
    headers: { 'Content-Type': 'application/json', token },
  });
  if (res.data && res.data.code === 0 && res.data.data) {
    return res.data.data; // 返回配置数据（包含刷机码）
  }
  throw new Error(`创建预设配置失败: ${JSON.stringify(res.data)}`);
}

// ==================== 工具函数 ====================

/** 获取当前时间的 YYYY-MM-DD HH:mm:ss 格式 */
function getTodayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 用户重命名逻辑：纯字母加1，末尾数字加1
 * abc → abc1,  abc1 → abc2,  abc009 → abc010
 */
function incrementName(str) {
  const match = str.match(/^([a-zA-Z]+)(\d*)$/);
  if (!match) return str + '1';
  const [, letterPart, numPart] = match;
  if (numPart === '') {
    return letterPart + '1';
  } else {
    const num = parseInt(numPart, 10) + 1;
    const numStr = num.toString().padStart(numPart.length, '0');
    return letterPart + numStr;
  }
}

/**
 * 等待指定毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 创建带超时的 axios 实例 */
function createHttpClient() {
  return axios.create({
    timeout: CONFIG.requestTimeout,
    timeoutErrorMessage: `请求超时 (超过${CONFIG.requestTimeout / 1000}秒)`,
    validateStatus: () => true,
  });
}

/** 获取当前主机名（用于日志）*/
function getHostDisplay(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * 验证酒店名称合法性
 * 返回 { valid: boolean, error?: string }
 */
function validateHotelName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: '酒店名称不能为空' };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: '酒店名称不能为空' };
  }
  if (trimmed.length > CONFIG.maxHotelNameLength) {
    return { valid: false, error: `酒店名称不能超过 ${CONFIG.maxHotelNameLength} 个字符` };
  }
  // 只允许中文、英文、数字、空格和常用符号
  if (!/^[\u4e00-\u9fff\w\s\-·.()（）]+$/.test(trimmed)) {
    return { valid: false, error: '酒店名称包含无效字符，仅支持中文、英文、数字和常用符号' };
  }
  return { valid: true, sanitized: trimmed };
}

// ==================== 历史记录 ====================

const HISTORY_FILE = path.join(__dirname, 'history.json');

/** 读取历史记录 */
function readHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('读取历史记录失败:', err.message);
  }
  return [];
}

/** 写入历史记录（Vercel/CloudBase serverless 环境不写入文件系统）*/
function writeHistory(records) {
  if (process.env.VERCEL || process.env.TCB_ENV) return;
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.error('写入历史记录失败:', err.message);
  }
}

/** 添加一条历史记录 */
function addHistoryRecord(data) {
  const records = readHistory();
  const record = {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
    hotelName: data.hotelName,
    hotelId: data.hotelId,
    pinyinName: data.pinyinName,
    finalUsername: data.finalUsername,
    flashCode: data.flashCode || '',
    status: data.status || 'success',
    createdAt: getTodayStr(),
  };
  records.unshift(record); // 最新记录在最前面
  // 最多保留 200 条记录
  if (records.length > 200) {
    records.splice(200);
  }
  writeHistory(records);
  return record;
}

// ==================== 工作流执行器 ====================

class HotelWorkflowExecutor {
  constructor(config) {
    this.config = config;
    this.cookies = {};       // 存储各步骤的cookie
    this.hotelId = null;     // 新建的酒店ID
    this.pinyinName = '';    // 拼音首字母用户名
    this.finalUsername = ''; // 最终创建成功的用户名
    this.flashCode = '';     // 刷机码
    this.eventEmitter = new EventEmitter();
  }

  /** 注册进度监听 */
  onProgress(callback) {
    this.eventEmitter.on('progress', callback);
  }

  /** 发送进度 */
  _progress(step, message, data = null) {
    this.eventEmitter.emit('progress', { step, message, data, timestamp: new Date().toISOString() });
  }

  /** 执行完整工作流 */
  async run(hotelName) {
    // 输入校验
    const validation = validateHotelName(hotelName);
    if (!validation.valid) {
      this._progress('error', `❌ 输入校验失败: ${validation.error}`);
      return { success: false, error: validation.error };
    }
    hotelName = validation.sanitized;

    const startTime = Date.now();
    this._progress('start', `开始创建酒店: ${hotelName}`);

    try {
      // Step 1: 环境配置
      await this.stepEnv();

      // Step 2: 登录酒店管理系统
      await this.stepLogin();

      // Step 3: 新增酒店
      await this.stepCreateHotel(hotelName);

      // Step 4: 切换酒店
      await this.stepSwitchHotel();

      // Step 5: 复制模板
      await this.stepCopyTemplate();

	      // Step 6: 更新欢迎词
	      await this.stepUpdateWelcome(hotelName);

	      // Step 6a: 生成欢迎图 + 上传
	      await this.stepWelcomeImage(hotelName);

	      // Step 6b: 生成Logo图 + 上传
	      await this.stepLogoImage(hotelName);

	      // Step 7: 中文转拼音首字母
	      await this.stepConvertPinyin(hotelName);

	      // Step 8: 创建用户（失败则重命名重试）
      await this.stepCreateUser();

      // Step 9: 创建刷机平台预设配置（可选，不影响主流程）
      await this.stepHuashiConfig(hotelName);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this._progress('done', `✅ 全部完成！耗时 ${elapsed} 秒`, {
        hotelName,
        hotelId: this.hotelId,
        pinyinName: this.pinyinName,
        finalUsername: this.finalUsername,
        flashCode: this.flashCode,
      });

      return {
        success: true,
        hotelName,
        hotelId: this.hotelId,
        pinyinName: this.pinyinName,
        finalUsername: this.finalUsername,
        flashCode: this.flashCode,
      };
    } catch (err) {
      this._progress('error', `❌ 失败: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Step 1: 环境配置 */
  async stepEnv() {
    this._progress('env', `环境初始化: URL=${this.config.hotelUrl}, FID=${this.config.fid}`);
    this._progress('env', `今日日期: ${getTodayStr()}`);
  }

  /** Step 2: 登录酒店 */
  async stepLogin() {
    this._progress('login', '正在登录酒店管理系统...');
    this._progress('login', `账号: ${this.config.loginUsername}`);

    const http = createHttpClient();
    const url = `${this.config.hotelUrl}/v3/web/login/in`;
    const body = {
      name: this.config.loginUsername,
      pswd: this.config.loginPassword,
    };

    this._progress('login', `正在连接 ${getHostDisplay(url)} ...`);
    const res = await http.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      responseType: 'json',
    });

    // 提取 cookie
    const setCookie = res.headers['set-cookie'];
    if (setCookie && setCookie.length > 0) {
      this.cookies.login = setCookie[0];
      this._progress('login', '登录成功，已获取会话Cookie');
    } else {
      throw new Error(`登录失败: 未获取到Cookie (status=${res.status})`);
    }

    // 验证登录结果
    if (res.data && res.data.code === 10000) {
      this._progress('login', `登录响应: code=${res.data.code}, message=${res.data.message || 'ok'}`);
    } else {
      this._progress('login', `⚠️ 登录返回异常: ${JSON.stringify(res.data)}`);
    }
  }

  /** Step 3: 新增酒店 */
  async stepCreateHotel(hotelName) {
    this._progress('create_hotel', `正在创建酒店: ${hotelName}`);

    const http = createHttpClient();
    const url = `${this.config.hotelUrl}/v3/web/hotel/AddHotel`;
    const body = {
      fid: this.config.fid,
      name: hotelName,
      addr: '酒店地址',
      phone: '电话号码',
      desc: '酒店描述',
      en: 1,
    };

    const res = await http.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        cookie: this.cookies.login,
      },
    });

    if (res.data && res.data.code === 10000 && res.data.obj && res.data.obj.HotelId) {
      this.hotelId = res.data.obj.HotelId;
      this._progress('create_hotel', `✅ 酒店创建成功！ID: ${this.hotelId}`);
    } else {
      throw new Error(`创建酒店失败: ${JSON.stringify(res.data)}`);
    }
  }

  /** Step 4: 切换酒店 */
  async stepSwitchHotel() {
    this._progress('switch_hotel', `正在切换到新酒店(ID: ${this.hotelId})...`);

    const http = createHttpClient();
    const url = `${this.config.hotelUrl}/v3/web/login/env/sw_htl`;
    const body = { hid: this.hotelId };

    const res = await http.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookies.login,
      },
      responseType: 'json',
    });

    const setCookie = res.headers['set-cookie'];
    if (setCookie && setCookie.length > 0) {
      this.cookies.switch = setCookie[0];
      this._progress('switch_hotel', '切换成功，已获取新酒店上下文Cookie');
    } else {
      throw new Error(`切换酒店失败: 未获取到新Cookie`);
    }
  }

  /** Step 5: 复制模板（从源酒店复制样式） */
  async stepCopyTemplate() {
    const sourceId = this.config.sourceHotelId;
    this._progress('copy_template', `正在从酒店 ${sourceId} 复制样式模板...`);

    const http = createHttpClient();
    const url = `${this.config.hotelUrl}/v3/web/push/copyStyle`;
    const body = {
      targetHotelId: this.hotelId,
      sourceHotelId: sourceId,
    };

    const res = await http.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookies.switch,
      },
    });

    this._progress('copy_template', `模板复制结果: ${JSON.stringify(res.data)}`);
  }

	  /** Step 6: 更新欢迎词 + 上传欢迎图/Logo */
	  async stepUpdateWelcome(hotelName) {
	    this._progress('welcome_msg', '正在更新欢迎词并上传图片...');

	    // 预生成图片
	    let welcomeBuf = null, logoBuf = null;
	    const welcomeKey = `welcome_${Date.now()}`;
	    const logoKey = `logo_${Date.now()}`;
	    try { welcomeBuf = await generateWelcomeImage(hotelName); } catch (e) {}
	    try { logoBuf = await generateLogoImage(hotelName); } catch (e) {}

	    const url = `${this.config.hotelUrl}/v3/web/push/style`;

	    // changed_components 格式（对齐录制的真实请求）
	    const changedComponents = [
	      // 欢迎词（文本）
	      {
	        path: '欢迎页 / 欢迎词',
	        name: 'WELCOME_TEXT',
	        push_mode: 0, onOrOff: 1,
	        component_infos: [
	          { type: 4, value: `欢迎下榻${hotelName}` },
	          { type: 0, value: '1' },
	        ],
	      },
	      // 语音播报（文本）
	      {
	        path: '欢迎页 / 语音播报',
	        name: 'WELCOME_VOICE_BROADCAST',
	        push_mode: 0, onOrOff: 1,
	        component_infos: [{
	          type: 4,
	          value: `欢迎下榻${hotelName}，我是您的AI客房管家小维。\n无论是调节空调温度、点亮温馨灯光，还是轻启窗帘迎接晨光，您只需轻声唤我："小维小维，打开空调"或"小维小维，打开灯光"，祝您入住愉快！`,
	        }],
	      },
	    ];

	    // 欢迎页背景图
	    if (welcomeBuf) {
	      changedComponents.push({
	        path: '欢迎页 / 欢迎页背景',
	        name: 'WELCOME_BG_IMAGE',
	        push_mode: 0, onOrOff: 1,
	        component_infos: [{ type: 1, key: welcomeKey }],
	      });
	    }

	    // 主页 Logo（含 PMS 背景信息）
	    if (logoBuf) {
	      changedComponents.push({
	        path: '主页 / 主页LOGO',
	        name: 'HOME_LOGO',
	        push_mode: 0, onOrOff: 1,
	        component_infos: [{ type: 1, key: logoKey }],
	      });
	    }

	    const styleData = {
	      style_name: '创维标准样式（语音版）',
	      push_name: '1',
	      plan_detail: { plan_type: 0 },
	      goals: [
	        { hid: this.hotelId, room_nums: ['000'] },
	        { hid: this.hotelId, room_nums: ['----'] },
	      ],
	      root: {
	        name: 'ROOT',
	        title: '标准版',
	        changed_components: changedComponents,
	      },
	    };

	    const http = createHttpClient();
	    const form = new FormData();
	    form.append('paras', JSON.stringify(styleData));
	    if (welcomeBuf) form.append('files', welcomeBuf, { filename: `${welcomeKey}.jpg`, contentType: 'image/jpeg' });
	    if (logoBuf) form.append('files', logoBuf, { filename: `${logoKey}.png`, contentType: 'image/png' });

	    const res = await http.post(url, form, {
	      headers: { ...form.getHeaders(), Cookie: this.cookies.switch },
	    });

	    this._progress('welcome_msg', `推送结果: ${JSON.stringify(res.data)}`);
	    if (res.data?.code === 10000) {
	      if (welcomeBuf) this._progress('welcome_img', '🖼️ 欢迎图上传成功 ✅');
	      if (logoBuf) this._progress('logo_img', '✨ Logo上传成功 ✅');
	    } else {
	      if (welcomeBuf) this._progress('welcome_img', `⚠️ 欢迎图上传失败: ${res.data?.msg}`);
	      if (logoBuf) this._progress('logo_img', `⚠️ Logo上传失败: ${res.data?.msg}`);
	    }
	  }

	  /** Step 6a: 保存欢迎图到本地供下载（上传已在上一步完成） */
	  async stepWelcomeImage(hotelName) {
	    try {
	      const imgBuffer = await generateWelcomeImage(hotelName);
	      const filename = `welcome_${Date.now()}.jpeg`;
	      const tmpDir = process.env.VERCEL || process.env.TCB_ENV ? '/tmp' : path.join(__dirname, 'public');
	      fs.writeFileSync(path.join(tmpDir, filename), imgBuffer);
	      this._progress('welcome_img', `🖼️ 欢迎图已保存 (${(imgBuffer.length/1024).toFixed(0)}KB) → /api/images/${filename}`);
	    } catch (err) {
	      this._progress('welcome_img', `⚠️ 欢迎图保存失败: ${err.message}`);
	    }
	  }

	  /** Step 6b: 保存Logo到本地供下载（上传已在上一步完成） */
	  async stepLogoImage(hotelName) {
	    try {
	      const imgBuffer = await generateLogoImage(hotelName);
	      const filename = `logo_${Date.now()}.png`;
	      const tmpDir = process.env.VERCEL || process.env.TCB_ENV ? '/tmp' : path.join(__dirname, 'public');
	      fs.writeFileSync(path.join(tmpDir, filename), imgBuffer);
	      this._progress('logo_img', `✨ Logo已保存 (${(imgBuffer.length/1024).toFixed(0)}KB) → /api/images/${filename}`);
	    } catch (err) {
	      this._progress('logo_img', `⚠️ Logo保存失败: ${err.message}`);
	    }
	  }

	  /** Step 7: 中文转拼音首字母（DeepSeek API） */
  async stepConvertPinyin(hotelName) {
    this._progress('pinyin', `正在将"${hotelName}"转换为拼音首字母...`);

    const apiKey = this.config.deepseekApiKey;
    if (!apiKey) {
      // 如果没有配置DeepSeek API key，使用内置的拼音转写
      this._progress('pinyin', '⚠️ 未配置DeepSeek API Key，使用内置拼音转换');
      this.pinyinName = this.localPinyinConvert(hotelName);
      this._progress('pinyin', `拼音首字母: ${this.pinyinName}`);
      return;
    }

    try {
      const http = createHttpClient();
      const res = await http.post(
        this.config.deepseekApiUrl,
        {
          model: this.config.deepseekModel,
          messages: [
            {
              role: 'system',
              content:
                '你是一个中文转拼音首字母的专用工具，执行以下转换规则：\n1、接收输入的中文文本；\n2、提取每个汉字拼音的首字母，并转为大写形式；\n3、最终输出仅保留字母，剔除空格、标点、数字等所有非字母内容。',
            },
            { role: 'user', content: hotelName },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      if (res.data && res.data.choices && res.data.choices.length > 0) {
        this.pinyinName = res.data.choices[0].message.content.trim();
        this._progress('pinyin', `DeepSeek 转换结果: ${this.pinyinName}`);
      } else {
        throw new Error(`DeepSeek 返回异常: ${JSON.stringify(res.data)}`);
      }
    } catch (err) {
      this._progress('pinyin', `⚠️ DeepSeek API 调用失败: ${err.message}，使用本地转换`);
      this.pinyinName = this.localPinyinConvert(hotelName);
      this._progress('pinyin', `拼音首字母（本地）: ${this.pinyinName}`);
    }
  }

  /** 本地拼音转换（覆盖常用汉字，备选方案） */
  localPinyinConvert(chinese) {
    let result = '';
    for (const char of chinese) {
      // 跳过空格、标点
      if (/[\s\p{P}]/u.test(char)) continue;
      // 如果已经是英文字母，保留
      if (/[a-zA-Z]/.test(char)) {
        result += char.toUpperCase();
        continue;
      }
      // 数字跳过
      if (/[0-9]/.test(char)) continue;
      // 查拼音映射表
      result += PINYIN_MAP[char] || '';
    }
    return result || 'HTL'; // 如果全部无法识别，返回默认值
  }

  /** Step 8: 创建用户（失败则重命名重试） */
  async stepCreateUser() {
    let currentName = this.pinyinName;
    let maxRetries = 20;

    this._progress('create_user', `开始创建酒店用户，初始用户名: ${currentName}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this._progress('create_user', `尝试 #${attempt}: 创建用户 "${currentName}"...`);

      const http = createHttpClient();
      const url = `${this.config.hotelUrl}/v3/web/user/user`;

      const userData = {
        hid: this.hotelId,
        user_name: currentName,
        password: this.config.userPasswordHash,
        user_phone: '1',
        id_number: '1',
        id_type: 0,
        user_type: 1,
        desc: '1',
        enable: 1,
        fp: JSON.stringify({
          version: 1,
          grants: {
            media: 0, live: 0, vod: 0, iptvLive: 0, channelClone: 0,
            dining: 0, hotel: 0, branch: 0, group: 0, room: 0,
            appManage: 0, styleManage: 0, pushManage: 0, styleSelect: 0,
            resourcePush: 0, pushRecord: 0, userManageTop: 0, personalCenter: 0,
            userManage: 0, checkinTop: 0, roomManage: 0, checkinManage: 0,
            guestManage: 0, msgManage: 0, otherTop: 0, serviceManage: 0,
            systemStatus: 0, subsystem: 0, microService: 0, chainManage: 0,
            hotelInfo: 0, otherSetting: 0, stolenOrder: 0, pushQuick: 0,
            qnaCustom: 0, pushQuickTitle: 0, musicManage: 0, appWhitelist: 0,
          },
          scopes: {},
          meta: {},
        }),
        key: 'blob',
      };

      const form = new FormData();
      form.append('paras', JSON.stringify(userData));

      const res = await http.post(url, form, {
        headers: {
          ...form.getHeaders(),
          Cookie: this.cookies.switch,
        },
      });

      const code = res.data && res.data.code;

      if (code === 10000) {
        this.finalUsername = currentName;
        this._progress('create_user', `✅ 用户 "${currentName}" 创建成功！`);
        return;
      } else {
        this._progress('create_user', `用户已存在 (code=${code})，重命名为下一个...`);
        currentName = incrementName(currentName);
        await sleep(200); // 稍微延迟避免请求过快
      }
    }

    throw new Error(`创建用户失败: 尝试 ${maxRetries} 次后仍未成功`);
  }

  /** Step 9: 创建刷机平台预设配置 */
  async stepHuashiConfig(hotelName) {
    if (!CONFIG.huashiUrl) {
      this._progress('huashi_config', '刷机平台未配置，跳过预设配置创建');
      return;
    }
    this._progress('huashi_config', '正在创建刷机平台预设配置...');
    try {
      const result = await huashiCreateConfig(hotelName, this.pinyinName);
      // 尝试提取刷机码
      if (result) {
        this.flashCode = result.activeNumber || result.flashCode || '';
        this._progress('huashi_config', `✅ 预设配置创建成功，刷机码: ${this.flashCode || '无'}`);
      }
    } catch (err) {
      // 刷机平台失败不阻塞主流程
      this._progress('huashi_config', `⚠️ 预设配置创建失败: ${err.message}`);
    }
  }
}

// ==================== 拼音映射表 ====================
// 覆盖常用汉字 → 拼音首字母，本地备用方案
const PINYIN_MAP = {
  '啊':'A','阿':'A','爱':'A','安':'A','暗':'A','奥':'A',
  '八':'B','把':'B','白':'B','百':'B','半':'B','办':'B','包':'B','保':'B','报':'B',
  '北':'B','被':'B','本':'B','比':'B','必':'B','边':'B','变':'B','标':'B','别':'B',
  '宾':'B','冰':'B','波':'B','博':'B','不':'B','部':'B',
  '才':'C','财':'C','餐':'C','藏':'C','草':'C','测':'C','层':'C','查':'C','产':'C',
  '长':'C','场':'C','超':'C','车':'C','成':'C','城':'C','吃':'C','出':'C','初':'C',
  '处':'C','传':'C','窗':'C','创':'C','春':'C','此':'C','次':'C','从':'C','村':'C',
  '大':'D','代':'D','单':'D','但':'D','当':'D','导':'D','到':'D','道':'D','得':'D',
  '灯':'D','等':'D','地':'D','第':'D','点':'D','电':'D','店':'D','定':'D','东':'D',
  '动':'D','都':'D','读':'D','度':'D','对':'D','多':'D',
  '儿':'E','二':'E',
  '发':'F','法':'F','饭':'F','方':'F','房':'F','放':'F','飞':'F','分':'F','风':'F',
  '服':'F','福':'F','府':'F','富':'F','副':'F',
  '该':'G','改':'G','干':'G','感':'G','刚':'G','高':'G','告':'G','格':'G','个':'G',
  '各':'G','给':'G','根':'G','更':'G','工':'G','公':'G','功':'G','共':'G','关':'G',
  '观':'G','管':'G','光':'G','广':'G','规':'G','国':'G','果':'G','过':'G',
  '还':'H','海':'H','好':'H','号':'H','合':'H','和':'H','河':'H','很':'H','红':'H',
  '后':'H','花':'H','华':'H','化':'H','画':'H','话':'H','欢':'H','环':'H','换':'H',
  '黄':'H','回':'H','会':'H','活':'H','火':'H','或':'H',
  '机':'J','基':'J','及':'J','级':'J','即':'J','集':'J','几':'J','计':'J','记':'J',
  '技':'J','际':'J','济':'J','加':'J','家':'J','间':'J','检':'J','建':'J','健':'J',
  '将':'J','江':'J','讲':'J','交':'J','教':'J','接':'J','街':'J','节':'J','结':'J',
  '解':'J','介':'J','界':'J','今':'J','金':'J','进':'J','近':'J','京':'J','经':'J',
  '精':'J','景':'J','九':'J','久':'J','酒':'J','就':'J','居':'J','局':'J','举':'J',
  '具':'J','据':'J','决':'J','军':'J',
  '开':'K','看':'K','康':'K','科':'K','可':'K','客':'K','课':'K','空':'K','控':'K',
  '口':'K','快':'K',
  '来':'L','蓝':'L','老':'L','乐':'L','了':'L','类':'L','里':'L','理':'L','力':'L',
  '立':'L','利':'L','例':'L','连':'L','联':'L','练':'L','量':'L','料':'L','林':'L',
  '零':'L','领':'L','流':'L','六':'L','龙':'L','楼':'L','路':'L','旅':'L','绿':'L',
  '论':'L',
  '马':'M','买':'M','满':'M','毛':'M','贸':'M','没':'M','美':'M','门':'M','们':'M',
  '米':'M','面':'M','民':'M','名':'M','明':'M','命':'M','模':'M','目':'M',
  '那':'N','南':'N','难':'N','内':'N','能':'N','你':'N','年':'N','牛':'N','农':'N',
  '女':'N',
  '欧':'O',
  '拍':'P','排':'P','盘':'P','旁':'P','跑':'P','配':'P','批':'P','片':'P','品':'P',
  '平':'P','评':'P','破':'P',
  '七':'Q','期':'Q','其':'Q','奇':'Q','企':'Q','起':'Q','气':'Q','汽':'Q','前':'Q',
  '钱':'Q','强':'Q','切':'Q','且':'Q','亲':'Q','青':'Q','清':'Q','情':'Q','请':'Q',
  '庆':'Q','求':'Q','区':'Q','去':'Q','全':'Q','确':'Q','群':'Q',
  '然':'R','让':'R','热':'R','人':'R','认':'R','任':'R','日':'R','容':'R','如':'R',
  '入':'R',
  '三':'S','色':'S','沙':'S','山':'S','商':'S','上':'S','少':'S','设':'S','社':'S',
  '身':'S','深':'S','神':'S','生':'S','声':'S','省':'S','十':'S','时':'S','实':'S',
  '食':'S','使':'S','始':'S','世':'S','市':'S','示':'S','事':'S','是':'S','收':'S',
  '手':'S','首':'S','书':'S','数':'S','水':'S','说':'S','司':'S','四':'S','苏':'S',
  '速':'S','宿':'S','算':'S','所':'S',
  '他':'T','它':'T','台':'T','太':'T','堂':'T','特':'T','提':'T','题':'T','体':'T',
  '天':'T','条':'T','铁':'T','通':'T','同':'T','头':'T','图':'T','团':'T',
  '外':'W','完':'W','万':'W','王':'W','网':'W','往':'W','为':'W','维':'W','位':'W',
  '文':'W','问':'W','我':'W','无':'W','五':'W','物':'W',
  '西':'X','希':'X','习':'X','系':'X','下':'X','先':'X','现':'X','线':'X','限':'X',
  '乡':'X','相':'X','香':'X','想':'X','向':'X','象':'X','小':'X','校':'X','新':'X',
  '心':'X','信':'X','星':'X','行':'X','形':'X','性':'X','修':'X','需':'X','许':'X',
  '学':'X','讯':'X',
  '压':'Y','亚':'Y','言':'Y','研':'Y','眼':'Y','阳':'Y','样':'Y','要':'Y','业':'Y',
  '一':'Y','衣':'Y','医':'Y','已':'Y','以':'Y','义':'Y','议':'Y','因':'Y','银':'Y',
  '应':'Y','影':'Y','用':'Y','优':'Y','由':'Y','有':'Y','又':'Y','于':'Y','与':'Y',
  '语':'Y','育':'Y','元':'Y','园':'Y','原':'Y','远':'Y','院':'Y','约':'Y','月':'Y',
  '越':'Y','云':'Y','运':'Y',
  '在':'Z','再':'Z','展':'Z','站':'Z','张':'Z','招':'Z','找':'Z','照':'Z','者':'Z',
  '这':'Z','真':'Z','正':'Z','政':'Z','之':'Z','支':'Z','知':'Z','直':'Z','指':'Z',
  '至':'Z','制':'Z','质':'Z','治':'Z','中':'Z','种':'Z','重':'Z','州':'Z','周':'Z',
  '主':'Z','住':'Z','注':'Z','转':'Z','装':'Z','准':'Z','资':'Z','子':'Z','自':'Z',
  '总':'Z','走':'Z','组':'Z','最':'Z','作':'Z','坐':'Z','做':'Z',
  // 酒店行业常用补充
  '宾':'B','馆':'G','厅':'T','苑':'Y','阁':'G','轩':'X','庭':'T','居':'J',
  '舍':'S','墅':'S','寓':'Y','栈':'Z','驿':'Y','庄':'Z','园':'Y','湾':'W',
  '湖':'H','泉':'Q','柏':'B','竹':'Z','兰':'L','锦':'J','瑞':'R','豪':'H',
  '悦':'Y','逸':'Y','雅':'Y','嘉':'J','盛':'S','隆':'L','泰':'T','恒':'H',
  '汇':'H','丰':'F','源':'Y','达':'D','通':'T','信':'X','诚':'C','德':'D',
  '顺':'S','兴':'X','昌':'C','祥':'X','吉':'J','佳':'J','尚':'S','御':'Y',
  '铂':'B','凯':'K','希':'X','顿':'D','洲':'Z','际':'J','皇':'H','喜':'X',
  '来':'L','登':'D','威':'W','斯':'S','万':'W','豪':'H','尔':'E','丽':'L',
  '笙':'S','艾':'A','美':'M','克':'K','英':'Y','迪':'D','文':'W','华':'H',
  '都':'D','荟':'H','熙':'X','璟':'J','琳':'L','玥':'Y','宸':'C','玺':'X',
  '颜':'Y','朵':'D','漫':'M','芳':'F','蒂':'D','薇':'W','娜':'N','丽':'L',
  '思':'S','漫':'M','途':'T','家':'J','致':'Z','璞':'P','悠':'Y','隐':'Y',
  '澜':'L','泊':'B','枫':'F','蓝':'L','橙':'C','白':'B','银':'Y','金':'J',
  '铂':'B','钻':'Z','翡':'F','翠':'C','琉':'L','璃':'L','晶':'J','钻':'Z',
  '门':'M','口':'K','号':'H','弄':'N','路':'L','街':'J','巷':'X','里':'L',
  '弄':'N','坊':'F','城':'C','区':'Q','座':'Z','栋':'D','室':'S','层':'C',
  '集':'J','一':'Y','二':'E','三':'S','四':'S','五':'W','六':'L','七':'Q',
  '八':'B','九':'J','十':'S','百':'B','千':'Q','亿':'Y','兆':'Z',
  '圳':'Z','杭':'H','成':'C','武':'W','郑':'Z','西':'X','沈':'S','长':'C',
  '哈':'H','济':'J','青':'Q','南':'N','宁':'N','合':'H','福':'F','厦':'S',
  '南':'N','昆':'K','贵':'G','兰':'L','拉':'L','石':'S','太':'T','呼':'H',
  '乌':'W','银':'Y','海':'H','珠':'Z','惠':'H','中':'Z','温':'W','义':'Y',
};

// ==================== Express 服务器 ====================

const app = express();

// ---- CORS 中间件 ----
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 简易限流（内存实现，适合单实例）----
const rateLimitStore = new Map();
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - CONFIG.rateLimitWindowMs;

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }
  const timestamps = rateLimitStore.get(ip);
  // 清理过期记录
  while (timestamps.length > 0 && timestamps[0] < windowStart) {
    timestamps.shift();
  }
  if (timestamps.length >= CONFIG.rateLimitMaxRequests) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  timestamps.push(now);
  next();
}

// 健康检查（CloudBase 部署用）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 图片下载端点（支持 Vercel /tmp 和本地 public 目录）
app.get('/api/images/:filename', (req, res) => {
  const filename = req.params.filename;
  // 安全检查：只允许 welcome_/logo_ 前缀的 png
  if (!/^(welcome_|logo_)\d+\.(png|jpeg)$/.test(filename)) {
    return res.status(404).json({ error: '图片未找到' });
  }
  const paths = [
    path.join('/tmp', filename),
    path.join(__dirname, 'public', filename),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return res.sendFile(p);
    }
  }
  res.status(404).json({ error: '图片未找到或已过期' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SSE 端点：实时创建工作流
app.get('/api/workflow/sse', rateLimitMiddleware, (req, res) => {
  const hotelName = req.query.name;

  // 输入校验
  const validation = validateHotelName(hotelName);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 心跳保活：每 10 秒发一次，防止浏览器超时断开 SSE
  const keepaliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // 连接已关闭，清除定时器
      clearInterval(keepaliveTimer);
    }
  }, 10000);

  // 监听请求关闭，清理资源
  req.on('close', () => {
    clearInterval(keepaliveTimer);
  });

  const executor = new HotelWorkflowExecutor(CONFIG);

  // 监听进度并推送到 SSE
  executor.onProgress((data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      clearInterval(keepaliveTimer);
    }
  });

  // 异步执行工作流
  executor.run(hotelName).then((result) => {
    clearInterval(keepaliveTimer);
    try {
      if (result.success) {
        addHistoryRecord(result); // 自动保存历史记录
        res.write(`data: ${JSON.stringify({ step: 'complete', ...result })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ step: 'error', error: result.error || '执行失败' })}\n\n`);
      }
      res.end();
    } catch {
      // 连接已关闭
    }
  }).catch((err) => {
    clearInterval(keepaliveTimer);
    try {
      res.write(`data: ${JSON.stringify({ step: 'error', error: err.message })}\n\n`);
      res.end();
    } catch {
      // 连接已关闭
    }
  });
});

// 非流式端点（简单模式）
app.post('/api/workflow/run', rateLimitMiddleware, async (req, res) => {
  const { name } = req.body;

  const validation = validateHotelName(name);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const executor = new HotelWorkflowExecutor(CONFIG);
  const logs = [];

  executor.onProgress((data) => {
    logs.push(data);
  });

  const result = await executor.run(validation.sanitized);
  // 成功时自动保存历史
  if (result.success) {
    addHistoryRecord(result);
  }
  res.json({ ...result, logs });
});

// 已有酒店上传图片
app.post('/api/upload-images', rateLimitMiddleware, async (req, res) => {
  const { hotelName } = req.body;

  const validation = validateHotelName(hotelName);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }
  const name = validation.sanitized;

  try {
    // 登录
    const http = createHttpClient();
    const loginRes = await http.post(`${CONFIG.hotelUrl}/v3/web/login/in`,
      { name: CONFIG.loginUsername, pswd: CONFIG.loginPassword },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const cookie = loginRes.headers['set-cookie']?.[0];
    if (!cookie) return res.status(500).json({ error: '登录失败' });

    // 切换酒店
    const switchRes = await http.post(`${CONFIG.hotelUrl}/v3/web/login/env/sw_htl`,
      { hid: 693 },  // 灵哥晒太阳
      { headers: { 'Content-Type': 'application/json', Cookie: cookie } }
    );
    const swCookie = switchRes.headers['set-cookie']?.[0] || cookie;

    // 生成图片
    const welcomeBuf = await generateWelcomeImage(name);
    const logoBuf = await generateLogoImage(name);

    // 构建上传 JSON（含图片组件）
    const styleData = {
      style_name: '创维标准样式（语音版）',
      push_name: '欢迎词',
      root: {
        name: 'ROOT', type: 0, title: '标准版', child_type: 0, desc: '酒店通用样式001',
        container_infos: [{
          type: 1, name: 'WELCOME', title: '欢迎页', child_type: 0, desc: '包含欢迎页相关信息',
          container_infos: [
            { type: 2, name: 'WELCOME_BG_IMAGE', title: '欢迎页背景', push_mode: 0, onOrOff: 1,
              component_infos: [{ type: 1, value: '' }], child_type: 1, desc: '欢迎页背景图', container_infos: [],
              expand_info: { sup_types: [1], max_elem: '1', en_title: 'welcome bg', ext_s: [] },
            },
            { type: 2, name: 'WELCOME_LOGO', title: '欢迎页LOGO', push_mode: 0, onOrOff: 1,
              component_infos: [{ type: 1, value: '' }], child_type: 1, desc: '欢迎页Logo', container_infos: [],
              expand_info: { sup_types: [1], max_elem: '1', en_title: 'welcome logo', ext_s: [] },
            },
          ],
        }],
      },
      plan_detail: { plan_type: 0 },
      goals: [{ hid: 693, room_nums: ['----'] }],
    };

    // 手动拼接 multipart body
    const boundary = `----NodeJS${Date.now()}`;
    const parasStr = JSON.stringify(styleData);
    const crlf = '\r\n';
    
    const chunks = [
      Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="paras"${crlf}${crlf}${parasStr}${crlf}`),
    ];
    if (welcomeBuf) {
      chunks.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="files"; filename="welcome_bg.jpg"${crlf}Content-Type: image/jpeg${crlf}${crlf}`));
      chunks.push(welcomeBuf);
      chunks.push(Buffer.from(crlf));
    }
    if (logoBuf) {
      chunks.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="files"; filename="welcome_logo.png"${crlf}Content-Type: image/png${crlf}${crlf}`));
      chunks.push(logoBuf);
      chunks.push(Buffer.from(crlf));
    }
    chunks.push(Buffer.from(`--${boundary}--${crlf}`));
    const body = Buffer.concat(chunks);

    const httpModule = require('http');
    const urlObj = new URL(`${CONFIG.hotelUrl}/v3/web/push/style`);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Cookie': swCookie,
      },
    };
    const lib = urlObj.protocol === 'https:' ? require('https') : httpModule;

    const upRes = await new Promise((resolve, reject) => {
      const req = lib.request(options, (r) => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => {
          try { resolve({ code: r.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ code: r.statusCode, data }); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    res.json({
      success: upRes.data?.code === 10000,
      code: upRes.data?.code,
      msg: upRes.data?.msg,
      images: {
        welcome: `${welcomeBuf.length} bytes`,
        logo: `${logoBuf.length} bytes`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== 历史记录 API ====================

/** 获取历史记录列表 */
app.get('/api/history', (req, res) => {
  const records = readHistory();
  res.json(records);
});

/** 删除单条历史记录 */
app.delete('/api/history/:id', (req, res) => {
  const records = readHistory();
  const filtered = records.filter(r => r.id !== req.params.id);
  if (filtered.length === records.length) {
    return res.status(404).json({ error: '记录未找到' });
  }
  writeHistory(filtered);
  res.json({ success: true });
});

/** 清空全部历史记录 */
app.delete('/api/history', (req, res) => {
  writeHistory([]);
  res.json({ success: true });
});

// ===== Vercel Serverless 导出 =====
module.exports = app;

if (require.main === module || (!process.env.VERCEL && !process.env.TCB_ENV)) {
  app.listen(CONFIG.port, () => {
    const envLabel = CONFIG.hotelUrl.includes('42.194.213.245') ? '测试环境' : '生产环境';
    console.log(`\n========================================`);
    console.log(`  创建酒店工具已启动`);
    console.log(`  环境: ${envLabel}`);
    console.log(`  酒店系统: ${CONFIG.hotelUrl}`);
    console.log(`  打开浏览器访问:`);
    console.log(`  http://localhost:${CONFIG.port}`);
    console.log(`========================================\n`);
  });
}
