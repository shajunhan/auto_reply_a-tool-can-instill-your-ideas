/**
 * 个人思想库 · 本地服务器（v2：多思想仓库 + 文档导入）
 * 纯 Node.js 实现，零第三方依赖。
 * 所有数据保存在本文件同级的 data/ 目录（D 盘），不占用系统盘空间。
 *
 * 功能：
 *  - 思想库：多仓库管理（手动创建/重命名/删除），思想按仓库归档
 *  - 文档导入：txt / md / docx / zip（zip 内批量提取 txt、docx）
 *  - 智能问答：仅从所选思想仓库检索 -> 构建"思维分身"提示词 -> 调用 OpenAI 兼容接口流式回答
 *  - 设置：AI 接口配置；备份：导出 / 导入 / 统计
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const study = require('./study');

/* ------------------------------ 路径与默认配置 ------------------------------ */

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const THOUGHTS_FILE = path.join(DATA_DIR, 'thoughts.json');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const REPOS_FILE = path.join(DATA_DIR, 'repos.json');
const STUDY_FILE = path.join(DATA_DIR, 'study.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  port: 8688,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  topK: 8,
  userName: '我',
  systemPrompt: '',
};

const CATEGORIES = ['原则', '决策逻辑', '知识', '经验', '其他'];
const IMPORTANCE = ['high', 'medium', 'low'];
const DECISION_WORDS = ['怎么办', '如何', '怎么', '应该', '该不该', '要不要', '选择', '决定', '遇到', '处理', '方案', '建议', '做不做', '行不行'];
const MAX_THOUGHT_CHARS = 50000; // 单条思想最大字符数（文档导入时截断）

/* ------------------------------ 工具函数 ------------------------------ */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function now() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomUUID();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  limit = limit || 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('无效的 JSON 请求体'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------ 存储层 ------------------------------ */

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
  if (!cfg.baseUrl) cfg.baseUrl = DEFAULT_CONFIG.baseUrl;
  return cfg;
}

function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_FILE, cfg);
}

function loadThoughts() {
  return readJson(THOUGHTS_FILE, []);
}

function saveThoughts(list) {
  writeJsonAtomic(THOUGHTS_FILE, list);
}

function loadConversations() {
  return readJson(CONVERSATIONS_FILE, []);
}

function saveConversations(list) {
  writeJsonAtomic(CONVERSATIONS_FILE, list);
}

function loadRepos() {
  return readJson(REPOS_FILE, []);
}

function saveRepos(list) {
  writeJsonAtomic(REPOS_FILE, list);
}

function reposById() {
  return new Map(loadRepos().map((r) => [r.id, r]));
}

/** 校验仓库 ID，非法则回退到默认仓库 */
function validRepoId(id, repos) {
  repos = repos || loadRepos();
  if (id && repos.some((r) => r.id === id)) return id;
  return 'default';
}

/** 启动时迁移：确保默认仓库存在、旧思想归入默认仓库 */
function migrate() {
  let repos = readJson(REPOS_FILE, null);
  if (!Array.isArray(repos) || !repos.length) {
    repos = [{ id: 'default', name: '默认仓库', description: '未指定仓库的思想默认存放于此', createdAt: now(), updatedAt: now() }];
    saveRepos(repos);
  }
  const ids = new Set(repos.map((r) => r.id));
  const thoughts = loadThoughts();
  let changed = false;
  for (const t of thoughts) {
    if (!t.repoId || !ids.has(t.repoId)) {
      t.repoId = 'default';
      changed = true;
    }
  }
  if (changed) saveThoughts(thoughts);
  // 学习模式状态文件
  if (!fs.existsSync(STUDY_FILE)) saveStudy({});
}

function loadStudy() {
  const d = readJson(STUDY_FILE, {});
  return d && typeof d === 'object' ? d : {};
}

function saveStudy(map) {
  writeJsonAtomic(STUDY_FILE, map || {});
}

function studyForRepo(repoIds) {
  // repoIds 为空 -> 全部仓库
  const allowed = Array.isArray(repoIds) && repoIds.length ? new Set(repoIds) : null;
  return loadThoughts().filter((t) => !allowed || allowed.has(t.repoId));
}

function studyOverview(thoughts, studyMap, limit) {
  limit = limit || 12;
  return thoughts
    .map((t) => {
      const st = studyMap[t.id] || study.emptyState();
      return { t, st };
    })
    .sort((a, b) => {
      const need = (s) =>
        (s.mastered ? 1000 : 0) + (s.totalAnswers ? 0 : 300) + s.survival + (s.weakness ? 100 : 0);
      return need(a.st) - need(b.st);
    })
    .slice(0, limit)
    .map(({ t, st }) => {
      const flags = [];
      if (st.mastered) flags.push('已掌握');
      else if (st.weakness) flags.push('薄弱');
      if (!st.totalAnswers) flags.push('未学');
      return `- ${t.title}：存活率${st.survival}%${flags.length ? '（' + flags.join('、') + '）' : ''}`;
    })
    .join('\n');
}

/* ------------------------------ 检索与提示词 ------------------------------ */

const CJK = /[\u4e00-\u9fa5]/;
const STOP_SINGLE = new Set('的了是我在有和就不人都一要你他她它这也那与及对从为着过上被把'.split(''));

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  let ascii = '';
  const chars = [];
  for (const ch of s) {
    if (/[a-z0-9]/.test(ch)) {
      ascii += ch;
      continue;
    }
    if (ascii) {
      tokens.add(ascii);
      ascii = '';
    }
    if (CJK.test(ch)) chars.push(ch);
  }
  if (ascii) tokens.add(ascii);
  for (let i = 0; i < chars.length; i++) {
    if (!STOP_SINGLE.has(chars[i])) tokens.add(chars[i]);
    if (i + 1 < chars.length) tokens.add(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function scoreThought(thought, query, queryTokens) {
  const titleT = tokenize(thought.title);
  const contentT = tokenize(thought.content);
  const tagT = tokenize((thought.tags || []).join(' '));
  const catT = tokenize(thought.category || '');
  let score = 0;
  for (const t of queryTokens) {
    if (titleT.has(t)) score += 4;
    if (tagT.has(t)) score += 3;
    if (catT.has(t)) score += 2;
    if (contentT.has(t)) score += 1;
  }
  const q = String(query || '').toLowerCase();
  if (q.length >= 4 && String(thought.content || '').toLowerCase().includes(q)) score += 8;
  if (q.length >= 2 && String(thought.title || '').toLowerCase().includes(q)) score += 6;
  return score;
}

/** 仅从指定仓库中检索；repoIds 为空数组/未提供时检索全部仓库 */
function retrieveThoughts(query, config, repoIds) {
  const q = String(query || '').trim();
  if (!q) return [];
  const queryTokens = tokenize(q);
  if (!queryTokens.size) return [];
  const isDecision = DECISION_WORDS.some((w) => q.includes(w));
  const allowed = Array.isArray(repoIds) && repoIds.length ? new Set(repoIds) : null;
  const thoughts = loadThoughts();
  const scored = [];
  for (const t of thoughts) {
    if (allowed && !allowed.has(t.repoId)) continue;
    let s = scoreThought(t, q, queryTokens);
    if (isDecision && (t.category === '决策逻辑' || t.category === '原则')) s *= 1.6;
    if (t.importance === 'high') s *= 1.15;
    if (s > 0) scored.push({ thought: t, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const topK = Math.max(1, Number(config.topK) || 8);
  return scored.slice(0, topK).map((x) => x.thought);
}

function formatThoughts(thoughts, repoMap) {
  if (!thoughts || !thoughts.length) return '（所选思想仓库中暂无相关记录）';
  return thoughts
    .map((t, i) => {
      const repoName = (repoMap && repoMap.get(t.repoId) && repoMap.get(t.repoId).name) || '未分类';
      return `【${i + 1}】仓库：${repoName}，类别：${t.category}${t.importance === 'high' ? '（重要）' : ''}${
        (t.tags || []).length ? '，标签：' + t.tags.join('、') : ''
      }\n标题：${t.title}\n内容：${t.content}`;
    })
    .join('\n\n');
}

function buildSystemPrompt(config, thoughts, repoIds, repoMap) {
  const name = config.userName || '我';
  let scope = '';
  if (Array.isArray(repoIds) && repoIds.length) {
    const names = repoIds.map((id) => (repoMap && repoMap.get(id) && repoMap.get(id).name) || id).join('、');
    scope = `\n## 本次检索范围\n仅限以下思想仓库：${names}。回答时不得使用其他仓库的内容。\n`;
  }
  const base = `你是「${name}」的思维分身——一个完全忠实于其思想体系的 AI 助手。

## 你的使命
当用户向你提问时，按以下流程处理：
1. 先分析问题的本质：对方真正想要什么、关键约束是什么、有哪些可行路径。
2. 调用下方【思想库】中与该问题最相关的内容（原则、决策逻辑、知识与经验），把它们作为回答的第一依据。
3. 结合你自己的通用能力，选择最合适的路径和方法（优先用户逻辑，其次补充通用最佳实践）。
4. 以符合「${name}」思维方式、价值观和表达习惯的口吻，给出具体、可执行、有条理的回答。${scope}
## 思想库（用户的思想与逻辑，按相关度排序）
${formatThoughts(thoughts, repoMap)}

## 回答要求
1. 思想库中已有的原则和决策逻辑必须优先遵循，不得违背，也不得替换成你自己的偏好。
2. 如果思想库中没有与问题相关的内容，请明确说明「你的思想库中暂未找到直接相关的记录」，然后基于通用知识给出建议。
3. 回答要具体、有条理、可直接执行；存在不确定性时要坦诚说明。
4. 在回答末尾用【思考路径】小节（不超过 5 行）说明：你调用了哪些思想仓库与思想内容，为什么选择这条路径。`;
  const custom = String(config.systemPrompt || '').trim();
  return custom ? `${custom}\n\n=====\n\n${base}` : base;
}

/* ------------------------------ AI 调用 ------------------------------ */

async function callAIStream(messages, config, onDelta) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const url = baseUrl + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.apiKey || ''),
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: Number(config.temperature) || 0.7,
      stream: true,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {}
    throw new Error(`AI 接口返回 ${res.status}：${String(detail).slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) onDelta(delta);
      } catch {}
    }
  }
}

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function buildMockAnswer(question, thoughts, repoMap) {
  const parts = [];
  parts.push(
    `（演示模式：尚未配置 AI 接口密钥。下面是仅基于您思想库的框架性回答；请在「设置」中填写 API 密钥后，即可获得调用 AI 的完整回答。）\n`
  );
  parts.push(`**问题分析**：${question}\n`);
  if (thoughts.length) {
    parts.push(`**您的思想库中相关的记录**：`);
    thoughts.forEach((t, i) => {
      const brief = String(t.content).length > 50 ? String(t.content).slice(0, 50) + '…' : t.content;
      const repoName = (repoMap && repoMap.get(t.repoId) && repoMap.get(t.repoId).name) || '';
      parts.push(`${i + 1}. [${repoName} / ${t.category}] ${t.title}：${brief}`);
    });
    const first = thoughts[0];
    parts.push(`\n**建议路径**：优先遵循上文中「${first.category}」类的思路：${String(first.content).slice(0, 80)}…\n`);
  } else {
    parts.push(
      `**提示**：所选思想仓库中暂未找到直接相关的记录。你可以先补充想法，或配置 AI 密钥后让 AI 结合通用知识回答。\n`
    );
  }
  parts.push(`\n【思考路径】演示模式仅完成了本地检索（未调用 AI）：匹配到 ${thoughts.length} 条相关思想。`);
  return parts.join('\n');
}

async function handleTestAI(res) {
  const config = loadConfig();
  if (!config.apiKey) {
    sendJson(res, 200, { ok: false, error: '请先填写 API 密钥' });
    return;
  }
  try {
    const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    const r = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '请只回复四个字：连接成功' }],
        temperature: 0,
        max_tokens: 20,
        stream: false,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}：${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    const reply = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    sendJson(res, 200, { ok: true, reply: String(reply || '').trim() });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
  }
}

/* ------------------------------ 问答接口 ------------------------------ */

async function handleAsk(req, res, body) {
  const config = loadConfig();
  const question = String(body.question || '').trim();
  if (!question) {
    sendJson(res, 400, { error: '问题不能为空' });
    return;
  }
  const repoIds = Array.isArray(body.repos) ? body.repos.filter((x) => typeof x === 'string') : [];
  const repoMap = reposById();
  const thoughts = retrieveThoughts(question, config, repoIds);
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const messages = [
    { role: 'system', content: buildSystemPrompt(config, thoughts, repoIds, repoMap) },
    ...history
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant'))
      .map((h) => ({ role: h.role, content: String(h.content || '') })),
    { role: 'user', content: question },
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  if (!config.apiKey) {
    const mock = buildMockAnswer(question, thoughts, repoMap);
    for (const seg of mock.match(/[^。！？\n]+[。！？\n]?/g) || []) {
      if (seg.trim()) sse(res, 'delta', { text: seg });
    }
    sse(res, 'done', { usedThoughts: thoughts.map((t) => t.id), mock: true });
    res.end();
    return;
  }

  try {
    await callAIStream(messages, config, (d) => {
      sse(res, 'delta', { text: d });
    });
    sse(res, 'done', { usedThoughts: thoughts.map((t) => t.id), mock: false });
  } catch (e) {
    sse(res, 'error', { message: String((e && e.message) || e) });
  }
  res.end();
}

/* ------------------------------ 文档导入（txt / docx / zip） ------------------------------ */

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function cleanText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function capText(s) {
  s = cleanText(s);
  if (s.length > MAX_THOUGHT_CHARS) {
    s = s.slice(0, MAX_THOUGHT_CHARS) + '\n\n……（内容过长，已截断）';
  }
  return s;
}

/** 简易 ZIP 读取器：支持 store(0) 与 deflate(8) */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('无效的 ZIP 文件');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let pos = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const nameBuf = buf.subarray(pos + 46, pos + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + csize);
      try {
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else {
          pos += 46 + nameLen + extraLen + commentLen;
          continue;
        }
        entries.push({ name: nameBuf, data });
      } catch {
        /* 单个条目解压失败则跳过 */
      }
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractDocx(buf) {
  const entries = unzip(buf);
  const doc = entries.find((e) => decodeText(e.name) === 'word/document.xml');
  if (!doc) throw new Error('不是有效的 Word 文档（缺少 document.xml）');
  let xml = doc.data.toString('utf8');
  xml = xml.replace(/<w:tab[^>]*\/>/g, '\t');
  xml = xml.replace(/<w:br[^>]*\/>/g, '\n');
  xml = xml.replace(/<\/w:p>/g, '\n');
  xml = xml.replace(/<\/w:tr>/g, '\n');
  xml = xml.replace(/<[^>]+>/g, '');
  xml = xml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  return capText(xml);
}

function extractTextFromBuffer(filename, buf) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (['.txt', '.md', '.markdown', '.log', '.csv'].includes(ext)) {
    return capText(decodeText(buf));
  }
  if (ext === '.docx') return extractDocx(buf);
  if (ext === '.doc') throw new Error('旧版 .doc 格式暂不支持，请另存为 .docx 或 .txt 后再导入');
  if (ext === '.zip') throw new Error('ZIP 请按压缩包整体导入');
  throw new Error(`不支持的文件格式：${ext || '（无扩展名）'}（支持 txt / md / docx / zip）`);
}

function handleImportDoc(res, body) {
  const filename = String(body.filename || 'document');
  const b64 = String(body.dataBase64 || '');
  if (!b64) {
    sendJson(res, 400, { error: '缺少文件内容' });
    return;
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) {
    sendJson(res, 400, { error: '文件内容为空' });
    return;
  }
  const items = [];
  if (filename.toLowerCase().endsWith('.zip')) {
    let entries;
    try {
      entries = unzip(buf);
    } catch (e) {
      sendJson(res, 400, { error: 'ZIP 解析失败：' + e.message });
      return;
    }
    for (const e of entries) {
      const name = decodeText(e.name);
      if (/\.(txt|md|markdown|log|csv|docx)$/i.test(name)) {
        try {
          const text = extractTextFromBuffer(name, e.data);
          if (text.trim()) {
            items.push({
              fileName: name,
              title: path.basename(name).replace(/\.[^.]+$/, ''),
              content: text,
            });
          }
        } catch {
          /* 跳过无法解析的文件 */
        }
      }
    }
    if (!items.length) {
      sendJson(res, 400, { error: 'ZIP 中没有找到可导入的 txt / md / docx 文件' });
      return;
    }
  } else {
    try {
      const text = extractTextFromBuffer(filename, buf);
      if (!text.trim()) {
        sendJson(res, 400, { error: '未能从文档中提取到文字内容' });
        return;
      }
      items.push({
        fileName: filename,
        title: path.basename(filename).replace(/\.[^.]+$/, ''),
        content: text,
      });
    } catch (e) {
      sendJson(res, 400, { error: String((e && e.message) || e) });
      return;
    }
  }
  sendJson(res, 200, { items });
}

/* ------------------------------ 学习模式 ------------------------------ */

function buildStudyPrompt(config, point, st, repoName, overview, isEnd) {
  const name = config.userName || '我';
  const due = study.isDue(st) ? '（已到期，需复习）' : '';
  const base = `你是「${name}」的专属学习教练，通过「主动回忆 + 思维对抗 + 极限压测 + 存活率监测」的方式，帮我把思想库里的知识点真正理解掌握，而不是死记硬背。

# 当前学习对象
- 本次知识点：${point.title}
- 所属仓库：${repoName}
- 知识点内容：
"""
${String(point.content).slice(0, 4000)}
"""
- 当前学习状态：存活率 ${st.survival}%${due}，连续答对 ${st.streak} 次，已答 ${st.totalAnswers} 次（对 ${st.correctCount} / 错 ${st.wrongCount}）
- 知识库位置（回答时引用）：【${point.title}】

# 当前范围存活率总览（用于出题与报告）
${overview || '（暂无知识点）'}

# 学习流程（四阶段循环）
Phase 1 主动出题（Plan）：根据该知识点出 1 道需要推导/回忆的简答题或逻辑推导题（少出记忆选择题）。必须带「陷阱」：把知识库中其他相似知识点的易混点揉进题干，故意设置干扰。题目末尾标注「本题考察的知识库位置：【${point.title}】」。
Phase 2 思维对抗（Check）：用户作答后先判断对错：
  - 完全正确 → 直接进入 Phase 3 极限压测。
  - 有错或逻辑漏洞 → 扮演「杠精」反驳，用知识库原文细节指出逻辑链缺失或错误前提，格式如「你忽略了知识库【${point.title}】提到的XX约束条件，在这个前提下你的结论不成立，因为XX」。若用户反驳成功则认可；反驳失败则引导回忆，不要直接给完整答案。
Phase 3 极限压测（Stress Test）：答对后触发。修改原知识点的约束条件，生成 1 道更难的场景题（例如把适用场景从 A 改成 B），逼对方把知识点迁移到新场景，考察是否真正理解底层逻辑。

# 交互规则
- 用户说「给我提示」→ 只给 1 个知识库里的关键词/逻辑方向，绝不直接给完整答案。
- 用户说「纠正字幕错误」→ 对比知识库多处相关内容，指出口语化/不严谨表述，给出修正后的准确内容。
- 用户说「结束学习」→ 结合上方总览输出本次学习报告（覆盖知识点数、平均存活率、薄弱点清单及知识库位置、下次复习优先级）。
- 不同来源对同一知识点冲突 → 同时列出冲突内容让用户判断，不直接下结论，最后用通用知识裁定。
（系统会在后台对用户的作答另行判分，你无需输出任何标记。）
`;
  const custom = String(config.systemPrompt || '').trim();
  return custom ? `${custom}\n\n=====\n\n${base}` : base;
}

/* 独立的轻量判题器：判定用户对当前题目的作答对错（correct / wrong / pending） */
async function judgeStudyAnswer(config, point, convo, latestAnswer) {
  const sys =
    `你是严格的学习判题器。下面是知识库中的一个知识点、学习问答历史与用户最新作答。请判定：用户对当前这道题的回答是否算「答对」。
- 用户思路正确、抓住核心 → 只回复单词 correct
- 用户明显答错、违背知识点，或明确表示不会/放弃 → 只回复单词 wrong
- 用户作答不完整/仍在对抗追问中，尚无最终结论 → 只回复单词 pending
只允许回复 correct / wrong / pending 三个单词之一。

知识点标题：${point.title}
知识点内容：${String(point.content).slice(0, 2500)}`;
  const hist = [
    ...(Array.isArray(convo) ? convo.map((h) => ({ role: h.role, content: String(h.content || '').slice(0, 1500) })) : []),
    { role: 'user', content: '【最新作答】' + String(latestAnswer || '').slice(0, 1500) },
  ];
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (config.apiKey || '') },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: sys }, ...hist],
      temperature: 0,
      max_tokens: 10,
      stream: false,
    }),
  });
  if (!r.ok) return null;
  const j = JSON.parse(await r.text());
  const t = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').toLowerCase();
  if (t.includes('correct')) return 'correct';
  if (t.includes('wrong')) return 'wrong';
  return null; // pending
}

async function handleStudyAsk(req, res, body) {
  const config = loadConfig();
  const repos = Array.isArray(body.repos) ? body.repos.filter((x) => typeof x === 'string') : [];
  const repoMap = reposById();
  const inScope = studyForRepo(repos);
  if (!inScope.length) {
    sendJson(res, 400, { error: '所选仓库中没有可学习的知识点，请先录入或导入内容' });
    return;
  }

  const studyMap = loadStudy();
  // 确定本次知识点
  let point = null;
  if (body.pointId) point = inScope.find((t) => t.id === body.pointId) || null;
  if (!point) point = study.pickStudyPoint(inScope, studyMap);
  const st = study.loadOrInitState(studyMap, point.id);
  const repoName = (repoMap.get(point.repoId) || {}).name || '默认仓库';

  // 处理动作包装
  const question = String(body.question || '').trim();
  const action = String(body.action || 'ask');
  let userMsg = question;
  if (action === 'hint') userMsg = '【给我提示】' + (userMsg ? '（' + userMsg + '）' : '');
  if (action === 'correct-subtitle') userMsg = '【纠正字幕错误】' + (userMsg ? '（' + userMsg + '）' : '');
  if (action === 'end') userMsg = '【结束学习，请输出本次学习报告】' + (userMsg ? '（' + userMsg + '）' : '');
  if (!userMsg.trim()) {
    sendJson(res, 400, { error: '内容不能为空' });
    return;
  }

  const isEnd = action === 'end';
  const overview = studyOverview(inScope, studyMap);
  const messages = [
    { role: 'system', content: buildStudyPrompt(config, point, st, repoName, overview, isEnd) },
    ...(Array.isArray(body.history)
      ? body.history
          .filter((h) => h && (h.role === 'user' || h.role === 'assistant'))
          .map((h) => ({ role: h.role, content: String(h.content || '') }))
      : []),
    { role: 'user', content: userMsg },
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  if (!config.apiKey) {
    const mock =
      `（演示模式：尚未配置 AI 接口密钥。）\n\n` +
      `**当前知识点**：【${point.title}】（仓库：${repoName}，存活率 ${st.survival}%）\n\n` +
      `出题请配置 API 密钥后使用。`;
    sse(res, 'delta', { text: mock });
    sse(res, 'done', { clean: mock, point: point.id });
    res.end();
    return;
  }

  let full = '';
  try {
    await callAIStream(messages, config, (d) => {
      full += d;
      sse(res, 'delta', { text: d });
    });
  } catch (e) {
    sse(res, 'error', { message: String((e && e.message) || e) });
  }

  // 用独立的判题器判定作答，更新存活率
  let verdict = null;
  let pointState = Object.assign({}, st);
  const shouldJudge = action === 'ask' && config.apiKey && !/开始学习/.test(String(body.question || ''));
  if (shouldJudge) {
    try {
      const v = await judgeStudyAnswer(config, point, messages.slice(1), body.question);
      if (v === 'correct' || v === 'wrong') {
        study.applyVerdict(st, v === 'correct');
        saveStudy(studyMap);
        verdict = v;
        pointState = Object.assign({}, st);
      }
    } catch {
      /* 判题失败不阻塞回答 */
    }
  }

  const clean = study.stripStudyMeta(full);
  sse(res, 'done', { clean, point: point.id, verdict, state: pointState });

  if (isEnd) {
    const startedAt = Number(body.startedAt) || 0;
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    const pts = inScope.map((t) => ({ t, st: studyMap[t.id] || study.emptyState() }));
    const avg = pts.length ? Math.round(pts.reduce((n, x) => n + x.st.survival, 0) / pts.length) : 0;
    const weak = pts
      .filter((x) => x.st.weakness)
      .map((x) => `${x.t.title}（存活率 ${x.st.survival}%）`);
    sse(res, 'report', {
      durationMs,
      points: pts.length,
      avgSurvival: avg,
      masteredCount: pts.filter((x) => x.st.mastered).length,
      weakPoints: weak.slice(0, 20),
    });
  }

  res.end();
}

/* ------------------------------ HTTP 路由 ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method;
  try {
    /* ---- 静态资源 ---- */
    if (method === 'GET' && p.startsWith('/api/') === false) {
      serveStatic(req, res, p);
      return;
    }

    /* ---- 统计 ---- */
    if (method === 'GET' && p === '/api/stats') {
      const thoughts = loadThoughts();
      const convs = loadConversations();
      const repos = loadRepos();
      const byCat = {};
      CATEGORIES.forEach((c) => (byCat[c] = 0));
      thoughts.forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + 1));
      const perRepo = {};
      repos.forEach((r) => (perRepo[r.id] = 0));
      thoughts.forEach((t) => (perRepo[t.repoId] = (perRepo[t.repoId] || 0) + 1));
      sendJson(res, 200, {
        thoughts: thoughts.length,
        conversations: convs.length,
        totalMessages: convs.reduce((n, c) => n + (c.messages || []).length, 0),
        byCat,
        repos: repos.map((r) => ({ id: r.id, name: r.name, count: perRepo[r.id] || 0 })),
        dataDir: DATA_DIR,
      });
      return;
    }

    /* ---- 思想仓库 ---- */
    if (method === 'GET' && p === '/api/repos') {
      sendJson(res, 200, { repos: loadRepos() });
      return;
    }
    if (method === 'POST' && p === '/api/repos') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) {
        sendJson(res, 400, { error: '仓库名称不能为空' });
        return;
      }
      const repo = {
        id: uid(),
        name: name.slice(0, 30),
        description: String(body.description || '').trim().slice(0, 200),
        createdAt: now(),
        updatedAt: now(),
      };
      const list = loadRepos();
      list.push(repo);
      saveRepos(list);
      sendJson(res, 200, { repo });
      return;
    }
    let rm = p.match(/^\/api\/repos\/([^/]+)$/);
    if (rm && method === 'PUT') {
      const body = await readBody(req);
      const list = loadRepos();
      const repo = list.find((x) => x.id === rm[1]);
      if (!repo) {
        sendJson(res, 404, { error: '未找到该仓库' });
        return;
      }
      if (typeof body.name === 'string' && body.name.trim()) repo.name = body.name.trim().slice(0, 30);
      if (typeof body.description === 'string') repo.description = body.description.trim().slice(0, 200);
      repo.updatedAt = now();
      saveRepos(list);
      sendJson(res, 200, { repo });
      return;
    }
    if (rm && method === 'DELETE') {
      const list = loadRepos();
      const repo = list.find((x) => x.id === rm[1]);
      if (!repo) {
        sendJson(res, 404, { error: '未找到该仓库' });
        return;
      }
      if (repo.id === 'default') {
        sendJson(res, 400, { error: '默认仓库不能删除' });
        return;
      }
      // 仓库内的思想移入默认仓库
      const thoughts = loadThoughts();
      let moved = 0;
      for (const t of thoughts) {
        if (t.repoId === repo.id) {
          t.repoId = 'default';
          moved++;
        }
      }
      if (moved) saveThoughts(thoughts);
      saveRepos(list.filter((x) => x.id !== repo.id));
      sendJson(res, 200, { ok: true, movedThoughts: moved });
      return;
    }

    /* ---- 思想库 ---- */
    if (method === 'GET' && p === '/api/thoughts') {
      sendJson(res, 200, { thoughts: loadThoughts() });
      return;
    }
    if (method === 'POST' && p === '/api/thoughts') {
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      const content = String(body.content || '').trim();
      if (!title && !content) {
        sendJson(res, 400, { error: '标题和内容至少填写一项' });
        return;
      }
      const thought = {
        id: uid(),
        title,
        content: content.slice(0, MAX_THOUGHT_CHARS),
        category: CATEGORIES.includes(body.category) ? body.category : '其他',
        importance: IMPORTANCE.includes(body.importance) ? body.importance : 'medium',
        tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
        repoId: validRepoId(body.repoId),
        source: body.source === 'chat' ? 'chat' : body.source === 'import' ? 'import' : 'manual',
        createdAt: now(),
        updatedAt: now(),
      };
      const list = loadThoughts();
      list.unshift(thought);
      saveThoughts(list);
      sendJson(res, 200, { thought });
      return;
    }
    /* 批量导入（必须在 /:id 之前匹配） */
    if (method === 'POST' && p === '/api/thoughts/batch') {
      const body = await readBody(req);
      const arr = Array.isArray(body.thoughts) ? body.thoughts : [];
      if (!arr.length) {
        sendJson(res, 400, { error: '没有可导入的内容' });
        return;
      }
      const repoId = validRepoId(body.repoId);
      const list = loadThoughts();
      let added = 0;
      for (const t of arr) {
        const title = String((t && t.title) || '').trim();
        const content = String((t && t.content) || '').trim();
        if (!title && !content) continue;
        list.unshift({
          id: uid(),
          title,
          content: content.slice(0, MAX_THOUGHT_CHARS),
          category: CATEGORIES.includes(t.category) ? t.category : '知识',
          importance: IMPORTANCE.includes(t.importance) ? t.importance : 'medium',
          tags: [],
          repoId,
          source: 'import',
          createdAt: now(),
          updatedAt: now(),
        });
        added++;
      }
      saveThoughts(list);
      sendJson(res, 200, { ok: true, added });
      return;
    }
    let m = p.match(/^\/api\/thoughts\/([^/]+)$/);
    if (m && method === 'PUT') {
      const body = await readBody(req);
      const list = loadThoughts();
      const t = list.find((x) => x.id === m[1]);
      if (!t) {
        sendJson(res, 404, { error: '未找到该思想' });
        return;
      }
      if (body.title !== undefined) t.title = String(body.title).trim();
      if (body.content !== undefined) t.content = String(body.content).trim().slice(0, MAX_THOUGHT_CHARS);
      if (body.category !== undefined && CATEGORIES.includes(body.category)) t.category = body.category;
      if (body.importance !== undefined && IMPORTANCE.includes(body.importance)) t.importance = body.importance;
      if (body.tags !== undefined) {
        t.tags = Array.isArray(body.tags) ? body.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : [];
      }
      if (body.repoId !== undefined) t.repoId = validRepoId(body.repoId);
      if (!t.title && !t.content) {
        sendJson(res, 400, { error: '标题和内容至少填写一项' });
        return;
      }
      t.updatedAt = now();
      saveThoughts(list);
      sendJson(res, 200, { thought: t });
      return;
    }
    if (m && method === 'DELETE') {
      const list = loadThoughts();
      const next = list.filter((x) => x.id !== m[1]);
      if (next.length === list.length) {
        sendJson(res, 404, { error: '未找到该思想' });
        return;
      }
      saveThoughts(next);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE' && p === '/api/thoughts') {
      saveThoughts([]);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 对话 ---- */
    if (method === 'GET' && p === '/api/conversations') {
      sendJson(res, 200, { conversations: loadConversations() });
      return;
    }
    if (method === 'POST' && p === '/api/conversations') {
      const body = await readBody(req);
      const msgs = Array.isArray(body.messages)
        ? body.messages
            .filter((x) => x && (x.role === 'user' || x.role === 'assistant'))
            .map((x) => ({
              role: x.role,
              content: String(x.content || ''),
              usedThoughts: Array.isArray(x.usedThoughts) ? x.usedThoughts : [],
              ts: x.ts || now(),
            }))
        : [];
      const list = loadConversations();
      let conv;
      if (body.id) {
        conv = list.find((x) => x.id === body.id);
        if (conv) {
          conv.title = String(body.title || conv.title || '对话').slice(0, 60);
          conv.messages = msgs;
          conv.updatedAt = now();
        }
      }
      if (!conv) {
        conv = {
          id: body.id || uid(),
          title: String(body.title || '对话').slice(0, 60),
          messages: msgs,
          createdAt: now(),
          updatedAt: now(),
        };
        list.unshift(conv);
      }
      saveConversations(list);
      sendJson(res, 200, { id: conv.id });
      return;
    }
    m = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const list = loadConversations();
      const next = list.filter((x) => x.id !== m[1]);
      if (next.length === list.length) {
        sendJson(res, 404, { error: '未找到该对话' });
        return;
      }
      saveConversations(next);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 配置 ---- */
    if (method === 'GET' && p === '/api/config') {
      sendJson(res, 200, loadConfig());
      return;
    }
    if (method === 'PUT' && p === '/api/config') {
      const body = await readBody(req);
      const cfg = loadConfig();
      const keys = ['baseUrl', 'apiKey', 'model', 'userName', 'systemPrompt'];
      keys.forEach((k) => {
        if (typeof body[k] === 'string') cfg[k] = body[k].trim();
      });
      if (body.temperature !== undefined) {
        const t = Number(body.temperature);
        if (Number.isFinite(t)) cfg.temperature = Math.min(2, Math.max(0, t));
      }
      if (body.topK !== undefined) {
        const k = Number(body.topK);
        if (Number.isFinite(k)) cfg.topK = Math.min(20, Math.max(1, Math.round(k)));
      }
      if (body.port !== undefined) {
        const pt = Number(body.port);
        if (Number.isFinite(pt) && pt > 0 && pt < 65536) cfg.port = Math.round(pt);
      }
      saveConfig(cfg);
      sendJson(res, 200, loadConfig());
      return;
    }

    /* ---- AI 测试 ---- */
    if (method === 'POST' && p === '/api/test-ai') {
      await handleTestAI(res);
      return;
    }

    /* ---- 问答（SSE 流式）---- */
    if (method === 'POST' && p === '/api/ask') {
      const body = await readBody(req);
      await handleAsk(req, res, body);
      return;
    }

    /* ---- 文档导入 ---- */
    if (method === 'POST' && p === '/api/import-doc') {
      const body = await readBody(req, 64 * 1024 * 1024);
      handleImportDoc(res, body);
      return;
    }

    /* ---- 备份 ---- */
    if (method === 'GET' && p === '/api/export') {
      const cfg = loadConfig();
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const payload = {
        version: 2,
        app: '个人思想库',
        exportedAt: now(),
        repos: loadRepos(),
        thoughts: loadThoughts(),
        conversations: loadConversations(),
        config: Object.assign({}, cfg, { apiKey: cfg.apiKey ? '***' : '' }),
      };
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="thought-library-backup-${dateStr}.json"`,
      });
      res.end(body);
      return;
    }
    if (method === 'POST' && p === '/api/import') {
      const body = await readBody(req);
      let importedThoughts = 0;
      let importedConversations = 0;
      let importedRepos = 0;
      // 仓库合并（默认仓库始终保留）
      const repos = loadRepos();
      const reposByIdMap = new Map(repos.map((r) => [r.id, r]));
      if (Array.isArray(body.repos)) {
        for (const r of body.repos) {
          if (!r || typeof r !== 'object' || !r.id || r.id === 'default') continue;
          const id = String(r.id);
          const item = {
            id,
            name: String(r.name || '未命名仓库').slice(0, 30),
            description: String(r.description || '').slice(0, 200),
            createdAt: r.createdAt || now(),
            updatedAt: r.updatedAt || now(),
          };
          reposByIdMap.set(id, item);
          importedRepos++;
        }
        saveRepos(Array.from(reposByIdMap.values()));
      }
      if (Array.isArray(body.thoughts)) {
        const list = loadThoughts();
        const byId = new Map(list.map((x) => [x.id, x]));
        body.thoughts.forEach((t) => {
          if (!t || typeof t !== 'object') return;
          const id = t.id || uid();
          const item = {
            id,
            title: String(t.title || ''),
            content: String(t.content || ''),
            category: CATEGORIES.includes(t.category) ? t.category : '其他',
            importance: IMPORTANCE.includes(t.importance) ? t.importance : 'medium',
            tags: Array.isArray(t.tags) ? t.tags.map((x) => String(x)).filter(Boolean) : [],
            repoId: reposByIdMap.has(t.repoId) ? t.repoId : 'default',
            source: t.source === 'chat' ? 'chat' : t.source === 'import' ? 'import' : 'manual',
            createdAt: t.createdAt || now(),
            updatedAt: t.updatedAt || now(),
          };
          if (!item.title && !item.content) return;
          byId.set(id, item);
          importedThoughts++;
        });
        saveThoughts(Array.from(byId.values()));
      }
      if (Array.isArray(body.conversations)) {
        const list = loadConversations();
        const byId = new Map(list.map((x) => [x.id, x]));
        body.conversations.forEach((c) => {
          if (!c || typeof c !== 'object') return;
          const id = c.id || uid();
          byId.set(id, {
            id,
            title: String(c.title || '对话').slice(0, 60),
            messages: Array.isArray(c.messages)
              ? c.messages
                  .filter((x) => x && (x.role === 'user' || x.role === 'assistant'))
                  .map((x) => ({
                    role: x.role,
                    content: String(x.content || ''),
                    usedThoughts: Array.isArray(x.usedThoughts) ? x.usedThoughts : [],
                    ts: x.ts || now(),
                  }))
              : [],
            createdAt: c.createdAt || now(),
            updatedAt: c.updatedAt || now(),
          });
          importedConversations++;
        });
        saveConversations(Array.from(byId.values()));
      }
      sendJson(res, 200, { ok: true, importedThoughts, importedConversations, importedRepos });
      return;
    }

    /* ---- 学习模式 ---- */
    if (method === 'GET' && p === '/api/study/state') {
      const repos = (url.searchParams.get('repos') || '')
        .split(',')
        .filter((x) => x);
      const repoMap = reposById();
      const inScope = studyForRepo(repos);
      const studyMap = loadStudy();
      const list = inScope.map((t) => ({
        thought: { id: t.id, title: t.title, category: t.category, repoId: t.repoId },
        repoName: (repoMap.get(t.repoId) || {}).name || '默认仓库',
        state: studyMap[t.id] || study.emptyState(),
      }));
      list.sort((a, b) => {
        const need = (s) => (s.mastered ? 1000 : 0) + (s.totalAnswers ? 0 : 300) + s.survival + (s.weakness ? 100 : 0);
        return need(a.state) - need(b.state);
      });
      sendJson(res, 200, { points: list });
      return;
    }
    if (method === 'POST' && p === '/api/study/reset') {
      const body = await readBody(req);
      const studyMap = loadStudy();
      if (body.pointId && studyMap[body.pointId]) {
        delete studyMap[body.pointId];
        saveStudy(studyMap);
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && p === '/api/study/ask') {
      const body = await readBody(req);
      await handleStudyAsk(req, res, body);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

/* ------------------------------ 启动 ------------------------------ */

migrate();

const config = loadConfig();
const PORT = config.port || DEFAULT_CONFIG.port;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[提示] 端口 ${PORT} 已被占用——思想库可能已经在运行。`);
    console.error(`        直接访问 http://127.0.0.1:${PORT} 即可。\n`);
  } else {
    console.error('[错误]', err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================');
  console.log('  🧠 个人思想库 v2 已启动');
  console.log(`  网址:    http://127.0.0.1:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log('  关闭:    关闭本窗口，或运行「停止网站.bat」');
  console.log('============================================');
  if (!loadConfig().apiKey) {
    console.log('\n[提示] 尚未配置 AI 接口密钥，问答将使用演示模式。');
    console.log('       打开网站后，在「设置」中填写 API 密钥即可启用完整 AI 回答。\n');
  }
});
