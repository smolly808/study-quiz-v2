// =============================================
//  Quiz App Logic
// =============================================

let allQuestions   = [];
let progressMap    = {};
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

// ---- Initialize ----
async function init() {
  showScreen('loading');
  try {
    await Promise.all([loadQuestions(), loadProgress()]);
    populateFilters();
    updateCountBadge();
    showScreen('start');
  } catch(e) {
    console.error(e);
    document.getElementById('loading-msg').textContent =
      '読み込みに失敗しました。時間をおいて再読み込みしてください。';
  }
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

  const subjectEl = document.getElementById('filter-subject');
  subjectEl.innerHTML = '<option value="">すべての教科</option>';
  Object.keys(map).sort().forEach(s => {
    subjectEl.innerHTML += `<option value="${s}">${s}</option>`;
  });

  subjectEl.addEventListener('change', () => {
    updateUnitFilter(map);
    updateSectionFilter(map);
    updateCountBadge();
  });
  document.getElementById('filter-unit').addEventListener('change', () => {
    updateSectionFilter(map);
    updateCountBadge();
  });
  document.getElementById('filter-section').addEventListener('change', updateCountBadge);
  document.getElementById('range-from').addEventListener('input', updateCountBadge);
  document.getElementById('range-to').addEventListener('input',   updateCountBadge);

  updateUnitFilter(map);
  updateSectionFilter(map);
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
    // unit_big未選択 → その教科の全unit_sectionを列挙
    const all = new Set();
    Object.values(map[s]).forEach(sSet => sSet.forEach(sec => all.add(sec)));
    sections = [...all];
  }
  const el = document.getElementById('filter-section');
  el.innerHTML = '<option value="">すべての小単元</option>';
  sections.sort().forEach(sec => { el.innerHTML += `<option value="${sec}">${sec}</option>`; });
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

function updateCountBadge() {
  document.getElementById('q-count').textContent = getFilteredQuestions().length;
}

// ---- Build session（グループ順序を保持） ----
function buildSession(questions, mode) {
  // group_idが設定された問題はグループ単位で扱う
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

  // グループ内はgroup_order順に固定
  Object.values(groupMap).forEach(g => {
    g.sort((a, b) => Number(a.group_order || 0) - Number(b.group_order || 0));
  });

  // ユニット = 1問(singleton) または グループ全体
  const units = [
    ...singletons.map(q => [q]),
    ...Object.values(groupMap)
  ];

  if (mode === 'random') {
    units.sort(() => Math.random() - 0.5);
  } else if (mode === 'accuracy') {
    units.sort((a, b) => {
      const avg = unit => {
        const vals = unit.map(q => {
          const p = progressMap[String(q.id)];
          return p ? p.accuracy : -1;
        });
        return vals.reduce((s, v) => s + v, 0) / vals.length;
      };
      return avg(a) - avg(b);
    });
  } else {
    // sequential: 最小IDで並べ直し
    units.sort((a, b) => {
      const minId = u => Math.min(...u.map(q => Number(q.id) || 0));
      return minId(a) - minId(b);
    });
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
  const mode = document.querySelector('input[name="mode"]:checked').value;

  sessionQs      = buildSession(questions, mode);
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

  const imgEl = document.getElementById('question-img');
  if (q.image_url) { imgEl.src = q.image_url; imgEl.style.display = 'block'; }
  else             { imgEl.style.display = 'none'; }

  const area = document.getElementById('answer-area');

  if (q.type === 'mcq' || q.type === 'choice') {
    // ---- 4択 ----
    const keys = ['a','b','c','d'].filter(k => q['choice_' + k]);
    area.innerHTML = `
      <div class="choices">
        ${keys.map(k => `
          <button class="choice-btn" onclick="submitChoice('${k}')" data-key="${k}">
            <span style="color:var(--text-sub);font-weight:700;margin-right:8px">${k.toUpperCase()}.</span>${q['choice_' + k]}
          </button>`).join('')}
      </div>`;

  } else if (q.type === 'self') {
    // ---- 自己採点 ----
    area.innerHTML = `
      <button class="btn-show-answer" onclick="showSelfAnswer()">答えを見る 👀</button>`;

  } else {
    // ---- キーワード入力 ----
    area.innerHTML = `
      <div class="keyword-wrap">
        <input type="text" id="keyword-input"
               placeholder="こたえを入力…"
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
  const isCorrect = keywords.some(k =>
    k === input || k.toLowerCase() === input.toLowerCase()
  );

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

  const expEl = document.getElementById('fb-explanation');
  expEl.textContent   = q.explanation || '';
  expEl.style.display = q.explanation ? 'block' : 'none';

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

  const expEl = document.getElementById('fb-explanation');
  expEl.textContent   = q.explanation || '';
  expEl.style.display = q.explanation ? 'block' : 'none';

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
  showScreen('select');
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
