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

// ==================== 配置 ====================
const CONFIG = {
  // 酒店管理系统
  hotelUrl: process.env.HOTEL_URL || 'https://cooshare.coocaa.com/hotel',
  fid: parseInt(process.env.FID || '404'),
  loginUsername: process.env.LOGIN_USERNAME || 'n8n',
  loginPassword: process.env.LOGIN_PASSWORD || '[REDACTED_PASSWORD_HASH]',
  sourceHotelId: parseInt(process.env.SOURCE_HOTEL_ID || '214'),

  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',

  // 用户密码哈希（MD5("123")）
  userPasswordHash: '[REDACTED_PASSWORD_HASH]',

  port: parseInt(process.env.PORT || '3000'),

  // 网络请求超时（毫秒）
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),

  // 刷机平台
  huashiUrl: process.env.HUASHI_URL || 'https://skyworth-business.com/huashi-api',
  huashiUsername: process.env.HUASHI_USERNAME || '[REDACTED_USERNAME]',
  huashiPassword: process.env.HUASHI_PASSWORD || '[REDACTED_USERNAME]',
};

// ==================== 刷机平台 API ====================

let _huashiToken = null;
let _huashiTokenExpire = 0;

/** 登录刷机平台，获取 token */
async function huashiLogin() {
  const http = createHttpClient();
  const url = `${CONFIG.huashiUrl}/admin/login`;
  // 使用固定 uuid, captcha
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

/** 创建预设配置（含刷机码生成）*/
async function huashiCreateConfig(hotelName, pinyinName) {
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

  // 上传 login.txt 并获取 fileKey
  let fileKey = '';
  try {
    fileKey = await huashiUploadFile(loginContent, 'login.txt', token);
    console.log(`[huashi] login.txt 上传成功, fileKey: ${fileKey}`);
  } catch (err) {
    console.error(`[huashi] 文件上传失败: ${err.message}`);
  }

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
    preFiles: fileKey ? `/system/coocaa_hotel/login.txt` : '',
    preFileList: fileKey ? [{
      fileKey: fileKey,
      fileName: 'login.txt',
      filePath: '/system/coocaa_hotel/login.txt'
    }] : [],
    configInfo: loginContent,
    commentary: `酒店创建: ${hotelName} (${pinyinName})`,
  };

  const res = await http.post(`${CONFIG.huashiUrl}/web/huashiconfig`, body, {
    headers: { 'Content-Type': 'application/json', token },
  });
  if (res.data && res.data.code === 0 && res.data.data) {
    return res.data.data; // 刷机码
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
  const match = str.match(/^([a-zA-Z]*)(\d*)$/);
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

/** 写入历史记录 */
function writeHistory(records) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(records, null, 2), 'utf-8');
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
    status: data.status || 'success',
    createdAt: getTodayStr(),
  };
  records.unshift(record); // 最新记录在最前面
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

      // Step 7: 中文转拼音首字母
      await this.stepConvertPinyin(hotelName);

      // Step 8: 创建用户（失败则重命名重试）
      await this.stepCreateUser();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this._progress('done', `✅ 全部完成！耗时 ${elapsed} 秒`, {
        hotelName,
        hotelId: this.hotelId,
        pinyinName: this.pinyinName,
        finalUsername: this.finalUsername,
      });

      return { success: true, hotelName, hotelId: this.hotelId, pinyinName: this.pinyinName, finalUsername: this.finalUsername };
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

  /** Step 6: 更新欢迎词 */
  async stepUpdateWelcome(hotelName) {
    this._progress('welcome_msg', '正在更新欢迎词...');

    const url = `${this.config.hotelUrl}/v3/web/push/style`;

    // 构建欢迎词 JSON
    const styleData = {
      style_name: '创维标准样式（语音版）',
      push_name: '欢迎词',
      root: {
        name: 'ROOT',
        type: 0,
        title: '标准版',
        child_type: 0,
        desc: '酒店通用样式001',
        container_infos: [
          {
            type: 1,
            name: 'WELCOME',
            title: '欢迎页',
            child_type: 0,
            desc: '包含欢迎页相关信息',
            container_infos: [
              {
                type: 2,
                name: 'WELCOME_TEXT',
                title: '欢迎词',
                push_mode: 0,
                onOrOff: 1,
                component_infos: [
                  { type: 4, value: `欢迎下榻${hotelName}` },
                  { type: 0, value: '1' },
                ],
                child_type: 1,
                desc: '设置欢迎词',
                container_infos: [],
                expand_info: { sup_types: [4, 0], max_elem: '3', en_title: 'welcome text', ext_s: [] },
              },
              {
                type: 2,
                name: 'WELCOME_VOICE_BROADCAST',
                title: '语音播报',
                push_mode: 0,
                onOrOff: 1,
                component_infos: [
                  {
                    type: 4,
                    value: `欢迎下榻${hotelName}，我是您的AI客房管家小维。\n无论是调节空调温度、点亮温馨灯光，还是轻启窗帘迎接晨光，您只需轻声唤我："小维小维，打开空调"或"小维小维，打开灯光"，祝您入住愉快！`,
                  },
                ],
                child_type: 1,
                desc: '语音播报',
                container_infos: [],
                expand_info: { sup_types: [4], ext_s: [], max_elem: 1 },
              },
            ],
          },
        ],
      },
      plan_detail: { plan_type: 0 },
      goals: [
        {
          hid: this.hotelId,
          room_nums: ['----'],
        },
      ],
    };

    const http = createHttpClient();
    const form = new FormData();
    form.append('paras', JSON.stringify(styleData));

    const res = await http.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Cookie: this.cookies.switch,
      },
    });

    this._progress('welcome_msg', `欢迎词更新结果: ${JSON.stringify(res.data)}`);
  }

  /** Step 7: 中文转拼音首字母（DeepSeek API） */
  async stepConvertPinyin(hotelName) {
    this._progress('pinyin', `正在将"${hotelName}"转换为拼音首字母...`);

    const apiKey = this.config.deepseekApiKey;
    if (!apiKey) {
      // 如果没有配置DeepSeek API key，使用内置的简单拼音转写
      this._progress('pinyin', '⚠️ 未配置DeepSeek API Key，使用内置简易拼音转换');
      this.pinyinName = this.simplePinyinConvert(hotelName);
      this._progress('pinyin', `拼音首字母: ${this.pinyinName}`);
      return;
    }

    try {
      const http = createHttpClient();
      const res = await http.post(
        'https://api.deepseek.com/chat/completions',
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
      this.pinyinName = this.simplePinyinConvert(hotelName);
      this._progress('pinyin', `拼音首字母（本地）: ${this.pinyinName}`);
    }
  }

  /** 本地简易拼音转换（仅限常见汉字，备选方案） */
  simplePinyinConvert(chinese) {
    // 常见汉字拼音首字母映射表（仅覆盖常用字）
    const pinyinMap = {
      '创': 'C', '维': 'W', '酒': 'J', '店': 'D', '科': 'K', '技': 'J',
      '有': 'Y', '限': 'X', '公': 'G', '司': 'S', '饭': 'F', '大': 'D',
      '堂': 'T', '客': 'K', '房': 'F', '会': 'H', '议': 'Y', '中': 'Z',
      '心': 'X', '南': 'N', '北': 'B', '京': 'J', '上': 'S', '海': 'H',
      '广': 'G', '州': 'Z', '深': 'S', '圳': 'Z', '天': 'T', '地': 'D',
      '万': 'W', '国': 'G',
      // 更多常用字...
    };

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
      result += pinyinMap[char] || '';
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

  /** Step 9: 刷机平台——创建门店+预设配置+生成刷机码 */
  }
}

// ==================== Express 服务器 ====================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查（CloudBase 部署用）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SSE 端点：实时创建工作流
app.get('/api/workflow/sse', (req, res) => {
  const hotelName = req.query.name;

  if (!hotelName) {
    res.status(400).json({ error: '必须提供酒店名称 (name)' });
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
    res.write(': keepalive\n\n');
  }, 10000);

  // 监听请求关闭，清理资源
  req.on('close', () => {
    clearInterval(keepaliveTimer);
  });

  const executor = new HotelWorkflowExecutor(CONFIG);

  // 监听进度并推送到 SSE
  executor.onProgress((data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });

  // 异步执行工作流
  executor.run(hotelName).then((result) => {
    clearInterval(keepaliveTimer);
    if (result.success) {
      addHistoryRecord(result); // 自动保存历史记录
      res.write(`data: ${JSON.stringify({ step: 'complete', ...result })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ step: 'error', error: result.error || '执行失败' })}\n\n`);
    }
    res.end();
  }).catch((err) => {
    clearInterval(keepaliveTimer);
    res.write(`data: ${JSON.stringify({ step: 'error', error: err.message })}\n\n`);
    res.end();
  });
});

// 非流式端点（简单模式）
app.post('/api/workflow/run', async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: '必须提供酒店名称' });
  }

  const executor = new HotelWorkflowExecutor(CONFIG);
  const logs = [];

  executor.onProgress((data) => {
    logs.push(data);
  });

  const result = await executor.run(name);
  // 成功时自动保存历史
  if (result.success) {
    addHistoryRecord(result);
  }
  res.json({ ...result, logs });
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

// 启动服务器
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
