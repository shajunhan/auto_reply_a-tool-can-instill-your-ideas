/* ============================================================
   个人思想库 v2 · 前端逻辑（多仓库 + 文档导入）
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const CATEGORIES = ['原则', '决策逻辑', '知识', '经验', '其他'];
const CATEGORY_HINTS = {
  原则: '记录你坚持的核心原则与价值观。例如：「诚实优先，宁可慢一点也不欺骗客户。」',
  决策逻辑: '记录你处理事情时的判断逻辑。建议格式：当遇到【情况】时，我倾向于【做法】，因为【原因】。可以分多条细化。',
  知识: '记录你掌握的知识、事实与专业结论，AI 回答时会优先作为依据。',
  经验: '记录你过往的经历、教训和验证过有效的方法。',
  其他: '其他想保存下来的想法。',
};

const state = {
  tab: 'library',
  thoughts: [],
  conversations: [],
  repos: [],
  config: null,
  currentConvId: null,
  messages: [],
  streaming: false,
  abortCtrl: null,
  editId: null,
  repoEditId: null,
  activeRepo: 'all', // 思想库页当前筛选的仓库
  chatRepos: [], // 问答时抽取的仓库（空 = 全部仓库）
  study: {
    repos: [], // 学习范围仓库（空 = 全部）
    messages: [], // 学习对话
    points: [], // 知识点与存活率列表
    streaming: false,
    abortCtrl: null,
    currentPointId: null,
    startedAt: 0,
  },
  filter: { q: '', category: '', importance: '' },
};

/* ------------------------------ 基础工具 ------------------------------ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg, type = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .4s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, ms);
}

function repoNameById(id) {
  const r = state.repos.find((x) => x.id === id);
  return (r && r.name) || '未分类';
}

/* ------------------------------ 简易 Markdown 渲染 ------------------------------ */

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(src) {
  const lines = String(src ?? '').split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let listBuf = [];
  let quoteBuf = [];
  const flushList = () => { if (listBuf.length) { html += '<ul>' + listBuf.join('') + '</ul>'; listBuf = []; } };
  const flushQuote = () => { if (quoteBuf.length) { html += '<blockquote>' + quoteBuf.join('<br/>') + '</blockquote>'; quoteBuf = []; } };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) { html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>'; codeBuf = []; inCode = false; }
      else { flushList(); flushQuote(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(esc(raw)); continue; }
    flushList(); flushQuote();
    const l = esc(raw);
    const hm = l.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { const lv = hm[1].length; html += `<h${lv}>${inline(hm[2])}</h${lv}>`; continue; }
    if (/^\s*[-*]\s+/.test(l)) { listBuf.push('<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
    if (/^\s*\d+\.\s+/.test(l)) { listBuf.push('<li>' + inline(l.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue; }
    if (/^\s*&gt;\s?/.test(l)) { quoteBuf.push(inline(l.replace(/^\s*&gt;\s?/, ''))); continue; }
    html += `<p>${inline(l) || '&nbsp;'}</p>`;
  }
  flushList(); flushQuote();
  if (inCode) { html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>'; }
  return html;
}

/* ------------------------------ API ------------------------------ */

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || '请求失败');
  return r.json();
}

async function apiSend(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || '请求失败');
  return r.json();
}

/* ------------------------------ 数据加载 ------------------------------ */

async function refreshThoughts() {
  const data = await apiGet('/api/thoughts');
  state.thoughts = data.thoughts || [];
  renderThoughts();
  updateCounts();
  renderRepoBar();
  if (!$('#repoManageModal').hidden) renderRepoManageList();
}

async function refreshConversations() {
  const data = await apiGet('/api/conversations');
  state.conversations = data.conversations || [];
  renderConvList();
}

async function loadRepos() {
  const data = await apiGet('/api/repos');
  state.repos = data.repos || [];
  // 清理失效的聊天仓库选择
  const ids = new Set(state.repos.map((r) => r.id));
  state.chatRepos = state.chatRepos.filter((id) => ids.has(id));
  persistChatRepos();
  renderRepoBar();
  renderRepoSelect();
  if (!$('#repoManageModal').hidden) renderRepoManageList();
}

function updateCounts() {
  const total = state.thoughts.length;
  $('#thoughtCount').textContent = total;
  const byCat = {};
  CATEGORIES.forEach((c) => (byCat[c] = 0));
  state.thoughts.forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + 1));
  $('#catStats').innerHTML = CATEGORIES.map(
    (c) => `<span class="cat-stat">${c} <b>${byCat[c] || 0}</b></span>`
  ).join('');
}

/* ------------------------------ 仓库 UI ------------------------------ */

function renderRepoBar() {
  const counts = {};
  state.thoughts.forEach((t) => { counts[t.repoId] = (counts[t.repoId] || 0) + 1; });
  $('#repoBar').innerHTML =
    `<button class="repo-chip ${state.activeRepo === 'all' ? 'active' : ''}" data-repo="all">📚 全部仓库 <b>${state.thoughts.length}</b></button>` +
    state.repos.map((r) =>
      `<button class="repo-chip ${state.activeRepo === r.id ? 'active' : ''}" data-repo="${r.id}" title="${esc(r.description || '')}">${esc(r.name)} <b>${counts[r.id] || 0}</b></button>`
    ).join('') +
    `<button class="repo-chip ghost" data-act="new-repo">＋ 新建仓库</button>` +
    `<button class="repo-chip ghost" data-act="manage-repo">⚙ 管理</button>`;
}

function renderRepoSelect() {
  const sel = state.chatRepos;
  $('#repoSelect').innerHTML =
    '<span class="rs-label">🧠 本次抽取仓库：</span>' +
    `<button class="chip rs-chip ${sel.length === 0 ? 'active' : ''}" data-repo="all">全部仓库</button>` +
    state.repos.map((r) =>
      `<button class="chip rs-chip ${sel.includes(r.id) ? 'active' : ''}" data-repo="${r.id}">${esc(r.name)}</button>`
    ).join('') +
    '<span class="rs-hint">未选择时使用全部仓库</span>';
}

function renderRepoManageList() {
  const counts = {};
  state.thoughts.forEach((t) => { counts[t.repoId] = (counts[t.repoId] || 0) + 1; });
  $('#repoManageList').innerHTML = state.repos.map((r) => `
    <div class="repo-manage-item">
      <div class="rm-info">
        <div class="rm-name">${esc(r.name)}${r.id === 'default' ? ' <span class="rm-tag">默认</span>' : ''}</div>
        <div class="rm-desc">${esc(r.description || '（无描述）')} · ${counts[r.id] || 0} 条思想</div>
      </div>
      <div class="rm-actions">
        <button class="link-btn" data-act="edit-repo" data-id="${r.id}">编辑</button>
        ${r.id === 'default' ? '' : `<button class="link-btn danger" data-act="del-repo" data-id="${r.id}">删除</button>`}
      </div>
    </div>`).join('') || '<p class="hint">还没有仓库</p>';
}

function openRepoModal(repo) {
  state.repoEditId = repo ? repo.id : null;
  $('#repoModalTitle').textContent = repo ? '编辑仓库' : '新建思想仓库';
  $('#rName').value = repo ? repo.name : '';
  $('#rDesc').value = repo ? (repo.description || '') : '';
  $('#repoModal').hidden = false;
  $('#rName').focus();
}

function closeRepoModal() {
  $('#repoModal').hidden = true;
  state.repoEditId = null;
}

async function saveRepo() {
  const name = $('#rName').value.trim();
  if (!name) { toast('仓库名称不能为空', 'error'); return; }
  const description = $('#rDesc').value.trim();
  try {
    if (state.repoEditId) await apiSend('/api/repos/' + state.repoEditId, 'PUT', { name, description });
    else await apiSend('/api/repos', 'POST', { name, description });
    toast('仓库已保存', 'ok');
    closeRepoModal();
    await loadRepos();
    await refreshThoughts();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

async function deleteRepo(id) {
  const r = state.repos.find((x) => x.id === id);
  if (!r) return;
  if (!confirm(`删除仓库「${r.name}」？其中的思想会自动移入「默认仓库」，不会丢失。`)) return;
  try {
    const res = await apiSend('/api/repos/' + id, 'DELETE');
    toast(`已删除仓库，${res.movedThoughts || 0} 条思想移入默认仓库`, 'ok');
    if (state.activeRepo === id) state.activeRepo = 'all';
    state.chatRepos = state.chatRepos.filter((x) => x !== id);
    persistChatRepos();
    await loadRepos();
    await refreshThoughts();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

function persistChatRepos() {
  try { localStorage.setItem('tl-chat-repos', JSON.stringify(state.chatRepos)); } catch {}
}

/* ------------------------------ 思想库渲染 ------------------------------ */

function catClass(c) { return CATEGORIES.includes(c) ? c : '其他'; }

function renderThoughts() {
  const { q, category, importance } = state.filter;
  const ql = q.toLowerCase();
  const list = state.thoughts.filter((t) => {
    if (state.activeRepo !== 'all' && t.repoId !== state.activeRepo) return false;
    if (category && t.category !== category) return false;
    if (importance && t.importance !== importance) return false;
    if (ql) {
      const hay = (t.title + ' ' + t.content + ' ' + (t.tags || []).join(' ') + ' ' + t.category).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
  const grid = $('#thoughtGrid');
  if (!list.length) { grid.innerHTML = ''; $('#libraryEmpty').hidden = false; return; }
  $('#libraryEmpty').hidden = true;
  grid.innerHTML = list.map((t) => `
    <article class="thought-card" data-id="${t.id}">
      <div class="card-top">
        <span class="badge repo-badge">${esc(repoNameById(t.repoId))}</span>
        <span class="badge cat-${catClass(t.category)}">${esc(t.category)}</span>
        ${t.importance === 'high' ? '<span class="imp">⭐</span>' : ''}
        <span class="card-time">${fmtDate(t.updatedAt || t.createdAt)}</span>
      </div>
      <h3 class="card-title">${esc(t.title)}</h3>
      <p class="card-body">${esc(t.content)}</p>
      ${(t.tags && t.tags.length) ? `<div class="tags">${t.tags.map((tg) => `<span class="tag">#${esc(tg)}</span>`).join('')}</div>` : ''}
      <div class="card-actions">
        <button class="link-btn" data-act="edit" data-id="${t.id}">编辑</button>
        <button class="link-btn danger" data-act="del" data-id="${t.id}">删除</button>
      </div>
    </article>`).join('');
}

/* ------------------------------ 思想编辑弹窗 ------------------------------ */

function fillRepoSelect() {
  $('#tRepo').innerHTML = state.repos.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
}

function openThoughtModal(thought) {
  state.editId = thought ? thought.id : null;
  $('#thoughtModalTitle').textContent = thought ? '编辑思想' : '记录思想';
  $('#tTitle').value = thought ? thought.title : '';
  $('#tContent').value = thought ? thought.content : '';
  $('#tCategory').value = thought ? thought.category : '决策逻辑';
  $('#tImportance').value = thought ? thought.importance : 'medium';
  $('#tTags').value = (thought && thought.tags) ? thought.tags.join(', ') : '';
  fillRepoSelect();
  $('#tRepo').value = thought ? thought.repoId : (state.activeRepo !== 'all' ? state.activeRepo : 'default');
  updateCategoryHint();
  $('#thoughtModal').hidden = false;
  $('#tTitle').focus();
}

function closeThoughtModal() {
  $('#thoughtModal').hidden = true;
  state.editId = null;
}

function updateCategoryHint() {
  $('#tCategoryHint').textContent = CATEGORY_HINTS[$('#tCategory').value] || '';
}

async function saveThought() {
  const title = $('#tTitle').value.trim();
  const content = $('#tContent').value.trim();
  if (!title && !content) { toast('标题和内容至少填写一项', 'error'); return; }
  const payload = {
    title,
    content,
    category: $('#tCategory').value,
    importance: $('#tImportance').value,
    tags: $('#tTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    repoId: $('#tRepo').value,
  };
  try {
    if (state.editId) await apiSend('/api/thoughts/' + state.editId, 'PUT', payload);
    else await apiSend('/api/thoughts', 'POST', payload);
    toast(state.editId ? '已更新' : '已保存到思想库', 'ok');
    closeThoughtModal();
    await refreshThoughts();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

async function deleteThought(id) {
  const t = state.thoughts.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`确定删除这条思想吗？\n「${t.title}」`)) return;
  try {
    await apiSend('/api/thoughts/' + id, 'DELETE');
    toast('已删除', 'ok');
    await refreshThoughts();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

/* ------------------------------ 文档导入 ------------------------------ */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });
}

async function handleImportDoc(file) {
  if (!file) return;
  toast('正在解析文档…');
  let b64;
  try {
    b64 = await fileToBase64(file);
  } catch (e) { toast('读取文件失败：' + e.message, 'error'); return; }
  try {
    const r = await apiSend('/api/import-doc', 'POST', { filename: file.name, dataBase64: b64 });
    const items = r.items || [];
    if (!items.length) { toast('没有提取到文字内容', 'error'); return; }
    if (items.length === 1) {
      // 单个文档：填入编辑弹窗，可预览修改后再保存
      if ($('#thoughtModal').hidden) openThoughtModal(null);
      $('#tTitle').value = items[0].title;
      $('#tContent').value = items[0].content;
      toast(`已提取「${items[0].title}」（${items[0].content.length} 字），可编辑后保存`, 'ok');
    } else {
      // zip 批量：确认后直接导入
      if (!confirm(`将把压缩包中的 ${items.length} 个文档作为 ${items.length} 条思想导入，确定？`)) return;
      const repoId = $('#thoughtModal').hidden
        ? (state.activeRepo !== 'all' ? state.activeRepo : 'default')
        : $('#tRepo').value;
      const res = await apiSend('/api/thoughts/batch', 'POST', {
        repoId,
        thoughts: items.map((it) => ({ title: it.title, content: it.content })),
      });
      toast(`已导入 ${res.added} 条思想`, 'ok');
      if (!$('#thoughtModal').hidden) closeThoughtModal();
      await refreshThoughts();
    }
  } catch (e) { toast('导入失败：' + e.message, 'error'); }
}

/* ------------------------------ 问答 ------------------------------ */

function scrollChat() {
  const body = $('#chatBody');
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

function pushMessage(m) { state.messages.push(m); }

function renderChat() {
  const list = $('#msgList');
  $('#chatWelcome').hidden = state.messages.length > 0;
  list.innerHTML = state.messages.map((m, i) => {
    if (m.role === 'user') {
      return `<div class="msg user">${esc(m.content)}</div>`;
    }
    const body = m.streaming
      ? renderMarkdown(m.content) + '<span class="cursor">▌</span>'
      : renderMarkdown(m.content);
    const refs = (m.usedThoughts && m.usedThoughts.length)
      ? `<span class="refs"><span class="refs-label">参考了思想：</span>${m.usedThoughts.map((id) => {
          const t = state.thoughts.find((x) => x.id === id);
          return t ? `<button class="chip ref-chip" data-thought="${id}" title="${esc(repoNameById(t.repoId))} · ${esc(t.category)}">${esc(t.title)}</button>` : '';
        }).join('')}</span>`
      : '';
    const learn = (!m.streaming && m.content && !m.mock)
      ? `<button class="link-btn learn-btn" data-learn="${i}">📥 存入思想库</button>`
      : '';
    return `<div class="msg ai">
      <div class="msg-head"><span class="avatar">🧠</span><span class="who">思维分身</span></div>
      <div class="msg-body">${body}</div>
      <div class="msg-foot">${refs}${learn}</div>
    </div>`;
  }).join('');
  scrollChat();
}

async function ask() {
  const input = $('#chatInput');
  const q = input.value.trim();
  if (!q || state.streaming) return;
  input.value = '';
  autoGrow();

  pushMessage({ role: 'user', content: q, ts: Date.now() });
  const ai = { role: 'assistant', content: '', ts: Date.now(), streaming: true, usedThoughts: [], mock: false };
  pushMessage(ai);
  renderChat();
  setStreamingUI(true);

  const history = state.messages.slice(0, -2).map((m) => ({ role: m.role, content: m.content })).slice(-8);
  const ctrl = new AbortController();
  state.abortCtrl = ctrl;

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, history, repos: state.chatRepos }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      ai.content = '⚠️ ' + (j.error || '请求失败');
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let evt = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              let d;
              try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
              if (evt === 'delta') ai.content += d.text || '';
              else if (evt === 'done') { ai.usedThoughts = d.usedThoughts || []; ai.mock = !!d.mock; }
              else if (evt === 'error') ai.content += '\n\n> ⚠️ ' + (d.message || 'AI 调用失败');
            }
          }
          renderChat();
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') ai.content += '\n\n> ⚠️ 网络错误：' + e.message;
  }

  ai.streaming = false;
  setStreamingUI(false);
  state.abortCtrl = null;
  renderChat();
  await persistConversation();
}

function setStreamingUI(on) {
  state.streaming = on;
  $('#btnSend').hidden = on;
  $('#btnStop').hidden = !on;
  $('#chatInput').disabled = on;
}

async function persistConversation() {
  if (!state.messages.length) return;
  const first = state.messages[0];
  const title = (first.role === 'user' ? first.content : '对话').slice(0, 24);
  const payload = {
    id: state.currentConvId || undefined,
    title,
    messages: state.messages.map((m) => ({
      role: m.role,
      content: m.content,
      usedThoughts: m.usedThoughts || [],
      ts: m.ts,
    })),
  };
  try {
    const saved = await apiSend('/api/conversations', 'POST', payload);
    state.currentConvId = saved.id;
    await refreshConversations();
  } catch (e) { /* 静默 */ }
}

function newConversation() {
  state.messages = [];
  state.currentConvId = null;
  renderChat();
  $('#chatInput').focus();
}

function loadConversation(id) {
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  state.currentConvId = id;
  state.messages = (c.messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    usedThoughts: m.usedThoughts || [],
    ts: m.ts,
    streaming: false,
    mock: false,
  }));
  renderChat();
  switchTab('chat');
}

async function deleteCurrentConversation() {
  if (!state.currentConvId) { toast('当前没有对话'); return; }
  if (!confirm('删除当前对话？')) return;
  try {
    await apiSend('/api/conversations/' + state.currentConvId, 'DELETE');
    newConversation();
    await refreshConversations();
    toast('对话已删除', 'ok');
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

function renderConvList() {
  const el = $('#convList');
  if (!state.conversations.length) {
    el.innerHTML = '<div class="conv-item" style="opacity:.6">暂无对话</div>';
    return;
  }
  el.innerHTML = state.conversations.slice(0, 12).map((c) => `
    <button class="conv-item ${c.id === state.currentConvId ? 'active' : ''}" data-conv="${c.id}">
      <span class="ci-title">${esc(c.title)}</span>
      <span class="ci-time">${fmtDate(c.updatedAt)}</span>
    </button>`).join('');
}

/* ------------------------------ 问答 → 存入思想库 ------------------------------ */

function learnFromChat(msgIndex) {
  const aiMsg = state.messages[msgIndex];
  if (!aiMsg || aiMsg.role !== 'assistant') return;
  let question = '';
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (state.messages[i].role === 'user') { question = state.messages[i].content; break; }
  }
  const title = question.slice(0, 20) || aiMsg.content.slice(0, 20);
  const content = `【我的问题】${question}\n【我的思维分身给出的回答】\n${aiMsg.content.replace(/\n*【思考路径】[\s\S]*$/, '')}`;
  openThoughtModal(null);
  $('#tTitle').value = title;
  $('#tContent').value = content.trim();
  $('#tCategory').value = '经验';
  $('#tRepo').value = state.activeRepo !== 'all' ? state.activeRepo : 'default';
  $('#tTags').value = '';
  $('#thoughtModalTitle').textContent = '把这次问答存入思想库';
  $('#tTitle').focus();
}

/* ------------------------------ 设置 ------------------------------ */

function fillSettingsForm() {
  if (!state.config) return;
  $('#cfgBaseUrl').value = state.config.baseUrl || '';
  $('#cfgApiKey').value = state.config.apiKey || '';
  $('#cfgModel').value = state.config.model || '';
  $('#cfgTemperature').value = state.config.temperature ?? 0.7;
  $('#cfgTopK').value = state.config.topK ?? 8;
  $('#cfgUserName').value = state.config.userName || '我';
  $('#cfgSystemPrompt').value = state.config.systemPrompt || '';
}

async function saveSettings() {
  const payload = {
    baseUrl: $('#cfgBaseUrl').value.trim(),
    apiKey: $('#cfgApiKey').value.trim(),
    model: $('#cfgModel').value.trim(),
    temperature: Number($('#cfgTemperature').value),
    topK: Number($('#cfgTopK').value),
    userName: $('#cfgUserName').value.trim() || '我',
    systemPrompt: $('#cfgSystemPrompt').value,
  };
  try {
    state.config = await apiSend('/api/config', 'PUT', payload);
    toast('设置已保存', 'ok');
    $('#cfgSavedHint').hidden = false;
    setTimeout(() => { $('#cfgSavedHint').hidden = true; }, 3000);
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

async function testAI() {
  const btn = $('#btnTestAI');
  const out = $('#testResult');
  out.textContent = '正在测试…';
  out.className = 'test-result';
  btn.disabled = true;
  try {
    const r = await apiSend('/api/test-ai', 'POST', {});
    if (r.ok) { out.textContent = '✅ 连接成功：' + (r.reply || ''); }
    else { out.textContent = '❌ ' + (r.error || '连接失败'); out.className = 'test-result err'; }
  } catch (e) { out.textContent = '❌ ' + e.message; out.className = 'test-result err'; }
  btn.disabled = false;
}

async function refreshStats() {
  try {
    const s = await apiGet('/api/stats');
    $('#statList').innerHTML = `
      <div class="stat-item"><div class="n">${s.repos ? s.repos.length : 0}</div><div class="k">个仓库</div></div>
      <div class="stat-item"><div class="n">${s.thoughts}</div><div class="k">条思想</div></div>
      <div class="stat-item"><div class="n">${s.conversations}</div><div class="k">段对话</div></div>
      <div class="stat-item"><div class="n">💾</div><div class="k">${esc(s.dataDir)}</div></div>`;
  } catch (e) { /* 忽略 */ }
}

/* ------------------------------ 备份 ------------------------------ */

function doExport() {
  window.location.href = '/api/export';
  toast('备份文件已开始下载', 'ok');
}

function doImport() { $('#importFile').click(); }

async function handleImportFile(file) {
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { toast('备份文件不是有效的 JSON', 'error'); return; }
  if (!Array.isArray(data.thoughts) && !Array.isArray(data.conversations)) {
    toast('备份文件中没有可导入的数据', 'error');
    return;
  }
  try {
    const r = await apiSend('/api/import', 'POST', {
      repos: data.repos || [],
      thoughts: data.thoughts || [],
      conversations: data.conversations || [],
    });
    toast(`导入完成：仓库 ${r.importedRepos} 个，思想 ${r.importedThoughts} 条，对话 ${r.importedConversations} 段`, 'ok');
    await loadRepos();
    await refreshThoughts();
    await refreshConversations();
    await refreshStats();
  } catch (e) { toast('导入失败：' + e.message, 'error'); }
}

async function clearAll() {
  if (!state.thoughts.length) { toast('思想库已经是空的'); return; }
  if (!confirm('确定清空全部思想吗？此操作不可恢复！建议先导出备份。')) return;
  try {
    await apiSend('/api/thoughts', 'DELETE');
    toast('已清空思想库', 'ok');
    await refreshThoughts();
    await refreshStats();
  } catch (e) { toast('清空失败：' + e.message, 'error'); }
}

/* ------------------------------ 页面切换 / 主题 ------------------------------ */

function switchTab(tab) {
  state.tab = tab;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'chat') { $('#chatInput').focus(); }
  if (tab === 'study') { loadStudyState(); $('#studyInput').focus(); }
  if (tab === 'settings') { refreshStats(); }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').textContent = theme === 'dark' ? '☀️ 日间模式' : '🌙 夜间模式';
  localStorage.setItem('tl-theme', theme);
}

function autoGrow() {
  const ta = $('#chatInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  // 导航
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#themeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  // 仓库条（思想库）
  $('#repoBar').addEventListener('click', (e) => {
    const repoBtn = e.target.closest('[data-repo]');
    if (repoBtn) {
      state.activeRepo = repoBtn.dataset.repo;
      renderRepoBar();
      renderThoughts();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'new-repo') openRepoModal(null);
    if (act.dataset.act === 'manage-repo') { renderRepoManageList(); $('#repoManageModal').hidden = false; }
  });

  // 仓库管理弹窗
  $('#repoManageList').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'edit-repo') {
      const repo = state.repos.find((r) => r.id === act.dataset.id);
      if (repo) openRepoModal(repo);
    }
    if (act.dataset.act === 'del-repo') deleteRepo(act.dataset.id);
  });
  $('#btnNewRepoInManage').addEventListener('click', () => openRepoModal(null));
  $('#btnCloseRepoManage').addEventListener('click', () => { $('#repoManageModal').hidden = true; });

  // 仓库弹窗
  $('#btnSaveRepo').addEventListener('click', saveRepo);
  $('#btnCancelRepo').addEventListener('click', closeRepoModal);
  $('#repoModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeRepoModal(); });

  // 问答仓库选择
  $('#repoSelect').addEventListener('click', (e) => {
    const b = e.target.closest('[data-repo]');
    if (!b) return;
    if (b.dataset.repo === 'all') state.chatRepos = [];
    else {
      const id = b.dataset.repo;
      const i = state.chatRepos.indexOf(id);
      if (i >= 0) state.chatRepos.splice(i, 1);
      else state.chatRepos.push(id);
    }
    persistChatRepos();
    renderRepoSelect();
  });

  // 思想库
  $('#btnNewThought').addEventListener('click', () => openThoughtModal(null));
  $('#btnSaveThought').addEventListener('click', saveThought);
  $('#btnCancelThought').addEventListener('click', closeThoughtModal);
  $('#thoughtModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeThoughtModal(); });
  $('#tCategory').addEventListener('change', updateCategoryHint);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#thoughtModal').hidden) closeThoughtModal();
    if (e.key === 'Escape' && !$('#repoModal').hidden) closeRepoModal();
  });

  $('#searchInput').addEventListener('input', (e) => {
    state.filter.q = e.target.value.trim();
    renderThoughts();
  });
  $('#categoryFilter').addEventListener('change', (e) => { state.filter.category = e.target.value; renderThoughts(); });
  $('#importanceFilter').addEventListener('change', (e) => { state.filter.importance = e.target.value; renderThoughts(); });

  // 卡片事件（委托）
  $('#thoughtGrid').addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      e.stopPropagation();
      if (actBtn.dataset.act === 'edit') openThoughtModal(state.thoughts.find((t) => t.id === actBtn.dataset.id));
      else if (actBtn.dataset.act === 'del') deleteThought(actBtn.dataset.id);
      return;
    }
    const card = e.target.closest('.thought-card');
    if (card) openThoughtModal(state.thoughts.find((t) => t.id === card.dataset.id));
  });

  // 问答
  $('#btnSend').addEventListener('click', ask);
  $('#btnStop').addEventListener('click', () => { if (state.abortCtrl) state.abortCtrl.abort(); });
  $('#btnNewConv').addEventListener('click', newConversation);
  $('#btnDelConv').addEventListener('click', deleteCurrentConversation);
  $('#chatInput').addEventListener('input', autoGrow);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask();
    }
  });
  $('#welcomeSamples').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { $('#chatInput').value = chip.textContent.trim(); autoGrow(); ask(); }
  });

  // 消息区事件（委托）
  $('#msgList').addEventListener('click', (e) => {
    const ref = e.target.closest('[data-thought]');
    if (ref) {
      const t = state.thoughts.find((x) => x.id === ref.dataset.thought);
      if (t) { switchTab('library'); openThoughtModal(t); }
      return;
    }
    const learn = e.target.closest('[data-learn]');
    if (learn) learnFromChat(Number(learn.dataset.learn));
  });

  // 对话列表
  $('#convList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-conv]');
    if (item) loadConversation(item.dataset.conv);
  });

  // 设置
  $('#btnSaveCfg').addEventListener('click', saveSettings);
  $('#btnTestAI').addEventListener('click', testAI);
  $('#btnToggleKey').addEventListener('click', () => {
    const inp = $('#cfgApiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('#btnToggleKey').textContent = inp.type === 'password' ? '显示' : '隐藏';
  });

  // 备份
  $('#btnExport').addEventListener('click', doExport);
  $('#btnExport2').addEventListener('click', doExport);
  $('#btnImport').addEventListener('click', doImport);
  $('#btnImport2').addEventListener('click', doImport);
  $('#importFile').addEventListener('change', (e) => {
    handleImportFile(e.target.files[0]);
    e.target.value = '';
  });

  // 文档导入
  $('#btnImportDoc').addEventListener('click', () => $('#importDocFile').click());
  $('#btnModalImportDoc').addEventListener('click', () => $('#importDocFile').click());
  $('#importDocFile').addEventListener('change', (e) => {
    handleImportDoc(e.target.files[0]);
    e.target.value = '';
  });

  // 学习模式
  $('#studyRepoSelect').addEventListener('click', (e) => {
    const b = e.target.closest('[data-repo]');
    if (!b) return;
    if (b.dataset.repo === 'all') state.study.repos = [];
    else {
      const id = b.dataset.repo;
      const i = state.study.repos.indexOf(id);
      if (i >= 0) state.study.repos.splice(i, 1);
      else state.study.repos.push(id);
    }
    try { localStorage.setItem('tl-study-repos', JSON.stringify(state.study.repos)); } catch {}
    renderStudyRepoSelect();
    loadStudyState();
  });
  $('#btnStudyStart').addEventListener('click', studyStart);
  $('#studyWelcome').addEventListener('click', (e) => {
    if (e.target.closest('[data-study-start]')) studyStart();
  });
  $('#btnStudyHint').addEventListener('click', () => studySend('', 'hint'));
  $('#btnStudySubtitle').addEventListener('click', () => studySend('', 'correct-subtitle'));
  $('#btnStudyEnd').addEventListener('click', () => studySend('', 'end'));
  $('#btnStudySend').addEventListener('click', studySubmit);
  $('#btnStudyStop').addEventListener('click', () => { if (state.study.abortCtrl) state.study.abortCtrl.abort(); });
  $('#studyInput').addEventListener('input', studyAutoGrow);
  $('#studyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      studySubmit();
    }
  });
  $('#studyList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-point]');
    if (b) {
      if (state.study.streaming) { toast('请先等待当前回合结束'); return; }
      state.study.currentPointId = b.dataset.point;
      state.study.messages = [];
      renderStudyCurrent();
      renderStudyMessages();
      studyStart(false);
    }
    const reset = e.target.closest('[data-reset]');
    if (reset) studyResetPoint(reset.dataset.reset);
  });
  $('#studyCurrent').addEventListener('click', (e) => {
    const reset = e.target.closest('[data-reset]');
    if (reset) studyResetPoint(reset.dataset.reset);
  });
  $('#btnStudyRefresh').addEventListener('click', loadStudyState);

  // 清空
  $('#btnClearAll').addEventListener('click', clearAll);
}

/* ------------------------------ 学习模式 ------------------------------ */

function studyAutoGrow() {
  const ta = $('#studyInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
}

function scrollStudyChat() {
  const body = $('#studyChatBody');
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

function renderStudyRepoSelect() {
  const sel = state.study.repos;
  $('#studyRepoSelect').innerHTML =
    `<button class="chip rs-chip ${sel.length === 0 ? 'active' : ''}" data-repo="all">全部仓库</button>` +
    state.repos.map((r) =>
      `<button class="chip rs-chip ${sel.includes(r.id) ? 'active' : ''}" data-repo="${r.id}">${esc(r.name)}</button>`
    ).join('');
}

async function loadStudyState() {
  const reposQ = encodeURIComponent(state.study.repos.join(','));
  try {
    const d = await apiGet('/api/study/state?repos=' + reposQ);
    state.study.points = d.points || [];
  } catch (e) {
    state.study.points = [];
  }
  renderStudyList();
  renderStudyCurrent();
}

function renderStudyList() {
  const list = state.study.points;
  $('#studyListNote').textContent = list.length ? `共 ${list.length} 个知识点` : '';
  const el = $('#studyList');
  if (!list.length) {
    el.innerHTML = '<p class="hint" style="padding:8px">该范围暂无知识点，请先到「思想库」录入或导入内容。</p>';
    return;
  }
  el.innerHTML = list.map((p) => {
    const s = p.state;
    const flags = s.mastered
      ? '<span class="badge st-mastered">已掌握</span>'
      : s.weakness
        ? '<span class="badge st-weak">薄弱</span>'
        : s.totalAnswers
          ? '<span class="badge st-normal">学习中</span>'
          : '<span class="badge st-new">未学</span>';
    const active = p.thought.id === state.study.currentPointId ? ' active' : '';
    return `
      <div class="study-item${active}" data-point="${p.thought.id}" title="点击开始学习此知识点（${esc(p.repoName)}）">
        <div class="si-row">
          <span class="si-title">${esc(p.thought.title)}</span>${flags}
        </div>
        <div class="si-sub">${esc(p.repoName)} · 对 ${s.correctCount} / 错 ${s.wrongCount} · 连续对 ${s.streak}</div>
        <div class="si-bar"><span class="si-fill" style="width:${s.survival}%"></span></div>
        <div class="si-score">存活率 <b>${s.survival}</b>%${s.mastered ? ' · 3天后再复习' : s.weakness ? ' · 1小时后复习' : s.totalAnswers ? ' · 1天后复习' : ''}</div>
      </div>`;
  }).join('');
}

function renderStudyCurrent() {
  const el = $('#studyCurrent');
  if (!state.study.currentPointId) {
    el.innerHTML = '<p class="hint">点击「▶ 开始学习」由教练挑选，或点击下方知识点列表中的某一项。</p>';
    return;
  }
  const p = state.study.points.find((x) => x.thought.id === state.study.currentPointId);
  if (!p) {
    el.innerHTML = '<p class="hint">当前知识点不在学习范围内，请调整仓库范围。</p>';
    return;
  }
  const s = p.state;
  const flag = s.mastered ? '已掌握' : s.weakness ? '薄弱' : s.totalAnswers ? '学习中' : '未学';
  el.innerHTML = `
    <div class="st-current">
      <div class="st-current-title">${esc(p.thought.title)}</div>
      <div class="st-current-sub">${esc(p.repoName)} · ${esc(p.thought.category)} · ${flag}</div>
      <div class="si-bar big"><span class="si-fill" style="width:${s.survival}%"></span></div>
      <div class="st-current-score">存活率 <b>${s.survival}</b>%　答对 ${s.correctCount} / 答错 ${s.wrongCount}　连续对 ${s.streak}</div>
      <button class="link-btn danger" data-reset="${p.thought.id}">重置此知识点</button>
    </div>`;
}

function renderStudyMessages() {
  const list = $('#studyMsgList');
  $('#studyWelcome').hidden = state.study.messages.length > 0;
  list.innerHTML = state.study.messages.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${esc(m.content)}</div>`;
    const body = m.streaming
      ? renderMarkdown(m.content) + '<span class="cursor">▌</span>'
      : renderMarkdown(m.content);
    return `<div class="msg ai"><div class="msg-head"><span class="avatar">🎓</span><span class="who">学习教练</span></div><div class="msg-body">${body}</div></div>`;
  }).join('');
  scrollStudyChat();
}

function setStudyStreamingUI(on) {
  state.study.streaming = on;
  $('#btnStudySend').hidden = on;
  $('#btnStudyStop').hidden = !on;
  $('#studyInput').disabled = on;
}

function studyStart(clear) {
  if (clear === undefined) clear = true;
  if (state.study.streaming) { toast('请先等待当前回合结束'); return; }
  if (clear) {
    state.study.messages = [];
    state.study.currentPointId = null;
    state.study.startedAt = Date.now();
    renderStudyCurrent();
    renderStudyMessages();
  } else if (!state.study.startedAt) {
    state.study.startedAt = Date.now();
  }
  studySend('开始学习，请出第一道题', 'ask');
}

function studySubmit() {
  const input = $('#studyInput');
  const q = input.value.trim();
  if (!q || state.study.streaming) return;
  input.value = '';
  studyAutoGrow();
  studySend(q, 'ask');
}

async function studySend(text, action) {
  if (state.study.streaming) { toast('正在处理上一回合'); return; }
  const content = String(text || '').trim();
  if (action === 'ask' && !content) { toast('请输入内容'); return; }

  const userLabel =
    action === 'ask' ? content
      : action === 'hint' ? '💡 给我提示'
        : action === 'correct-subtitle' ? '📺 纠正字幕错误'
          : '🏁 结束学习';
  state.study.messages.push({ role: 'user', content: userLabel });
  const ai = { role: 'assistant', content: '', streaming: true };
  state.study.messages.push(ai);
  renderStudyMessages();
  setStudyStreamingUI(true);

  const history = state.study.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  const ctrl = new AbortController();
  state.study.abortCtrl = ctrl;

  const payload = {
    repos: state.study.repos,
    pointId: state.study.currentPointId || '',
    action,
    question: action === 'ask' ? content : action,
    history,
    startedAt: state.study.startedAt,
  };

  let doneData = null;
  let reportData = null;
  try {
    const res = await fetch('/api/study/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      ai.content = '⚠️ ' + (j.error || '请求失败');
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let evt = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              let d;
              try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
              if (evt === 'delta') ai.content += d.text || '';
              else if (evt === 'done') doneData = d;
              else if (evt === 'report') reportData = d;
              else if (evt === 'error') ai.content += '\n\n> ⚠️ ' + (d.message || 'AI 调用失败');
            }
          }
          renderStudyMessages();
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') ai.content += '\n\n> ⚠️ 网络错误：' + e.message;
  }

  if (doneData) {
    if (typeof doneData.clean === 'string' && doneData.clean) ai.content = doneData.clean;
    if (doneData.point) state.study.currentPointId = doneData.point;
    if (doneData.verdict && doneData.state) {
      const v = doneData.verdict;
      const delta = v === 'correct' ? '+20' : '-30';
      toast(`判定：${v === 'correct' ? '答对 ✅' : '答错 ❌'} ${delta} → 存活率 ${doneData.state.survival}%`, v === 'correct' ? 'ok' : 'error');
    }
  }
  if (reportData) {
    const mins = Math.round((reportData.durationMs || 0) / 60000);
    toast(
      `📊 学习报告：${mins} 分钟 · ${reportData.points} 个知识点 · 平均存活率 ${reportData.avgSurvival}% · 已掌握 ${reportData.masteredCount} · 薄弱 ${reportData.weakPoints ? reportData.weakPoints.length : 0}`,
      'ok', 8000
    );
  }

  ai.streaming = false;
  setStudyStreamingUI(false);
  state.study.abortCtrl = null;
  renderStudyMessages();
  await loadStudyState();
}

async function studyResetPoint(id) {
  if (!confirm('重置该知识点的存活率与答题记录？')) return;
  try {
    await apiSend('/api/study/reset', 'POST', { pointId: id });
    toast('已重置', 'ok');
    await loadStudyState();
  } catch (e) { toast('重置失败：' + e.message, 'error'); }
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  bindEvents();
  applyTheme(localStorage.getItem('tl-theme') || 'light');
  try {
    state.chatRepos = JSON.parse(localStorage.getItem('tl-chat-repos') || '[]');
  } catch { state.chatRepos = []; }
  try {
    state.study.repos = JSON.parse(localStorage.getItem('tl-study-repos') || '[]');
  } catch { state.study.repos = []; }
  try { state.config = await apiGet('/api/config'); } catch { /* 忽略 */ }
  fillSettingsForm();
  try {
    await loadRepos();
    await refreshThoughts();
    await refreshConversations();
  } catch (e) {
    toast('数据加载失败：' + e.message, 'error');
  }
  renderStudyRepoSelect();
  renderChat();
  renderStudyMessages();
  loadStudyState();
}

init();
