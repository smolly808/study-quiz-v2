// =============================================
//  Quiz App Logic
// =============================================

let allQuestions   = [];
let progressMap    = {};
let filterMap      = {};   // populateFilters で構築、goHome で再利用
let sessionQs      = [];
let currentIdx     = 0;
let sessionResults = [];
let answered       = false;
let audioCtx       = null;
let currentUser    = null;  // { key, name, icon }

// ---- API ----
async function apiFetch(params) {
  const url = SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res  = await fetch(url);
  return res.json();
}

async function loadQuestions() {
  const json = await apiFetch({});
  allQuestions = (json.data || []).map(q => ({ ...q, id: Number(q.id) || 0 }));
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

  // レベル1: まだ全問2回出題されていない小単元 → 順番通り・全問
  for (const sec of sections) {
    if (minTotal(sec) < 2) return { ...sec, mode: 'sequential', limit: Infinity, level: 1 };
  }
  // レベル2: 全問正解2回未達 → 苦手優先・30問
  for (const sec of sections) {
    if (minCorrect(sec) < 2) return { ...sec, mode: 'accuracy', limit: 30, level: 2 };
  }
  // レベル3: 全問正解4回未達 → 苦手優先・30問
  for (const sec of sections) {
    if (minCorrect(sec) < 4) return { ...sec, mode: 'accuracy', limit: 30, level: 3 };
  }
  // レベル4: 全問正解6回未達 → 苦手優先・30問
  for (const sec of sections) {
    if (minCorrect(sec) < 6) return { ...sec, mode: 'accuracy', limit: 30, level: 4 };
  }
  // レベル5: 全達成 → 先頭の小単元（アルファベット順）
  if (sections.length > 0) return { ...sections[0], mode: 'accuracy', limit: 30, level: 5 };

  return null;
}

function updateRecommendedTrial() {
  const subject = document.getElementById('filter-subject').value;
  const card    = document.getElementById('rec-card');
  if (!subject) { card.style.display = 'none'; return; }

  const rec = getRecommendedTrial(subject);
  if (!rec) { card.style.display = 'none'; return; }

  const goalTexts = {
    1: '🌱 まずは全問を2回出題しよう！',
    2: '⭐ 全問2回正解を目指そう！',
    3: '⭐⭐ 全問4回正解を目指そう！',
    4: '⭐⭐⭐ 全問6回正解を目指そう！',
    5: '🏆 全クリア！次はこの単元',
  };

  const qCount = allQuestions.filter(q =>
    q.subject === subject &&
    q.unit_big === rec.unit_big &&
    q.unit_section === rec.unit_section
  ).length;

  const modeText  = rec.mode === 'sequential' ? '📋 順番通り' : '📉 苦手優先';
  const limitText = rec.limit === Infinity ? `全問（${qCount}問）` : `${rec.limit}問`;

  document.getElementById('rec-goal').textContent    = goalTexts[rec.level] || '';
  document.getElementById('rec-unit').textContent    = rec.unit_big    || '（なし）';
  document.getElementById('rec-section').textContent = rec.unit_section || '（なし）';
  document.getElementById('rec-mode').textContent    = modeText;
  document.getElementById('rec-count').textContent   = limitText;

  card.style.display = 'block';
}

function startRecommendedTrial() {
  const subject = document.getElementById('filter-subject').value;
  const rec = getRecommendedTrial(subject);
  if (!rec) return;

  const questions = allQuestions.filter(q =>
    q.subject === subject &&
    q.unit_big === rec.unit_big &&
    q.unit_section === rec.unit_section
  );
  if (questions.length === 0) return;

  sessionQs      = buildSession(questions, rec.mode, rec.limit);
  currentIdx     = 0;
  sessionResults = [];

  showScreen('quiz');
  renderQuestion();
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
    units.sort((a, b) => {
      const minId = u => Math.min(...u.map(q => Number(q.id) || 0));
      return minId(a) - minId(b);
    });
  }

  // 問題数制限（グループは途中で切らない）
  if (limit && limit !== Infinity) {
    let count = 0;
    const limited = [];
    for (const unit of units) {
      if (count >= limit) break;
      limited.push(unit);
      count += unit.length;
    }
    return limited.flat();
  }

  return units.flat();
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

  const badge = [q.subject, q.unit_section].filter(Boolean).join(' › ');
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

  sessionResults.push({ questionId: String(q.id), correct: isCorrect });
  saveProgress(String(q.id), isCorrect, '');
  if (isCorrect) playCorrectSound();
}

// ---- Feedback（mcq / keyword用） ----
function showFeedback(isCorrect, q, userAnswer) {
  sessionResults.push({ questionId: String(q.id), correct: isCorrect });
  saveProgress(String(q.id), isCorrect, userAnswer);
  if (isCorrect) playCorrectSound();

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

function nextQuestion() {
  document.getElementById('feedback-overlay').classList.remove('show');
  currentIdx++;
  if (currentIdx >= sessionQs.length) showResultScreen();
  else renderQuestion();
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
  // 進捗を再取得してセクションマーク等を最新化し、スタート画面へ
  await loadProgress();
  updateSectionFilter(filterMap);
  updateCountBadge();
  updateRecommendedTrial();
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

  showScreen('loading');
  try {
    await Promise.all([loadQuestions(), loadProgress()]);
    populateFilters();
    updateCountBadge();
    // スタート画面のユーザー名を更新
    document.getElementById('start-user-name').textContent =
      currentUser.icon + ' ' + currentUser.name + ' のクイズ';
    setupModeListener();
    showScreen('start');
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

// 起動時：ユーザーカードを生成して選択画面を表示
window.addEventListener('DOMContentLoaded', () => {
  const cards = document.getElementById('user-cards');
  cards.innerHTML = USERS.map(u => `
    <div class="role-card nanoha" onclick="selectRole('${u.key}')">
      <div class="role-icon">${u.icon}</div>
      <div class="role-info">
        <div class="role-name">${u.name}</div>
        <div class="role-desc">クイズをはじめる</div>
      </div>
    </div>`).join('') + `
    <div class="role-card admin" onclick="selectRole('admin')">
      <div class="role-icon">🔐</div>
      <div class="role-info">
        <div class="role-name">管理者</div>
        <div class="role-desc">ダッシュボード・問題管理</div>
      </div>
    </div>`;
  showScreen('select');
});
