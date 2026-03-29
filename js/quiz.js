// =============================================
//  Quiz App Logic  (Google Apps Script 版)
// =============================================

// ---- State ----
let allQuestions   = [];   // 全問題
let progressMap    = {};   // { questionId: {correct, wrong, accuracy} }
let sessionQs      = [];   // 今回出題する問題リスト
let currentIdx     = 0;
let sessionResults = [];   // [{questionId, correct}]
let answered       = false;

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

// ---- Load questions ----
async function loadQuestions() {
  const json = await apiFetch({});
  allQuestions = (json.data || []).map(q => ({
    ...q,
    id: Number(q.id) || 0
  }));
}

// ---- Load progress ----
async function loadProgress() {
  try {
    const json = await apiFetch({ action: 'progress', user: USER_KEY });
    progressMap = {};
    (json.data || []).forEach(p => {
      progressMap[String(p.questionId)] = {
        correct:  Number(p.correct)  || 0,
        wrong:    Number(p.wrong)    || 0,
        accuracy: Number(p.accuracy) || 0
      };
    });
  } catch(e) {
    progressMap = {};
  }
}

// ---- Filters ----
function populateFilters() {
  const subjectMap = {};
  allQuestions.forEach(q => {
    if (!q.subject) return;
    if (!subjectMap[q.subject]) subjectMap[q.subject] = new Set();
    if (q.unit_big) subjectMap[q.subject].add(q.unit_big);
  });

  const subjectEl = document.getElementById('filter-subject');
  subjectEl.innerHTML = '<option value="">すべての教科</option>';
  Object.keys(subjectMap).sort().forEach(s => {
    subjectEl.innerHTML += `<option value="${s}">${s}</option>`;
  });

  subjectEl.addEventListener('change', () => {
    updateUnitFilter(subjectMap);
    updateCountBadge();
  });
  document.getElementById('filter-unit').addEventListener('change', updateCountBadge);
  document.getElementById('range-from').addEventListener('input', updateCountBadge);
  document.getElementById('range-to').addEventListener('input',   updateCountBadge);

  updateUnitFilter(subjectMap);
}

function updateUnitFilter(subjectMap) {
  const s  = document.getElementById('filter-subject').value;
  const units = s ? [...(subjectMap[s] || [])] : [];
  const el = document.getElementById('filter-unit');
  el.innerHTML = '<option value="">すべての単元</option>';
  units.sort().forEach(u => { el.innerHTML += `<option value="${u}">${u}</option>`; });
}

function getFilteredQuestions() {
  const subject = document.getElementById('filter-subject').value;
  const unit    = document.getElementById('filter-unit').value;
  const from    = parseInt(document.getElementById('range-from').value) || 1;
  const to      = parseInt(document.getElementById('range-to').value)   || 99999;

  return allQuestions.filter(q => {
    if (subject && q.subject !== subject)   return false;
    if (unit    && q.unit_big !== unit)     return false;
    const id = Number(q.id);
    if (!isNaN(id) && (id < from || id > to)) return false;
    return true;
  });
}

function updateCountBadge() {
  document.getElementById('q-count').textContent = getFilteredQuestions().length;
}

// ---- Start Quiz ----
function startQuiz() {
  let questions = getFilteredQuestions();
  if (questions.length === 0) {
    alert('条件に合う問題がありません。フィルターを変更してください。');
    return;
  }

  const mode = document.querySelector('input[name="mode"]:checked').value;

  if (mode === 'random') {
    questions = [...questions].sort(() => Math.random() - 0.5);
  } else if (mode === 'accuracy') {
    questions = [...questions].sort((a, b) => {
      const pa = progressMap[String(a.id)];
      const pb = progressMap[String(b.id)];
      const aa = pa ? pa.accuracy : -1;   // 未回答を最優先
      const ab = pb ? pb.accuracy : -1;
      return aa - ab;
    });
  }

  sessionQs      = questions;
  currentIdx     = 0;
  sessionResults = [];

  showScreen('quiz');
  renderQuestion();
}

// ---- Render Question ----
function renderQuestion() {
  answered = false;
  const q = sessionQs[currentIdx];

  // Progress
  const pct = (currentIdx / sessionQs.length) * 100;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('q-current').textContent = currentIdx + 1;
  document.getElementById('q-total').textContent   = sessionQs.length;

  // Badge
  const badge = [q.subject, q.unit_section].filter(Boolean).join(' › ');
  document.getElementById('question-badge').textContent = badge;

  // Question text
  document.getElementById('question-text').textContent = q.question || '';

  // Image
  const imgEl = document.getElementById('question-img');
  if (q.image_url) {
    imgEl.src = q.image_url;
    imgEl.style.display = 'block';
  } else {
    imgEl.style.display = 'none';
  }

  // Answer area
  const area = document.getElementById('answer-area');
  if (q.type === 'choice') {
    const keys = ['a','b','c','d'].filter(k => q['choice_' + k]);
    area.innerHTML = `
      <div class="choices">
        ${keys.map(k => `
          <button class="choice-btn" onclick="submitChoice('${k}')" data-key="${k}">
            <span style="color:var(--text-sub);font-weight:700;margin-right:8px">${k.toUpperCase()}.</span>${q['choice_' + k]}
          </button>`).join('')}
      </div>`;
  } else {
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

// ---- Submit ----
function submitChoice(key) {
  if (answered) return;
  answered = true;

  const q          = sessionQs[currentIdx];
  const correctKey = (q.correct || '').toLowerCase().trim();
  const isCorrect  = correctKey === key;

  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.key === correctKey)         btn.classList.add('correct-choice');
    if (btn.dataset.key === key && !isCorrect)  btn.classList.add('wrong-choice');
  });

  showFeedback(isCorrect, q, key);
}

function submitKeyword() {
  if (answered) return;
  const input = (document.getElementById('keyword-input')?.value || '').trim();
  if (!input) return;
  answered = true;

  const q = sessionQs[currentIdx];
  const keywords = (q.keywords || q.answer || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  const isCorrect = keywords.some(k =>
    k === input || k.toLowerCase() === input.toLowerCase()
  );

  const inputEl = document.getElementById('keyword-input');
  if (inputEl) inputEl.disabled = true;
  const btnEl = document.querySelector('.btn-answer');
  if (btnEl) btnEl.disabled = true;

  showFeedback(isCorrect, q, input);
}

// ---- Feedback ----
function showFeedback(isCorrect, q, userAnswer) {
  sessionResults.push({ questionId: String(q.id), correct: isCorrect });
  saveProgress(String(q.id), isCorrect, userAnswer);

  document.getElementById('fb-icon').textContent  = isCorrect ? '⭕' : '❌';
  document.getElementById('fb-title').textContent = isCorrect ? 'せいかい！' : 'ざんねん…';
  document.getElementById('fb-title').className   = 'feedback-title ' + (isCorrect ? 'correct' : 'wrong');
  document.getElementById('fb-answer').textContent = q.answer || '';

  const expEl = document.getElementById('fb-explanation');
  expEl.textContent    = q.explanation || '';
  expEl.style.display  = q.explanation ? 'block' : 'none';

  document.getElementById('feedback-overlay').classList.add('show');
}

function nextQuestion() {
  document.getElementById('feedback-overlay').classList.remove('show');
  currentIdx++;
  if (currentIdx >= sessionQs.length) {
    showResultScreen();
  } else {
    renderQuestion();
  }
}

// ---- Save progress (fire & forget) ----
function saveProgress(questionId, isCorrect, answer) {
  const params = new URLSearchParams({
    action:     'saveAnswer',
    user:       USER_KEY,
    questionId: questionId,
    correct:    isCorrect ? '1' : '0',
    answer:     answer || ''
  });
  fetch(SCRIPT_URL + '?' + params.toString())
    .catch(err => console.warn('進捗の保存に失敗:', err));

  // ローカルのprogressMapも即時更新（苦手優先の並び替えに使用）
  const prev   = progressMap[questionId] || { correct: 0, wrong: 0 };
  const newC   = prev.correct + (isCorrect ? 1 : 0);
  const newW   = prev.wrong   + (isCorrect ? 0 : 1);
  const total  = newC + newW;
  progressMap[questionId] = {
    correct:  newC,
    wrong:    newW,
    accuracy: total > 0 ? newC / total : 0
  };
}

// ---- Result ----
function showResultScreen() {
  const correct = sessionResults.filter(r => r.correct).length;
  const total   = sessionResults.length;
  const pct     = Math.round((correct / total) * 100);

  const emoji = pct >= 90 ? '🎉' : pct >= 70 ? '😊' : pct >= 50 ? '😐' : '😢';
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
  await loadProgress();
  updateCountBadge();
  showScreen('start');
}

// ---- Screen helper ----
function showScreen(name) {
  ['loading','start','quiz','result'].forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (!el) return;
    if (s === name) { el.style.display = 'flex'; el.classList.add('active'); }
    else            { el.style.display = 'none';  el.classList.remove('active'); }
  });
}

// ---- Boot ----
window.addEventListener('DOMContentLoaded', init);
