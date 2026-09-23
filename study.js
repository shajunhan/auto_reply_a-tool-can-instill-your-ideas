/**
 * 学习模式 · 纯逻辑模块（与服务器解耦，便于单测）
 *
 * 存活率规则：
 *  - 初始存活率 0
 *  - 答对 1 次 +20 分；连续答对 3 次达到 100 分 → 标记「已掌握」
 *  - 答错 1 次 -30 分；存活率 < 60 → 「薄弱点」，进入高频复习队列（每 1 小时复习 1 次）
 *  - 已掌握 → 每 3 天复习 1 次
 *  - 其余 → 每 1 天复习 1 次
 */
'use strict';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

function emptyState() {
  return {
    survival: 0,
    streak: 0,
    mastered: false,
    weakness: true, // 初始存活率 0 < 60，视为薄弱
    lastReview: null,
    nextReview: null, // null = 立即到期
    totalAnswers: 0,
    correctCount: 0,
    wrongCount: 0,
    lastVerdict: null,
    updatedAt: null,
  };
}

function loadOrInitState(study, id) {
  if (!study[id]) study[id] = emptyState();
  return study[id];
}

/** 根据对错更新存活率；correct 为布尔。返回更新后的 state。 */
function applyVerdict(state, correct) {
  if (correct) {
    state.streak += 1;
    state.survival = Math.min(100, state.survival + 20);
    if (state.streak >= 3) state.survival = 100; // 连续答对 3 次达到 100
    if (state.survival >= 100) state.mastered = true;
    state.correctCount += 1;
  } else {
    state.survival = Math.max(0, state.survival - 30);
    state.streak = 0;
    state.mastered = false;
    state.wrongCount += 1;
  }
  state.totalAnswers += 1;
  state.weakness = state.survival < 60;
  state.lastVerdict = correct ? 'correct' : 'wrong';
  state.lastReview = new Date().toISOString();
  state.updatedAt = state.lastReview;
  if (state.mastered) state.nextReview = new Date(Date.now() + 3 * DAY_MS).toISOString();
  else if (state.weakness) state.nextReview = new Date(Date.now() + 1 * HOUR_MS).toISOString();
  else state.nextReview = new Date(Date.now() + 1 * DAY_MS).toISOString();
  return state;
}

/** 是否到期（需要复习） */
function isDue(state) {
  if (!state || !state.nextReview) return true;
  return Date.now() >= new Date(state.nextReview).getTime();
}

/**
 * 挑选最该学习的知识点。
 * 优先级：未掌握 > 到期 > 从未学过 > 薄弱点 > 存活率低。
 * @param {Array} thoughts 知识点（思想）数组
 * @param {Object} study 存活率 map
 * @returns 单个 thought 或 null
 */
function pickStudyPoint(thoughts, study) {
  if (!thoughts || !thoughts.length) return null;
  const scored = thoughts.map((t) => {
    const st = study[t.id] || emptyState();
    let priority = 0;
    if (st.mastered) priority += 1000; // 已掌握的最后学
    if (isDue(st)) priority -= 200; // 到期优先
    else priority += 500;
    if (!st.totalAnswers) priority -= 300; // 从未学过优先
    if (st.weakness) priority -= 100; // 薄弱点高频
    priority += st.survival; // 存活率低优先
    return { t, priority };
  });
  scored.sort((a, b) => a.priority - b.priority);
  return scored[0].t;
}

/** 从 AI 回复中解析判定；找不到或解析失败返回 null（宽松：可在任意位置） */
function parseStudyMeta(text) {
  const s = String(text || '');
  // 1) 包装形式《STUDY_META》{...}《/STUDY_META》
  const w = s.match(/《STUDY_META》([\s\S]*?)《\/STUDY_META》/);
  if (w) {
    try {
      const j = JSON.parse(w[1].trim());
      if (j && typeof j === 'object' && (j.verdict === 'correct' || j.verdict === 'wrong')) return j;
    } catch {}
  }
  // 2) 宽松：在任意位置找含 verdict 的 JSON 对象
  const re = /{([^{}]*)}/g;
  let m;
  while ((m = re.exec(s))) {
    try {
      const j = JSON.parse('{' + m[1] + '}');
      if (j && (j.verdict === 'correct' || j.verdict === 'wrong')) return j;
    } catch {}
  }
  return null;
}

/** 去掉 AI 回复中的判定块 */
function stripStudyMeta(text) {
  return String(text || '').replace(/《STUDY_META》[\s\S]*?《\/STUDY_META》/g, '').trim();
}

function addDaysIso(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function addHoursIso(hours) {
  return new Date(Date.now() + hours * HOUR_MS).toISOString();
}

module.exports = {
  emptyState,
  loadOrInitState,
  applyVerdict,
  isDue,
  pickStudyPoint,
  parseStudyMeta,
  stripStudyMeta,
  addDaysIso,
  addHoursIso,
};
