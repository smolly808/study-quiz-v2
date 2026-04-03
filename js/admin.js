// =============================================
//  Admin Dashboard Logic (Google Apps Script 版)
// =============================================

let allQuestions    = [];
let progressData    = {};   // { questionId: {correct, wrong, accuracy} }
let currentAdminUser = null;  // 現在ダッシュボードで表示中のユーザー

// ---- API ----
async function apiFetch(params) {
  const url = SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res  = await fetch(url);
  return res.json();
}

// ---- Login ----
function login() {
  const pw = document.getElementById('pw-input').value;
  if (pw === ADMIN_PASSWORD) {
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('admin-section').style.display = 'block';
    initAdmin();
  } else {
    document.getElementById('login-error').textContent = 'パスワードが違います';
  }
}

function logout() {
  document.getElementById('admin-section').style.display = 'none';
  document.getElementById('login-section').style.display = 'flex';
  document.getElementById('pw-input').value = '';
}

// ---- Init ----
async function initAdmin() {
  // ユーザー選択ドロップダウンを生成
  currentAdminUser = USERS[0];
  const sel = document.getElementById('dashboard-user-select');
  sel.innerHTML = USERS.map(u =>
    `<option value="${u.key}">${u.icon} ${u.name}</option>`
  ).join('');

  document.getElementById('dashboard-tab').innerHTML =
    '<p style="text-align:center;padding:40px;color:var(--text-sub)">読み込み中…</p>';

  try {
    await Promise.all([loadQuestions(), loadProgress()]);
    renderDashboard();
    renderQuestionInfo();
  } catch(e) {
    document.getElementById('dashboard-tab').innerHTML =
      `<p style="text-align:center;padding:40px;color:var(--wrong)">読み込みに失敗しました<br>${e.message}</p>`;
  }
}

// ---- ユーザー切替 ----
async function switchDashboardUser() {
  const key = document.getElementById('dashboard-user-select').value;
  currentAdminUser = USERS.find(u => u.key === key) || USERS[0];
  await loadProgress();
  renderDashboard();
}

// ---- Load ----
async function loadQuestions() {
  const json = await apiFetch({});
  allQuestions = (json.data || []).map(q => ({
    ...q,
    id: Number(q.id) || 0
  }));
}

async function loadProgress() {
  const json = await apiFetch({ action: 'progress', user: currentAdminUser.key });
  progressData = {};
  (json.data || []).forEach(p => {
    progressData[String(p.questionId)] = {
      correct:  Number(p.correct)  || 0,
      wrong:    Number(p.wrong)    || 0,
      accuracy: Number(p.accuracy) || 0
    };
  });
}

// ---- Tabs ----
function showTab(name) {
  ['dashboard','questions','shop','settings'].forEach(t => {
    const content = document.getElementById(t + '-tab');
    const btn     = document.getElementById('tab-' + t);
    if (content) content.style.display = t === name ? 'block' : 'none';
    if (btn)     btn.classList.toggle('active', t === name);
  });
  if (name === 'shop')     renderShopRequests();
  if (name === 'settings') renderSettings();
}

// ---- Dashboard ----
function renderDashboard() {
  const entries       = Object.values(progressData);
  const totalAnswered = entries.reduce((s, p) => s + p.correct + p.wrong, 0);
  const totalCorrect  = entries.reduce((s, p) => s + p.correct, 0);
  const overallAcc    = totalAnswered > 0
    ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
  const uniqueQs      = entries.filter(p => (p.correct + p.wrong) > 0).length;

  document.getElementById('stat-total-answered').textContent = totalAnswered.toLocaleString();
  document.getElementById('stat-unique-qs').textContent      = uniqueQs.toLocaleString();
  document.getElementById('stat-accuracy').textContent       = overallAcc + '%';
  document.getElementById('stat-q-count').textContent        = allQuestions.length.toLocaleString();

  // ユーザー名表示を更新
  document.getElementById('dashboard-user-name').textContent =
    currentAdminUser.icon + ' ' + currentAdminUser.name + ' の成績';

  renderSubjectTable();
  renderWeakList();
}

function renderSubjectTable() {
  const subjectMap = {};
  allQuestions.forEach(q => {
    const s = q.subject || '(未分類)';
    if (!subjectMap[s]) subjectMap[s] = { correct: 0, wrong: 0 };
    const p = progressData[String(q.id)];
    if (p) {
      subjectMap[s].correct += p.correct;
      subjectMap[s].wrong   += p.wrong;
    }
  });

  const rows = Object.entries(subjectMap)
    .map(([subj, d]) => {
      const total = d.correct + d.wrong;
      const acc   = total > 0 ? Math.round((d.correct / total) * 100) : null;
      return { subj, total, acc };
    })
    .filter(r => r.total > 0)
    .sort((a, b) => (a.acc ?? 101) - (b.acc ?? 101));

  const tbody = document.getElementById('subject-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-msg">まだ回答データがありません</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.subj}</td>
      <td>${r.total}</td>
      <td>
        <div class="acc-bar-wrap">
          <div class="acc-bar" style="width:${r.acc}px;background:${accColor(r.acc)}"></div>
          <span class="acc-val">${r.acc}%</span>
        </div>
      </td>
    </tr>`).join('');
}

function renderWeakList() {
  const items = allQuestions
    .map(q => {
      const p = progressData[String(q.id)];
      if (!p || (p.correct + p.wrong) < 3) return null;
      return { q, acc: Math.round(p.accuracy * 100), total: p.correct + p.wrong };
    })
    .filter(Boolean)
    .sort((a, b) => a.acc - b.acc)
    .slice(0, 10);

  const wrap = document.getElementById('weak-list');
  if (items.length === 0) {
    wrap.innerHTML = '<p class="empty-msg">3回以上回答した問題がまだありません</p>';
    return;
  }

  wrap.innerHTML = items.map((item, i) => `
    <div class="weak-item">
      <div class="weak-rank">${i + 1}</div>
      <div class="weak-text">
        <div style="font-size:11px;color:var(--text-sub);margin-bottom:2px">
          ${item.q.subject || ''} ${item.q.unit_section || ''}
        </div>
        ${item.q.question || ''}
      </div>
      <div class="weak-acc">${item.acc}%<br>
        <span style="font-size:10px;font-weight:400;color:var(--text-sub)">${item.total}回</span>
      </div>
    </div>`).join('');
}

function accColor(acc) {
  if (acc >= 80) return 'var(--correct)';
  if (acc >= 50) return 'var(--warn)';
  return 'var(--wrong)';
}

// ---- Question info ----
function renderQuestionInfo() {
  document.getElementById('q-total-count').textContent = allQuestions.length;
}

// ---- Reset progress ----
async function clearProgress() {
  const name = currentAdminUser ? currentAdminUser.name : 'ユーザー';
  alert(`${name}の回答履歴をリセットするには、\nスプレッドシートの「progress」シートと「results」シートで\n該当ユーザーの行を削除してください。`);
}

// ---- Shop: 利用申請管理（Google Sheets 版）----
function formatShopDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

async function renderShopRequests() {
  const wrap = document.getElementById('shop-requests-list');
  if (!wrap) return;
  wrap.innerHTML = '<p class="empty-msg" style="padding:20px 0">読み込み中…</p>';

  try {
    const json = await apiFetch({ action: 'getPurchases', all: 'true' });
    const all  = (json.ok && Array.isArray(json.data)) ? json.data : [];

    const pending = all
      .filter(p => p.status === 'pending')
      .map(p => {
        const u = USERS.find(u => u.key === p.userKey);
        return { ...p, userName: u ? u.name : p.userKey };
      })
      .sort((a, b) => (a.requestedAt || '').localeCompare(b.requestedAt || ''));

    if (pending.length === 0) {
      wrap.innerHTML = '<p class="empty-msg">承認待ちの申請はありません</p>';
      return;
    }

    wrap.innerHTML = pending.map(p => `
      <div class="purchase-card" style="margin-bottom:12px">
        <div class="purchase-info">
          <div style="font-size:12px;color:var(--text-sub);margin-bottom:3px">${p.userName}</div>
          <div class="purchase-name">${p.itemName}</div>
          <div class="purchase-date">申請日: ${formatShopDate(p.requestedAt)}</div>
          <div class="purchase-date">購入日: ${formatShopDate(p.purchasedAt)}</div>
        </div>
        <button class="btn-approve" onclick="approveRequest('${p.id}', this)">承認</button>
      </div>
    `).join('');
  } catch(e) {
    wrap.innerHTML = '<p class="empty-msg" style="color:var(--wrong)">読み込みに失敗しました</p>';
  }
}

function nowJST() {
  const d   = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

async function approveRequest(purchaseId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '処理中…'; }
  try {
    await apiFetch({
      action: 'updatePurchase',
      id:     purchaseId,
      status: 'used',
      date:   nowJST(),
    });
    renderShopRequests();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '承認'; }
    alert('エラーが発生しました。もう一度お試しください。');
  }
}

// ---- Settings ----
function renderSettings() {
  const val = localStorage.getItem('quiz_setting_trialRestriction') || 'none';
  document.getElementById('setting-restriction').value = val;
  updateSettingDesc(val);
  document.getElementById('settings-saved').style.display = 'none';
  document.getElementById('setting-restriction').addEventListener('change', function() {
    updateSettingDesc(this.value);
  });
}

function updateSettingDesc(val) {
  const desc = document.getElementById('setting-desc');
  if (val === 'limit') {
    desc.textContent = '選択肢１：全問4回正解済み＆前回と同じ教科の場合は、別の教科をトライしないと同教科のおすすめトライアルが開始できなくなります。';
  } else {
    desc.textContent = '選択肢２：制限なし。いつでも自由におすすめトライアルを開始できます。';
  }
}

function saveSettings() {
  const val = document.getElementById('setting-restriction').value;
  localStorage.setItem('quiz_setting_trialRestriction', val);
  document.getElementById('settings-saved').style.display = 'block';
  setTimeout(() => {
    document.getElementById('settings-saved').style.display = 'none';
  }, 2000);
}

// ---- Boot ----
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pw-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
  });
  showTab('dashboard');
});
