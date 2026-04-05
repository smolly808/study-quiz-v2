// =============================================
//  Quiz App Logic
//  Version: Ver.2026.04.01_v6
//  更新内容: goHome()のloadProgress()除去（高速化）、バージョン情報追加
// =============================================

let allQuestions            = [];
let progressMap             = {};
let filterMap               = {};   // populateFilters で構築、goHome で再利用
let sessionQs               = [];
let currentIdx              = 0;
let sessionResults          = [];
let answered                = false;
let audioCtx                = null;
let currentUser             = null;  // { key, name, icon }
let preSessionMilestonesMap = {};    // お祝いチェック用スナップショット
let celebrationResolve      = null;  // お祝いPromiseのresolve
let consecutiveCorrect        = 0;     // 連続正解数
let streakTimer               = null;  // 連続正解オーバーレイの自動閉じタイマー
let isRecommendedTrialSession = false; // おすすめトライアルで開始したか
let recommendedTrialMode      = '';    // おすすめトライアルの出題モード
let recommendedTrialSubject   = '';    // おすすめトライアルで選択した教科
let sessionCompleted          = false; // 結果画面まで到達したか
let sessionAccuracy           = 0;    // セッションの正答率(%)
let currentSessionMode        = '';   // 現在のセッションの出題モード
let retryStartIdx             = -1;   // 再出題ラウンド開始インデックス（-1=未追加）
let isGeniusTrialSession      = false; // 秀才モードか否か
let geniusAnsweredIds         = new Set(); // 秀才モード：進捗記録済みのID

// ---- コイン2倍チャンス ----
function getCoinDouble() {
  try {
    const active  = localStorage.getItem('quiz_coinDouble_active') === 'true';
    const expiry  = Number(localStorage.getItem('quiz_coinDouble_expiry') || 0);
    if (active && Date.now() < expiry) return { active: true, expiry };
  } catch(e) {}
  return { active: false, expiry: 0 };
}
function setCoinDouble(active) {
  try {
    if (active) {
      const expiry = Date.now() + 15 * 60 * 1000;
      localStorage.setItem('quiz_coinDouble_active', 'true');
      localStorage.setItem('quiz_coinDouble_expiry', String(expiry));
    } else {
      localStorage.removeItem('quiz_coinDouble_active');
      localStorage.removeItem('quiz_coinDouble_expiry');
    }
  } catch(e) {}
}

// ---- ライフ・コインデータ管理（Google Sheets + localStorage キャッシュ）----
const _udCache = {};  // メモリキャッシュ { [key]: {lives,coins,lastTrialDate,lastLoginDate} }

// JST（日本時間）の現在時刻をISO形式で返す
function nowJST() {
  const d   = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// GAS からユーザーデータを取得してキャッシュに保存
async function loadUserDataFromSheet(key) {
  try {
    const json = await apiFetch({ action: 'getUserData', user: key });
    if (json.ok && json.data) {
      const d = json.data;
      _udCache[key] = {
        lives:            typeof d.lives === 'number' ? d.lives : 3,
        coins:            typeof d.coins === 'number' ? d.coins : 0,
        lastTrialDate:    d.lastTrialDate    || null,
        lastLoginDate:    d.lastLoginDate    || null,
        lastTrialSubject: d.lastTrialSubject || null,
        accuracyStage:    typeof d.accuracyStage === 'number' ? d.accuracyStage : 0,
        trialCount:       typeof d.trialCount === 'number' ? d.trialCount : 0,
      };
      try { localStorage.setItem('quiz_userdata_' + key, JSON.stringify(_udCache[key])); } catch(e) {}
      return;
    }
  } catch(e) {}
  // フォールバック: localStorage から読み込む
  _udCache[key] = _getUserDataLocal(key);
}

// localStorage から読み込む（内部用）
function _getUserDataLocal(key) {
  try {
    const raw = localStorage.getItem('quiz_userdata_' + key);
    const d   = raw ? JSON.parse(raw) : {};
    return {
      lives:            typeof d.lives === 'number' ? d.lives : 3,
      coins:            typeof d.coins === 'number' ? d.coins : 0,
      lastTrialDate:    d.lastTrialDate    || null,
      lastLoginDate:    d.lastLoginDate    || null,
      lastTrialSubject: d.lastTrialSubject || null,
      accuracyStage:    typeof d.accuracyStage === 'number' ? d.accuracyStage : 0,
      trialCount:       typeof d.trialCount === 'number' ? d.trialCount : 0,
    };
  } catch(e) { return { lives: 3, coins: 0, lastTrialDate: null, lastLoginDate: null, lastTrialSubject: null, accuracyStage: 0, trialCount: 0 }; }
}

// 同期読み込み（キャッシュ優先）
function getUserData(key) {
  if (_udCache[key]) return { ..._udCache[key] };
  return _getUserDataLocal(key);
}

// 同期書き込み（キャッシュ + localStorage）＋ 非同期で GAS に保存
function saveUserData(key, data) {
  _udCache[key] = { ...data };
  try { localStorage.setItem('quiz_userdata_' + key, JSON.stringify(data)); } catch(e) {}
  apiFetch({
    action:           'saveUserData',
    user:             key,
    lives:            data.lives,
    coins:            data.coins,
    lastTrialDate:    data.lastTrialDate    || '',
    lastLoginDate:    data.lastLoginDate    || '',
    lastTrialSubject: data.lastTrialSubject || '',
    accuracyStage:    data.accuracyStage    || 0,
    trialCount:       data.trialCount       || 0,
  }).catch(() => {});
}

// ログイン時のライフ減少チェック。udを書き換えて {livesLost, periodsMissed} を返す
// ルール：最後のトライアルから48時間ごとにライフ-1
function checkLifeOnLogin(ud) {
  const nowMs  = Date.now();
  const nowISO = nowJST();

  // 初回ログイン
  if (!ud.lastLoginDate) {
    ud.lastLoginDate = nowISO;
    return { livesLost: 0, periodsMissed: 0 };
  }

  // トライアル未実施ならペナルティなし
  if (!ud.lastTrialDate) {
    ud.lastLoginDate = nowISO;
    return { livesLost: 0, periodsMissed: 0 };
  }

  const ms48        = 48 * 3600 * 1000;
  const lastTrialMs = new Date(ud.lastTrialDate).getTime();
  const lastLoginMs = new Date(ud.lastLoginDate).getTime();

  // 前回ログイン時点・現在時点それぞれで何周期（48h）経過しているか
  const periodsAtLogin = Math.max(0, Math.floor((lastLoginMs - lastTrialMs) / ms48));
  const periodsAtNow   = Math.max(0, Math.floor((nowMs      - lastTrialMs) / ms48));
  const periodsMissed  = Math.max(0, periodsAtNow - periodsAtLogin);

  const livesLost  = Math.min(periodsMissed, ud.lives);
  ud.lives         = Math.max(0, ud.lives - periodsMissed);
  ud.lastLoginDate = nowISO;
  return { livesLost, periodsMissed };
}

// 正答率クリア閾値（苦手優先モード用・段階制）
const ACCURACY_THRESHOLDS = [60, 70, 75, 80, 85];
function getAccuracyThreshold(stage) {
  return ACCURACY_THRESHOLDS[Math.min(stage || 0, ACCURACY_THRESHOLDS.length - 1)];
}

// ライフ or コインを付与。コイン獲得数を返す
function awardLifeOrCoin(ud, amount) {
  let coinsEarned = 0;
  for (let i = 0; i < amount; i++) {
    if (ud.lives < 5) ud.lives++;
    else { ud.coins++; coinsEarned++; }
  }
  return coinsEarned;
}

// ❤️❤️❤️🤍🤍 形式のHTML文字列を返す
function renderHeartsHtml(lives, coins) {
  const hearts = Array.from({length: 5}, (_, i) =>
    `<span class="heart ${i < lives ? 'filled' : 'empty'}">${i < lives ? '❤️' : '🤍'}</span>`
  ).join('');
  const coinHtml = coins > 0 ? `<span class="coin-badge"><span class="coin-icon"></span>${coins}</span>` : '';
  return `<span class="life-row">${hearts}${coinHtml}</span>`;
}

// 選択画面カードとスタート画面ヘッダーのライフ表示を更新
function updateLifeDisplays() {
  USERS.forEach(u => {
    const el = document.getElementById('life-' + u.key);
    if (el) { const ud = getUserData(u.key); el.innerHTML = renderHeartsHtml(ud.lives, ud.coins); }
  });
  const startEl = document.getElementById('start-life-display');
  if (startEl && currentUser) {
    const ud = getUserData(currentUser.key);
    startEl.innerHTML = renderHeartsHtml(ud.lives, ud.coins);
  }
  // 右上コインカウンター
  const coinCounter = document.getElementById('coin-counter');
  if (coinCounter && currentUser) {
    const ud = getUserData(currentUser.key);
    document.getElementById('coin-count-display').textContent = ud.coins;
    coinCounter.style.display = ud.coins > 0 ? 'flex' : 'none';
  }
}

function showLifeNotification(livesLost, periodsMissed) {
  const ud = getUserData(currentUser.key);
  document.getElementById('life-notif-msg').innerHTML =
    `前回のトライアルから<strong>${periodsMissed * 48}時間以上</strong>経過したため、<br>ライフが<strong>${livesLost}つ</strong>減りました`;
  document.getElementById('life-notif-hearts').innerHTML = renderHeartsHtml(ud.lives, ud.coins);
  document.getElementById('life-notification').style.display = 'flex';
}

function closeLifeNotification() {
  document.getElementById('life-notification').style.display = 'none';
}

function showRewardToast(livesGained, coinsGained) {
  if (livesGained <= 0 && coinsGained <= 0) return;
  let msg = 'おめでとう！';
  if (livesGained > 0 && coinsGained > 0) {
    msg += `ライフを${livesGained}個＋コイン${coinsGained}枚ゲット！`;
  } else if (livesGained > 0) {
    msg += `ライフを${livesGained}個ゲット！`;
  } else {
    msg += `コイン${coinsGained}枚ゲット！`;
  }
  document.getElementById('coin-toast-msg').textContent = msg;
  const el = document.getElementById('coin-toast');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3200);
}

// コインカウンターを旧→新にアニメーション
function animateCoinGain(fromCount, toCount) {
  const counter = document.getElementById('coin-counter');
  const display = document.getElementById('coin-count-display');
  if (!counter || !display) return;

  // カウンターを表示して旧値にリセット
  counter.style.display = 'flex';
  display.textContent = fromCount;

  // "+N" バッジを追加
  const gained = toCount - fromCount;
  if (gained > 0) {
    const badge = document.createElement('div');
    badge.className = 'coin-plus-badge';
    badge.textContent = '+' + gained;
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 1700);
  }

  // カウンターピルのパルスアニメーション
  counter.classList.remove('coin-pop');
  void counter.offsetWidth; // reflow
  counter.classList.add('coin-pop');
  counter.addEventListener('animationend', () => counter.classList.remove('coin-pop'), { once: true });

  // 旧値 → 新値のカウントアップ
  const diff = toCount - fromCount;
  if (diff <= 0) { display.textContent = toCount; return; }
  const stepMs = Math.max(Math.floor(600 / diff), 40);
  let current = fromCount;
  const timer = setInterval(() => {
    current++;
    display.textContent = current;
    if (current >= toCount) clearInterval(timer);
  }, stepMs);
}

// ---- アイコン描画（絵文字 or 画像URL に対応）----
function iconHtml(icon) {
  if (typeof icon === 'string' && icon.startsWith('http')) {
    return `<img src="${icon}" alt="" class="user-icon-img">`;
  }
  return icon;
}

// ---- API ----
async function apiFetch(params) {
  const url = SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res  = await fetch(url);
  return res.json();
}

async function loadQuestions() {
  const json = await apiFetch({});
  // _idx はスプレッドシート上の行順を保持（順番通りモードで使用）
  allQuestions = (json.data || []).map((q, i) => ({ ...q, id: Number(q.id) || 0, _idx: i }));
}

async function loadProgress() {
  try {
    const json = await apiFetch({ action: 'progress', user: currentUser.key });
    progressMap = {};
    (json.data || []).forEach(p => {
      progressMap[String(p.questionId)] = {
        correct:  Number(p.correct)  || 0,
        wrong:    Number(p.wrong)    || 0,
        accuracy: Number(p.accuracy) || 0
      };
    });
  } catch(e) { progressMap = {}; }
}

// ---- Filters ----
function populateFilters() {
  // subject → unit_big → unit_section の3段階マップを構築
  const map = {};  // map[subject][unit_big] = Set(unit_sections)
  allQuestions.forEach(q => {
    const s  = q.subject    || '';
    const ub = q.unit_big   || '';
    const us = q.unit_section || '';
    if (!s) return;
    if (!map[s]) map[s] = {};
    if (ub) {
      if (!map[s][ub]) map[s][ub] = new Set();
      if (us) map[s][ub].add(us);
    }
  });

  filterMap = map;  // モジュールレベルに保存

  const subjectEl = document.getElementById('filter-subject');
  subjectEl.innerHTML = '<option value="">すべての教科</option>';
  Object.keys(map).sort().forEach(s => {
    subjectEl.innerHTML += `<option value="${s}">${s}</option>`;
  });

  subjectEl.addEventListener('change', () => {
    updateUnitFilter(filterMap);
    updateSectionFilter(filterMap);
    updateCountBadge();
    updateRecommendedTrial();
    updateSubjectProgress();
  });
  document.getElementById('filter-unit').addEventListener('change', () => {
    updateSectionFilter(filterMap);
    updateCountBadge();
  });
  document.getElementById('filter-section').addEventListener('change', updateCountBadge);
  document.getElementById('range-from').addEventListener('input', updateCountBadge);
  document.getElementById('range-to').addEventListener('input',   updateCountBadge);

  updateUnitFilter(filterMap);
  updateSectionFilter(filterMap);
  updateRecommendedTrial();
  updateSubjectProgress();
}

function updateUnitFilter(map) {
  const s     = document.getElementById('filter-subject').value;
  const units = s ? Object.keys(map[s] || {}) : [];
  const el    = document.getElementById('filter-unit');
  el.innerHTML = '<option value="">すべての単元</option>';
  units.sort().forEach(u => { el.innerHTML += `<option value="${u}">${u}</option>`; });
}

function updateSectionFilter(map) {
  const s  = document.getElementById('filter-subject').value;
  const ub = document.getElementById('filter-unit').value;
  let sections = [];
  if (s && ub && map[s] && map[s][ub]) {
    sections = [...map[s][ub]];
  } else if (s && !ub && map[s]) {
    const all = new Set();
    Object.values(map[s]).forEach(sSet => sSet.forEach(sec => all.add(sec)));
    sections = [...all];
  }
  const el = document.getElementById('filter-section');
  el.innerHTML = '<option value="">すべての小単元</option>';
  sections.sort().forEach(sec => {
    const mark = getSectionMark(sec);
    el.innerHTML += `<option value="${sec}">${mark ? mark + ' ' : ''}${sec}</option>`;
  });
}

// 小単元の達成マークを返す（全問題の最小正解数で判定）
function getSectionMark(sectionName) {
  const qs = allQuestions.filter(q => q.unit_section === sectionName);
  if (qs.length === 0) return '';
  const minCorrect = Math.min(...qs.map(q => {
    const p = progressMap[String(q.id)];
    return p ? p.correct : 0;
  }));
  if (minCorrect >= 6) return '🐔';
  if (minCorrect >= 4) return '🐣';
  if (minCorrect >= 2) return '🥚';
  return '';
}

function getFilteredQuestions() {
  const subject  = document.getElementById('filter-subject').value;
  const unit     = document.getElementById('filter-unit').value;
  const section  = document.getElementById('filter-section').value;
  const from     = parseInt(document.getElementById('range-from').value) || 1;
  const to       = parseInt(document.getElementById('range-to').value)   || 99999;

  return allQuestions.filter(q => {
    if (subject && q.subject   !== subject)  return false;
    if (unit    && q.unit_big  !== unit)     return false;
    if (section && q.unit_section !== section) return false;
    const id = Number(q.id);
    if (!isNaN(id) && (id < from || id > to)) return false;
    return true;
  });
}

// ---- 秀才モード ----
function isGeniusModeTurn() {
  if (!currentUser) return false;
  const ud = getUserData(currentUser.key);
  return (ud.trialCount || 0) >= 4;
}

// 秀才モード用の30問を作成
// 条件：同教科・全単元から、順番通り2回以上実施済みの単元のみ対象
// 苦手6問を選抜し、各5回ずつランダムに並べる
function buildGeniusQuestions(subject) {
  const subjectQs = allQuestions.filter(q => q.subject === subject);

  // 単元ごとにグループ化
  const secMap = new Map();
  subjectQs.forEach(q => {
    const key = (q.unit_big || '') + '|||' + (q.unit_section || '');
    if (!secMap.has(key)) secMap.set(key, { questions: [] });
    secMap.get(key).questions.push(q);
  });

  // 順番通り2回以上実施済みの単元のみ抽出（全問の出題回数 >= 2）
  const eligibleQs = [];
  for (const sec of secMap.values()) {
    const allDone = sec.questions.every(q => {
      const p = progressMap[String(q.id)];
      return p && (p.correct + p.wrong) >= 2;
    });
    if (allDone) eligibleQs.push(...sec.questions);
  }
  if (eligibleQs.length === 0) return null;

  // 苦手6問を選抜：正答率昇順 → 出題回数昇順 → スプレッドシート順
  const candidates = eligibleQs.map(q => {
    const p = progressMap[String(q.id)] || { correct: 0, wrong: 0, accuracy: 0 };
    const sheetIdx = allQuestions.findIndex(aq => String(aq.id) === String(q.id));
    return { q, accuracy: p.accuracy, total: p.correct + p.wrong, sheetIdx };
  });
  candidates.sort((a, b) => {
    if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
    if (a.total    !== b.total)    return a.total    - b.total;
    return a.sheetIdx - b.sheetIdx;
  });
  const selected6 = candidates.slice(0, 6).map(c => c.q);

  // 各問題を5回ずつプールしてシャッフル → 30問
  const pool = [];
  for (let i = 0; i < 5; i++) {
    selected6.forEach(q => pool.push({ ...q, _geniusMode: true }));
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// ---- おすすめトライアル ----
function getRecommendedTrial(subject) {
  if (!subject) return null;

  const secMap = new Map();
  allQuestions.filter(q => q.subject === subject).forEach(q => {
    const key = (q.unit_big || '') + '|||' + (q.unit_section || '');
    if (!secMap.has(key)) secMap.set(key, { unit_big: q.unit_big || '', unit_section: q.unit_section || '', questions: [] });
    secMap.get(key).questions.push(q);
  });

  const sections = [...secMap.values()].sort((a, b) => {
    const ub = a.unit_big.localeCompare(b.unit_big, 'ja', { numeric: true });
    if (ub !== 0) return ub;
    return a.unit_section.localeCompare(b.unit_section, 'ja', { numeric: true });
  });

  const minTotal   = sec => Math.min(...sec.questions.map(q => { const p = progressMap[String(q.id)]; return p ? p.correct + p.wrong : 0; }));
  const minCorrect = sec => Math.min(...sec.questions.map(q => { const p = progressMap[String(q.id)]; return p ? p.correct : 0; }));

  // レベル1: 全問3回正解未達
  //   └ まだ出題2回未満の問題がある → 順番通り・全問
  //   └ 全問2回以上出題済みだが正解3回未達 → 苦手優先・30問
  for (const sec of sections) {
    if (minCorrect(sec) < 3) {
      if (minTotal(sec) < 2) return { ...sec, mode: 'sequential', limit: Infinity, level: 1 };
      else                   return { ...sec, mode: 'accuracy',   limit: 30,       level: 1 };
    }
  }
  // レベル2: 全問5回正解未達 → 苦手優先・30問
  for (const sec of sections) {
    if (minCorrect(sec) < 5) return { ...sec, mode: 'accuracy', limit: 30, level: 2 };
  }
  // レベル3: 全問6回正解未達 → 苦手優先・30問
  for (const sec of sections) {
    if (minCorrect(sec) < 6) return { ...sec, mode: 'accuracy', limit: 30, level: 3 };
  }
  // 全達成: 最終トライアル実施日が最も古い単元 → 苦手優先・30問
  const getLastTrial = sec => {
    let maxMs = 0;
    for (const q of sec.questions) {
      const p = progressMap[String(q.id)];
      if (p && p.last_answered) {
        const ms = new Date(p.last_answered).getTime();
        if (ms > maxMs) maxMs = ms;
      }
    }
    return maxMs; // 0 = 未実施（最古扱い）
  };
  if (sections.length > 0) {
    sections.sort((a, b) => {
      const diff = getLastTrial(a) - getLastTrial(b); // 古い順（昇順）
      if (diff !== 0) return diff;
      const ub = a.unit_big.localeCompare(b.unit_big, 'ja', { numeric: true });
      if (ub !== 0) return ub;
      return a.unit_section.localeCompare(b.unit_section, 'ja', { numeric: true });
    });
    return { ...sections[0], mode: 'accuracy', limit: 30, level: 4 };
  }

  return null;
}

// 教科の全問題が minCorrect ≥ 4（milestone level 2以上）かを確認
function isSubjectFullyAtLevel2(subject) {
  const sections = [...new Set(
    allQuestions.filter(q => q.subject === subject && q.unit_section)
      .map(q => q.unit_section)
  )];
  if (sections.length === 0) return false;
  return sections.every(s => getSectionMilestoneLevel(s, progressMap) >= 2);
}

// 管理者設定の制限が有効かつ条件に合致する場合 true
function isTrialRestricted(subject) {
  const restriction = localStorage.getItem('quiz_setting_trialRestriction') || 'none';
  if (restriction !== 'limit') return false;
  if (!isSubjectFullyAtLevel2(subject)) return false;
  const ud = getUserData(currentUser ? currentUser.key : '');
  return ud.lastTrialSubject === subject;
}

function updateRecommendedTrial() {
  const subject = document.getElementById('filter-subject').value;
  const card    = document.getElementById('rec-card');
  if (!subject) { card.style.display = 'none'; return; }

  // 秀才モードターンのとき
  if (isGeniusModeTurn()) {
    const geniusQs = buildGeniusQuestions(subject);
    document.getElementById('rec-goal').textContent    = '🧠 秀才モード';
    document.getElementById('rec-unit').textContent    = '全単元';
    document.getElementById('rec-section').textContent = '全単元';
    document.getElementById('rec-mode').textContent    = '📉 苦手優先（ランダム順）';
    document.getElementById('rec-count').textContent   = '30問';
    const accMsg = document.getElementById('rec-accuracy-msg');
    accMsg.textContent   = '苦手部分が得意になる「秀才モード」にチャレンジ！\n60%以上正解でコインゲット！';
    accMsg.style.display = 'block';
    document.getElementById('rec-restrict-msg').style.display = 'none';
    const btnRec = document.getElementById('btn-rec');
    if (geniusQs) {
      btnRec.disabled    = false;
      btnRec.textContent = '🧠 秀才モードでスタート';
    } else {
      btnRec.disabled    = true;
      btnRec.textContent = '対象単元が不足しています';
    }
    updateCoinDoubleDisplay(card);
    card.style.display = 'block';
    return;
  }

  const rec = getRecommendedTrial(subject);
  if (!rec) { card.style.display = 'none'; return; }

  const goalTexts = {
    1: '🌱 全問3回正解を目指そう！',
    2: '⭐⭐ 全問5回正解を目指そう！',
    3: '⭐⭐⭐ 全問6回正解を目指そう！',
    4: '🏆 全クリア！最終実施日が古い単元',
  };

  const qCount = allQuestions.filter(q =>
    q.subject === subject &&
    q.unit_big === rec.unit_big &&
    q.unit_section === rec.unit_section
  ).length;

  const ud_rec     = getUserData(currentUser ? currentUser.key : '');
  const stage      = ud_rec.accuracyStage || 0;
  const thr        = getAccuracyThreshold(stage);
  const modeText   = rec.mode === 'sequential' ? '📋 順番通り' : `📉 苦手優先（目標正答率 ${thr}%）`;
  const limitText  = rec.limit === Infinity ? `全問（${qCount}問）` : `${rec.limit}問`;

  document.getElementById('rec-goal').textContent    = goalTexts[rec.level] || '';
  document.getElementById('rec-unit').textContent    = rec.unit_big    || '（なし）';
  document.getElementById('rec-section').textContent = rec.unit_section || '（なし）';
  document.getElementById('rec-mode').textContent    = modeText;
  document.getElementById('rec-count').textContent   = limitText;

  // 苦手優先モードのとき正答率目標を表示
  const accMsg = document.getElementById('rec-accuracy-msg');
  if (rec.mode === 'accuracy') {
    accMsg.textContent = `🪙 ${thr}%以上正解でコインゲット！`;
    accMsg.style.display = 'block';
  } else {
    accMsg.style.display = 'none';
  }

  // 制限チェック
  const restricted   = isTrialRestricted(subject);
  const restrictMsg  = document.getElementById('rec-restrict-msg');
  const btnRec       = document.getElementById('btn-rec');
  if (restricted) {
    restrictMsg.textContent = '⚠️ この教科は全問4回達成済みです。先に別の教科のトライアルを1回行ってください。';
    restrictMsg.style.display = 'block';
    btnRec.disabled = true;
    btnRec.textContent = '他の教科を先にトライアル';
  } else {
    restrictMsg.style.display = 'none';
    btnRec.disabled = false;
    btnRec.textContent = '🎯 おすすめでスタート';
  }

  // コイン2倍チャンス表示
  updateCoinDoubleDisplay(card);

  card.style.display = 'block';
}

function updateCoinDoubleDisplay(card) {
  const doubleMsg = document.getElementById('rec-double-msg');
  const db = getCoinDouble();
  if (db.active) {
    const remaining = Math.ceil((db.expiry - Date.now()) / 60000);
    doubleMsg.textContent  = `🌟✨ コイン2倍チャンス発動中！残り約${remaining}分 ✨🌟\n15分以内にトライアルクリアで2倍！`;
    doubleMsg.style.display = 'block';
    card.classList.add('coin-double');
  } else {
    doubleMsg.style.display = 'none';
    card.classList.remove('coin-double');
  }
}

function startRecommendedTrial() {
  const subject = document.getElementById('filter-subject').value;

  // 秀才モードターン
  if (isGeniusModeTurn()) {
    const geniusQs = buildGeniusQuestions(subject);
    if (!geniusQs) return;
    snapshotMilestones();
    isRecommendedTrialSession = true;
    isGeniusTrialSession      = true;
    currentSessionMode        = 'genius';
    recommendedTrialMode      = 'genius';
    recommendedTrialSubject   = subject;
    sessionCompleted          = false;
    consecutiveCorrect        = 0;
    retryStartIdx             = -1;
    geniusAnsweredIds         = new Set();
    sessionQs      = geniusQs;
    currentIdx     = 0;
    sessionResults = [];
    showScreen('quiz');
    renderQuestion();
    return;
  }

  const rec = getRecommendedTrial(subject);
  if (!rec) return;

  const questions = allQuestions.filter(q =>
    q.subject === subject &&
    q.unit_big === rec.unit_big &&
    q.unit_section === rec.unit_section
  );
  if (questions.length === 0) return;

  snapshotMilestones();
  isRecommendedTrialSession = true;
  isGeniusTrialSession      = false;
  recommendedTrialMode      = rec.mode;
  recommendedTrialSubject   = subject;
  currentSessionMode        = rec.mode;
  sessionCompleted          = false;
  consecutiveCorrect        = 0;
  retryStartIdx             = -1;
  geniusAnsweredIds         = new Set();
  sessionQs      = buildSession(questions, rec.mode, rec.limit);
  currentIdx     = 0;
  sessionResults = [];

  showScreen('quiz');
  renderQuestion();
}

// ---- 教科の進捗グラフ（教科選択時に全小単元を一覧表示）----
function updateSubjectProgress() {
  const subject = document.getElementById('filter-subject').value;
  const wrap    = document.getElementById('subject-progress-wrap');

  if (!subject) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }

  const subjectQs = allQuestions.filter(q => q.subject === subject);
  if (subjectQs.length === 0) { wrap.style.display = 'none'; return; }

  // unit_big → unit_section → questions のマップを構築
  const unitMap = new Map();
  subjectQs.forEach(q => {
    const ub = q.unit_big     || '';
    const us = q.unit_section || '';
    if (!unitMap.has(ub)) unitMap.set(ub, new Map());
    if (!unitMap.get(ub).has(us)) unitMap.get(ub).set(us, []);
    unitMap.get(ub).get(us).push(q);
  });

  const sortedUnits = [...unitMap.keys()].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const maxBar = 6;

  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const html = sortedUnits.map(ub => {
    const secMap     = unitMap.get(ub);
    const sortedSecs = [...secMap.keys()].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));

    const rows = sortedSecs.map(us => {
      const qs         = secMap.get(us);
      const minCorrect = Math.min(...qs.map(q => { const p = progressMap[String(q.id)]; return p ? p.correct : 0; }));
      const pct        = Math.min((minCorrect / maxBar) * 100, 100);

      let barColor;
      if      (minCorrect >= 6) barColor = 'var(--correct)';
      else if (minCorrect >= 4) barColor = '#4ade80';
      else if (minCorrect >= 2) barColor = 'var(--warn)';
      else                      barColor = '#cbd5e1';

      const mark = minCorrect >= 6 ? '🐔' : minCorrect >= 4 ? '🐣' : minCorrect >= 2 ? '🥚' : '';

      return `
        <div class="sp2-row">
          <div class="sp2-header">
            <span class="sp2-name">${esc(us)}</span>
            <span class="sp2-mark">${mark}</span>
          </div>
          <div class="sp2-bar-bg">
            <div class="sp2-bar" style="width:${pct}%;background:${barColor}"></div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="sp2-unit-group">
        <div class="sp2-unit-label">${esc(ub)}</div>
        ${rows}
      </div>`;
  }).join('');

  wrap.innerHTML = `<div class="card sp2-card"><h2>教科の進捗</h2>${html}</div>`;
  wrap.style.display = 'block';
}

function updateCountBadge() {
  document.getElementById('q-count').textContent = getFilteredQuestions().length;
  updateSectionProgress();
}

function updateSectionProgress() {
  const section = document.getElementById('filter-section').value;
  const wrap    = document.getElementById('section-progress-wrap');

  if (!section) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  const sectionQs = allQuestions
    .filter(q => q.unit_section === section)
    .sort((a, b) => a.id - b.id);

  if (sectionQs.length === 0) {
    wrap.style.display = 'none';
    return;
  }

  const maxBar = 6;

  const rows = sectionQs.map(q => {
    const p       = progressMap[String(q.id)];
    const correct = p ? p.correct : 0;
    const pct     = Math.min((correct / maxBar) * 100, 100);

    let barColor;
    if (correct >= 6)      barColor = 'var(--correct)';
    else if (correct >= 4) barColor = '#4ade80';
    else if (correct >= 2) barColor = 'var(--warn)';
    else if (correct >= 1) barColor = '#94a3b8';
    else                   barColor = 'var(--border)';

    const text = String(q.question || '');
    const label = text.length > 28 ? text.slice(0, 28) + '…' : text;

    return `
      <div class="sp-row">
        <div class="sp-label">
          <span class="sp-id">#${q.id}</span>
          <span class="sp-text">${label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>
        </div>
        <div class="sp-bar-wrap">
          <div class="sp-bar-bg">
            <div class="sp-bar" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <span class="sp-count">${correct}</span>
        </div>
      </div>`;
  }).join('');

  wrap.innerHTML = `<div class="card sp-card"><h2>問題別 正解数</h2>${rows}</div>`;
  wrap.style.display = 'block';
}

// ---- Build session（グループ順序保持・苦手優先ルール適用）----
function buildSession(questions, mode, limit) {
  const groupMap   = {};
  const singletons = [];

  questions.forEach(q => {
    const gId = String(q.group_id || '').trim();
    if (gId && gId !== '' && gId !== '0') {
      if (!groupMap[gId]) groupMap[gId] = [];
      groupMap[gId].push(q);
    } else {
      singletons.push(q);
    }
  });

  Object.values(groupMap).forEach(g => {
    g.sort((a, b) => Number(a.group_order || 0) - Number(b.group_order || 0));
  });

  const units = [
    ...singletons.map(q => [q]),
    ...Object.values(groupMap)
  ];

  if (mode === 'random') {
    units.sort(() => Math.random() - 0.5);

  } else if (mode === 'accuracy') {
    // 範囲内の最大出題数を計算
    const maxCount = questions.reduce((max, q) => {
      const p = progressMap[String(q.id)];
      return Math.max(max, p ? (p.correct + p.wrong) : 0);
    }, 0);
    const threshold = maxCount * (2 / 3);

    const unitScore = unit => {
      const stats = unit.map(q => {
        const p = progressMap[String(q.id)];
        return p
          ? { count: p.correct + p.wrong, acc: p.accuracy }
          : { count: 0, acc: 0 };
      });
      const minCount = Math.min(...stats.map(s => s.count));
      const avgAcc   = stats.reduce((s, c) => s + c.acc, 0) / stats.length;
      // ① 未出題=0  ② しきい値以下=1  ③ それ以外=2
      const cat = minCount === 0 ? 0 : (minCount <= threshold ? 1 : 2);
      return { cat, avgAcc };
    };

    units.sort((a, b) => {
      const sa = unitScore(a);
      const sb = unitScore(b);
      if (sa.cat !== sb.cat) return sa.cat - sb.cat;
      return sa.avgAcc - sb.avgAcc;  // 同カテゴリ内は正答率昇順
    });

  } else {
    // 順番通り：スプレッドシートの上から下の順（_idx）
    units.sort((a, b) => {
      const minIdx = u => Math.min(...u.map(q => q._idx !== undefined ? q._idx : Number(q.id) || 0));
      return minIdx(a) - minIdx(b);
    });
  }

  // 問題数制限（グループは途中で切らない）
  let selected;
  if (limit && limit !== Infinity) {
    let count = 0;
    selected = [];
    for (const unit of units) {
      if (count >= limit) break;
      selected.push(unit);
      count += unit.length;
    }
  } else {
    selected = units;
  }

  // 苦手優先モードは：弱い問題を選抜した後、出題順はランダムにする
  if (mode === 'accuracy') {
    selected = selected.slice().sort(() => Math.random() - 0.5);
  }

  return selected.flat();
}

// ---- Start Quiz ----
function startQuiz() {
  const questions = getFilteredQuestions();
  if (questions.length === 0) {
    alert('条件に合う問題がありません。フィルターを変更してください。');
    return;
  }
  const mode     = document.querySelector('input[name="mode"]:checked').value;
  const limitVal = document.getElementById('q-limit').value;
  const limit    = (mode === 'sequential' || limitVal === 'all')
                   ? Infinity : parseInt(limitVal);

  snapshotMilestones();
  isRecommendedTrialSession = false;
  isGeniusTrialSession      = false;
  currentSessionMode        = mode;
  sessionCompleted          = false;
  consecutiveCorrect        = 0;
  retryStartIdx             = -1;
  geniusAnsweredIds         = new Set();
  sessionQs      = buildSession(questions, mode, limit);
  currentIdx     = 0;
  sessionResults = [];

  showScreen('quiz');
  renderQuestion();
}

// ---- Render Question ----
function renderQuestion() {
  answered = false;
  const q = sessionQs[currentIdx];

  const pct = (currentIdx / sessionQs.length) * 100;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('q-current').textContent    = currentIdx + 1;
  document.getElementById('q-total').textContent      = sessionQs.length;

  const badgeBase = [q.subject, q.unit_section].filter(Boolean).join(' › ');
  const badge = q._isRetry ? `🔁 もう一度 › ${badgeBase}` : badgeBase;
  document.getElementById('question-badge').textContent = badge;
  document.getElementById('question-text').textContent  = q.question || '';

  // 出題数・正解数の表示
  const statsEl = document.getElementById('q-stats');
  const p = progressMap[String(q.id)];
  if (p && (p.correct + p.wrong) > 0) {
    const total = p.correct + p.wrong;
    const acc   = Math.round(p.accuracy * 100);
    statsEl.textContent = `📊 ${total}回 / ✅ ${p.correct}回 (${acc}%)`;
    statsEl.className   = 'q-stats';
  } else {
    statsEl.textContent = '🌟 はじめて';
    statsEl.className   = 'q-stats first-time';
  }

  const imgEl = document.getElementById('question-img');
  if (q.image_url) { imgEl.src = q.image_url; imgEl.style.display = 'block'; }
  else             { imgEl.style.display = 'none'; }

  const videoBtn = document.getElementById('question-video-btn');
  if (q.video_url) { videoBtn.href = q.video_url; videoBtn.style.display = 'block'; }
  else             { videoBtn.style.display = 'none'; }

  const area = document.getElementById('answer-area');
  const qType = String(q.type || '').trim().toLowerCase();

  if (qType === 'mcq' || qType === 'choice') {
    // ---- 4択 ----
    const keys = ['a','b','c','d'].filter(k => q['choice_' + k]);
    area.innerHTML = `
      <div class="choices">
        ${keys.map(k => `
          <button class="choice-btn" onclick="submitChoice('${k}')" data-key="${k}">
            <span style="color:var(--text-sub);font-weight:700;margin-right:8px">${k.toUpperCase()}.</span>${q['choice_' + k]}
          </button>`).join('')}
      </div>`;

  } else if (qType === 'self') {
    // ---- 自己採点 ----
    area.innerHTML = `
      <button class="btn-show-answer" onclick="showSelfAnswer()">答えを見る 👀</button>`;

  } else {
    // ---- キーワード入力 ----
    const kMin = Number(q.keyword_min) || 1;
    const placeholder = kMin > 1
      ? `${kMin}つの答えをスペースで区切って入力…`
      : 'こたえを入力…';
    area.innerHTML = `
      <div class="keyword-wrap">
        <input type="text" id="keyword-input"
               placeholder="${placeholder}"
               autocomplete="off" autocorrect="off"
               autocapitalize="off" spellcheck="false"
               onkeydown="if(event.key==='Enter')submitKeyword()">
        <button class="btn-answer" onclick="submitKeyword()">こたえる</button>
      </div>`;
    setTimeout(() => document.getElementById('keyword-input')?.focus(), 50);
  }
}

// ---- Submit: MCQ ----
function submitChoice(key) {
  if (answered) return;
  answered = true;

  const q          = sessionQs[currentIdx];
  const correctKey = (q.correct || '').toLowerCase().trim();
  const isCorrect  = correctKey === key;

  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.key === correctKey)        btn.classList.add('correct-choice');
    if (btn.dataset.key === key && !isCorrect) btn.classList.add('wrong-choice');
  });

  showFeedback(isCorrect, q, key);
}

// ---- Submit: Keyword ----
function submitKeyword() {
  if (answered) return;
  const input = (document.getElementById('keyword-input')?.value || '').trim();
  if (!input) return;
  answered = true;

  const q        = sessionQs[currentIdx];
  const keywords = (q.keywords || q.answer || '')
    .split(',').map(k => k.trim()).filter(Boolean);
  const kMin     = Number(q.keyword_min) || 1;

  let isCorrect;
  if (kMin > 1) {
    // 複数キーワードモード：スペース区切りで入力、順不同でkMin個以上一致で正解
    const inputWords = input.split(/\s+/).filter(Boolean);
    const matchCount = inputWords.filter(word =>
      keywords.some(k => k === word || k.toLowerCase() === word.toLowerCase())
    ).length;
    isCorrect = matchCount >= kMin;
  } else {
    // 通常モード：1キーワード一致
    isCorrect = keywords.some(k =>
      k === input || k.toLowerCase() === input.toLowerCase()
    );
  }

  const inputEl = document.getElementById('keyword-input');
  if (inputEl) inputEl.disabled = true;
  const btnEl = document.querySelector('.btn-answer');
  if (btnEl) btnEl.disabled = true;

  showFeedback(isCorrect, q, input);
}

// ---- Submit: Self（答えを見る） ----
function showSelfAnswer() {
  const q = sessionQs[currentIdx];

  document.getElementById('fb-icon').textContent  = '👀';
  document.getElementById('fb-icon').style.fontSize = '48px';
  document.getElementById('fb-title').textContent = 'こたえをかくにん';
  document.getElementById('fb-title').className   = 'feedback-title';
  document.getElementById('fb-answer').textContent = q.answer || '';

  document.getElementById('fb-explanation').textContent = q.explanation || '';
  document.getElementById('fb-explanation-wrap').style.display = q.explanation ? 'block' : 'none';

  // 自己採点ボタンを表示、通常の「つぎへ」を隠す
  document.getElementById('btn-next').style.display        = 'none';
  document.getElementById('self-grade-btns').style.display = 'block';

  document.getElementById('feedback-overlay').classList.add('show');
}

function submitSelf(isCorrect) {
  answered = true;
  const q = sessionQs[currentIdx];

  document.getElementById('fb-icon').textContent  = isCorrect ? '⭕' : '❌';
  document.getElementById('fb-icon').style.fontSize = '56px';
  document.getElementById('fb-title').textContent = isCorrect ? 'せいかい！' : 'ざんねん…';
  document.getElementById('fb-title').className   = 'feedback-title ' + (isCorrect ? 'correct' : 'wrong');

  document.getElementById('self-grade-btns').style.display = 'none';
  document.getElementById('btn-next').style.display        = 'block';

  if (!q._isRetry) {
    sessionResults.push({ questionId: String(q.id), correct: isCorrect });
    if (q._geniusMode) {
      const qId = String(q.id);
      if (!geniusAnsweredIds.has(qId)) { geniusAnsweredIds.add(qId); saveProgress(qId, isCorrect, ''); }
    } else {
      saveProgress(String(q.id), isCorrect, '');
    }
  }
  if (isCorrect) { consecutiveCorrect++; playCorrectSound(); checkStreak(); }
  else             consecutiveCorrect = 0;
}

// ---- Feedback（mcq / keyword用） ----
function showFeedback(isCorrect, q, userAnswer) {
  if (!q._isRetry) {
    sessionResults.push({ questionId: String(q.id), correct: isCorrect });
    if (q._geniusMode) {
      const qId = String(q.id);
      if (!geniusAnsweredIds.has(qId)) { geniusAnsweredIds.add(qId); saveProgress(qId, isCorrect, userAnswer); }
    } else {
      saveProgress(String(q.id), isCorrect, userAnswer);
    }
  }
  if (isCorrect) { consecutiveCorrect++; playCorrectSound(); checkStreak(); }
  else             consecutiveCorrect = 0;

  document.getElementById('fb-icon').textContent  = isCorrect ? '⭕' : '❌';
  document.getElementById('fb-icon').style.fontSize = '56px';
  document.getElementById('fb-title').textContent = isCorrect ? 'せいかい！' : 'ざんねん…';
  document.getElementById('fb-title').className   = 'feedback-title ' + (isCorrect ? 'correct' : 'wrong');
  document.getElementById('fb-answer').textContent = q.answer || '';

  document.getElementById('fb-explanation').textContent = q.explanation || '';
  document.getElementById('fb-explanation-wrap').style.display = q.explanation ? 'block' : 'none';

  document.getElementById('self-grade-btns').style.display = 'none';
  document.getElementById('btn-next').style.display        = 'block';

  document.getElementById('feedback-overlay').classList.add('show');
}

// 順番通りモード用：メインラウンドで間違えた問題から再出題リストを作成
function buildRetryQuestions() {
  // メインラウンド（retryStartIdx未満）の間違い問題IDを収集
  const wrongIds = new Set(
    sessionResults.filter(r => !r.correct).map(r => r.questionId)
  );
  if (wrongIds.size === 0) return [];

  // スプレッドシートの順番を保持するため allQuestions のインデックスを使う
  const sheetOrder = idx => allQuestions.findIndex(aq => String(aq.id) === String(sessionQs[idx].id));

  const candidates = sessionQs
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => wrongIds.has(String(q.id)))
    .map(({ q, i }) => {
      const p = progressMap[String(q.id)] || { correct: 0, wrong: 0, accuracy: 0 };
      return { q, accuracy: p.accuracy, total: p.correct + p.wrong, sheetIdx: sheetOrder(i) };
    });

  // ソート：正答率昇順 → 出題回数昇順 → スプレッドシート順
  candidates.sort((a, b) => {
    if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
    if (a.total    !== b.total)    return a.total    - b.total;
    return a.sheetIdx - b.sheetIdx;
  });

  return candidates.slice(0, 5).map(({ q }) => ({ ...q, _isRetry: true }));
}

function nextQuestion() {
  document.getElementById('feedback-overlay').classList.remove('show');
  currentIdx++;
  if (currentIdx >= sessionQs.length) {
    // 順番通りモードでまだ再出題を追加していない場合
    if (currentSessionMode === 'sequential' && retryStartIdx === -1) {
      const retryQs = buildRetryQuestions();
      if (retryQs.length > 0) {
        retryStartIdx = sessionQs.length;
        sessionQs = [...sessionQs, ...retryQs];
        renderQuestion();
        return;
      }
    }
    showResultScreen();
  } else {
    renderQuestion();
  }
}

// ---- マイルストーン（お祝い）----
function getSectionMilestoneLevel(sectionName, pMap) {
  const qs = allQuestions.filter(q => q.unit_section === sectionName);
  if (qs.length === 0) return -1;
  const minCorrect = Math.min(...qs.map(q => { const p = pMap[String(q.id)]; return p ? p.correct : 0; }));
  if (minCorrect < 2) return 0;
  if (minCorrect < 4) return 1;
  if (minCorrect < 6) return 2;
  return 3;
}

function snapshotMilestones() {
  const sections = [...new Set(allQuestions.map(q => q.unit_section).filter(Boolean))];
  preSessionMilestonesMap = {};
  sections.forEach(sec => {
    preSessionMilestonesMap[sec] = getSectionMilestoneLevel(sec, progressMap);
  });
}

function checkMilestoneCelebrations() {
  const results = [];
  Object.entries(preSessionMilestonesMap).forEach(([sec, before]) => {
    const after = getSectionMilestoneLevel(sec, progressMap);
    if (after > before) results.push({ section: sec, toLevel: after });
  });
  return results;
}

function playMilestoneSound(level) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const melodies = {
      1: [[523,0],[659,0.18],[784,0.36],[1047,0.54]],
      2: [[523,0],[659,0.15],[784,0.30],[1047,0.48],[784,0.68],[1047,0.86]],
      3: [[523,0],[659,0.13],[784,0.26],[1047,0.39],[784,0.58],[1047,0.71],[1175,0.90]],
      4: [[523,0],[659,0.12],[784,0.24],[1047,0.36],[1175,0.52],[1047,0.66],[1175,0.80],[1047,0.94],[1175,1.10]],
    };
    const notes = melodies[level] || melodies[1];
    notes.forEach(([freq, delay]) => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = audioCtx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
      osc.start(t);
      osc.stop(t + 0.50);
    });
  } catch(e) { /* 音声非対応環境は無視 */ }
}

function showCelebrationItem(item) {
  return new Promise(resolve => {
    celebrationResolve = resolve;
    const info = {
      1: { emoji: '🥚', title: '全問2回正解達成！', msg: 'すべての問題を2回正解しました！次は4回を目指そう！' },
      2: { emoji: '🐣', title: '全問4回正解達成！', msg: 'すべての問題を4回正解しました！次は6回を目指そう！' },
      3: { emoji: '🐔', title: '全問6回正解達成！', msg: 'この単元をマスターしました！すばらしい！' },
    }[item.toLevel] || { emoji: '🎉', title: 'レベルアップ！', msg: '' };

    document.getElementById('cel-emoji').textContent   = info.emoji;
    document.getElementById('cel-title').textContent   = info.title;
    document.getElementById('cel-section').textContent = `【 ${item.section} 】`;
    document.getElementById('cel-message').textContent = info.msg;
    document.getElementById('celebration-overlay').style.display = 'flex';
    playMilestoneSound(item.toLevel);
  });
}

function closeCelebration() {
  document.getElementById('celebration-overlay').style.display = 'none';
  if (celebrationResolve) { celebrationResolve(); celebrationResolve = null; }
}

async function showCelebrations(items) {
  for (const item of items) {
    await showCelebrationItem(item);
  }
}

// ---- 連続正解ストリーク ----
const STREAK_IMAGES = {
  1: 'https://smolly808.github.io/study-quiz-v2/images/5問連続.jpg',
  2: 'https://smolly808.github.io/study-quiz-v2/images/10問連続.jpg',
  3: 'https://smolly808.github.io/study-quiz-v2/images/15問連続.jpg',
  4: 'https://smolly808.github.io/study-quiz-v2/images/20問連続.jpg',
  5: 'https://smolly808.github.io/study-quiz-v2/images/25問連続.jpg',
  6: 'https://smolly808.github.io/study-quiz-v2/images/30問連続.jpg',
  7: 'https://smolly808.github.io/study-quiz-v2/images/35問連続.jpg',
  8: 'https://smolly808.github.io/study-quiz-v2/images/40問連続.jpg',
  9: 'https://smolly808.github.io/study-quiz-v2/images/45問連続.jpg',
};

function playStreakSound(level) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const melodies = {
      1: [[523,0],[659,0.15],[784,0.30],[1047,0.45]],
      2: [[523,0],[659,0.12],[784,0.24],[1047,0.36],[1319,0.52],[1047,0.68]],
      3: [[523,0],[659,0.11],[784,0.22],[1047,0.33],[1319,0.46],[1568,0.59],[1047,0.74],[1568,0.90]],
      4: [[523,0],[659,0.10],[784,0.20],[1047,0.30],[1319,0.42],[1568,0.54],[2093,0.68],[1568,0.82],[2093,0.96],[2093,1.12],[2093,1.28],[2093,1.44]],
      5: [[523,0],[659,0.09],[784,0.18],[1047,0.27],[1319,0.37],[1568,0.47],[2093,0.58],[1568,0.68],[2093,0.78],[2093,0.90],[2349,1.02],[2093,1.14],[2349,1.26],[2349,1.40]],
      6: [[523,0],[659,0.09],[784,0.18],[1047,0.27],[1319,0.36],[1568,0.45],[2093,0.55],[2349,0.65],[2093,0.74],[2349,0.84],[2637,0.95],[2349,1.05],[2637,1.16],[2637,1.28],[2349,1.40],[2637,1.53]],
      7: [[523,0],[659,0.08],[784,0.16],[1047,0.24],[1319,0.33],[1568,0.42],[2093,0.52],[2349,0.62],[2637,0.73],[2349,0.82],[2637,0.91],[2093,1.02],[2349,1.13],[2637,1.25],[2637,1.37],[2637,1.50],[2637,1.63],[2637,1.77]],
      8: [[523,0],[659,0.08],[784,0.16],[1047,0.24],[1319,0.32],[1568,0.40],[2093,0.49],[2349,0.58],[2637,0.68],[2349,0.77],[2637,0.86],[2093,0.96],[2349,1.06],[2637,1.17],[2637,1.28],[2349,1.38],[2637,1.48],[2637,1.60],[2637,1.72],[2637,1.85]],
      9: [[523,0],[659,0.08],[784,0.16],[1047,0.24],[1319,0.32],[1568,0.40],[2093,0.49],[2349,0.58],[2637,0.68],[2349,0.77],[2637,0.86],[2093,0.95],[2349,1.05],[2637,1.16],[2637,1.27],[2349,1.37],[2637,1.47],[2637,1.58],[2637,1.69],[2349,1.80],[2637,1.91],[2637,2.03],[2637,2.15],[2637,2.28]],
    };
    const vol   = [0, 0.30, 0.35, 0.40, 0.45, 0.47, 0.48, 0.49, 0.50, 0.50][level] || 0.35;
    const notes = melodies[level] || melodies[4];
    notes.forEach(([freq, delay]) => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = audioCtx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
      osc.start(t);
      osc.stop(t + 0.50);
    });
  } catch(e) { /* 音声非対応環境は無視 */ }
}

function checkStreak() {
  if (consecutiveCorrect <= 0 || consecutiveCorrect % 5 !== 0) return;
  const level  = Math.min(Math.floor(consecutiveCorrect / 5), 9);
  const imgUrl = STREAK_IMAGES[level];
  if (!imgUrl) return;
  showStreakOverlay(imgUrl, level);
}

function showStreakOverlay(imgUrl, level) {
  document.getElementById('streak-img').src = imgUrl;
  document.getElementById('streak-overlay').style.display = 'flex';
  playStreakSound(level);
  if (streakTimer) clearTimeout(streakTimer);
  streakTimer = setTimeout(() => closeStreakOverlay(), 3000);
}

function closeStreakOverlay() {
  document.getElementById('streak-overlay').style.display = 'none';
  if (streakTimer) { clearTimeout(streakTimer); streakTimer = null; }
}

// ---- 正解音（Web Audio API） ----
function playCorrectSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // ド・ミ・ソ の上昇アルペジオ
    [[523, 0], [659, 0.12], [784, 0.24]].forEach(([freq, delay]) => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.28, audioCtx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.55);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + 0.55);
    });
  } catch(e) { /* 音声非対応環境は無視 */ }
}

// ---- Save progress ----
function saveProgress(questionId, isCorrect, answer) {
  const params = new URLSearchParams({
    action: 'saveAnswer', user: currentUser.key,
    questionId, correct: isCorrect ? '1' : '0', answer: answer || ''
  });
  fetch(SCRIPT_URL + '?' + params.toString())
    .catch(err => console.warn('進捗の保存に失敗:', err));

  const prev  = progressMap[questionId] || { correct: 0, wrong: 0 };
  const newC  = prev.correct + (isCorrect ? 1 : 0);
  const newW  = prev.wrong   + (isCorrect ? 0 : 1);
  const total = newC + newW;
  progressMap[questionId] = { correct: newC, wrong: newW, accuracy: total > 0 ? newC / total : 0 };
}

// ---- Result ----
function showResultScreen() {
  const correct = sessionResults.filter(r => r.correct).length;
  const total   = sessionResults.length;
  const pct     = Math.round((correct / total) * 100);
  const emoji   = pct >= 90 ? '🎉' : pct >= 70 ? '😊' : pct >= 50 ? '😐' : '😢';

  // セッション完了を記録
  sessionCompleted = true;
  sessionAccuracy  = pct;

  document.getElementById('result-emoji').textContent    = emoji;
  document.getElementById('result-pct').textContent      = pct + '%';
  document.getElementById('result-fraction').textContent = `${correct} / ${total} 問正解`;
  document.getElementById('result-correct').textContent  = correct;
  document.getElementById('result-wrong').textContent    = total - correct;
  showScreen('result');
}

function retryQuiz() {
  sessionQs      = [...sessionQs].sort(() => Math.random() - 0.5);
  currentIdx     = 0;
  sessionResults = [];
  showScreen('quiz');
  renderQuestion();
}

async function goHome() {
  // progressMap はsaveProgress()でリアルタイム更新済みのため再取得不要

  // マイルストーン達成チェック
  const celebrations = checkMilestoneCelebrations();

  // おすすめトライアルを最後まで完了 かつ 正答率条件クリア → ライフ/コイン処理
  const ud0 = getUserData(currentUser.key);
  let trialCleared = false;
  let livesGained  = 0;
  let coinsEarned  = 0;
  const leveledUp  = celebrations.length > 0;

  if (isGeniusTrialSession && sessionCompleted) {
    // 秀才モード：60%以上でコイン
    const geniusOk = sessionAccuracy >= 60;
    if (geniusOk || leveledUp) {
      const ud    = getUserData(currentUser.key);
      const toAdd = (geniusOk ? 1 : 0) + (leveledUp ? 1 : 0);
      coinsEarned = awardLifeOrCoin(ud, toAdd);
      livesGained = toAdd - coinsEarned;
      ud.trialCount       = 0; // 秀才モード完了でリセット
      ud.lastTrialDate    = nowJST();
      ud.lastTrialSubject = recommendedTrialSubject;
      saveUserData(currentUser.key, ud);
    } else {
      // 不合格でもカウントはリセット
      const ud = getUserData(currentUser.key);
      ud.trialCount = 0;
      saveUserData(currentUser.key, ud);
    }
  } else {
    // 通常トライアル
    const threshold  = getAccuracyThreshold(ud0.accuracyStage || 0);
    const accuracyOk = (recommendedTrialMode === 'sequential') || sessionAccuracy >= threshold;
    trialCleared     = isRecommendedTrialSession && sessionCompleted && accuracyOk;

    if (trialCleared || leveledUp) {
      const ud    = getUserData(currentUser.key);
      const toAdd = (trialCleared ? 1 : 0) + (leveledUp ? 1 : 0);
      coinsEarned = awardLifeOrCoin(ud, toAdd);
      livesGained = toAdd - coinsEarned;
      if (trialCleared) {
        ud.lastTrialDate    = nowJST();
        ud.lastTrialSubject = recommendedTrialSubject;
        if (recommendedTrialMode === 'accuracy') {
          ud.accuracyStage = Math.min((ud.accuracyStage || 0) + 1, 4);
        }
        // 通常トライアルクリアでカウントを増やす
        ud.trialCount = Math.min((ud.trialCount || 0) + 1, 4);
      }
      saveUserData(currentUser.key, ud);
    }
  }

  // コイン2倍チャンスの適用
  const dbState = getCoinDouble();
  if (coinsEarned > 0 && dbState.active) {
    const bonus = coinsEarned; // 同量を追加
    const udDb  = getUserData(currentUser.key);
    udDb.coins += bonus;
    coinsEarned += bonus;
    saveUserData(currentUser.key, udDb);
    setCoinDouble(false); // 使用済みでリセット
  } else if (coinsEarned > 0 || (isRecommendedTrialSession && sessionCompleted)) {
    // トライアル完了後に2倍チャンス抽選（20%）
    if (!dbState.active && Math.random() < 0.2) {
      setCoinDouble(true);
    } else if (dbState.active && coinsEarned === 0) {
      // コイン獲得なし → 2倍チャンスはそのまま継続
    }
  }

  // コインアニメーション用に旧コイン数を記録（saveUserData後に取得）
  const _ud2 = getUserData(currentUser.key);
  const oldCoinCount = _ud2.coins - coinsEarned;

  updateSectionFilter(filterMap);
  updateCountBadge();
  updateRecommendedTrial();
  updateSubjectProgress();

  // マイルストーンお祝い表示
  if (celebrations.length > 0) await showCelebrations(celebrations);

  updateLifeDisplays();
  if (coinsEarned > 0) animateCoinGain(oldCoinCount, _ud2.coins);
  if (livesGained > 0 || coinsEarned > 0) showRewardToast(livesGained, coinsEarned);

  showScreen('start');
}

// ---- Role selection ----
async function selectRole(role) {
  if (role === 'admin') {
    window.location.href = 'admin.html';
    return;
  }
  currentUser = USERS.find(u => u.key === role);
  if (!currentUser) return;

  // ログイン時のライフ減少チェック（同期）
  const _ud = getUserData(currentUser.key);
  const { livesLost, periodsMissed } = checkLifeOnLogin(_ud);
  saveUserData(currentUser.key, _ud);

  showScreen('loading');
  try {
    await Promise.all([loadQuestions(), loadProgress()]);
    populateFilters();
    updateCountBadge();
    document.getElementById('start-logo').innerHTML = iconHtml(currentUser.icon);
    document.getElementById('start-user-name').textContent = currentUser.name + ' のクイズ';
    setupModeListener();
    showScreen('start');
    updateLifeDisplays();
    if (livesLost > 0) showLifeNotification(livesLost, periodsMissed);
  } catch(e) {
    console.error(e);
    document.getElementById('loading-msg').textContent =
      '読み込みに失敗しました。時間をおいて再読み込みしてください。';
  }
}

// ---- Screen helper ----
function showScreen(name) {
  ['select','loading','start','quiz','result'].forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (!el) return;
    if (s === name) { el.style.display = 'flex'; el.classList.add('active'); }
    else            { el.style.display = 'none';  el.classList.remove('active'); }
  });
}

// モード切替で出題数セレクターを表示・非表示
function setupModeListener() {
  document.querySelectorAll('input[name="mode"]').forEach(r => {
    r.addEventListener('change', () => {
      const m = document.querySelector('input[name="mode"]:checked').value;
      document.getElementById('q-limit-wrap').style.display =
        (m === 'random' || m === 'accuracy') ? 'block' : 'none';
    });
  });
}

// 起動時：シートからユーザーデータを読み込んでから選択画面を表示
window.addEventListener('DOMContentLoaded', async () => {
  showScreen('loading');
  // 全ユーザーのデータを GAS から取得（並列）
  await Promise.all(USERS.map(u => loadUserDataFromSheet(u.key)));

  const cards = document.getElementById('user-cards');
  cards.innerHTML = USERS.map(u => {
    const ud = getUserData(u.key);
    return `
    <div class="role-card nanoha" onclick="selectRole('${u.key}')">
      <div class="role-icon">${iconHtml(u.icon)}</div>
      <div class="role-info">
        <div class="role-name">${u.name}</div>
        <div class="role-life" id="life-${u.key}">${renderHeartsHtml(ud.lives, ud.coins)}</div>
      </div>
      <button class="btn-shop" title="コインでお買い物"
              onclick="event.stopPropagation();location.href='shop.html?user=${u.key}'">🛍</button>
    </div>`;
  }).join('') + `
    <div class="role-card admin" onclick="selectRole('admin')">
      <div class="role-icon">🔐</div>
      <div class="role-info">
        <div class="role-name">管理者</div>
        <div class="role-desc">ダッシュボード・問題管理</div>
      </div>
    </div>`;
  showScreen('select');
});
