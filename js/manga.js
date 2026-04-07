// =============================================
//  マンガコーナー Logic
// =============================================

let mangaUserKey = null;
let allManga     = [];   // [{ name, fileId }]
let unlockedSet  = new Set();

// ---- API ----
async function apiFetch(params) {
  const url = SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res  = await fetch(url);
  return res.json();
}

// ---- ファイル名のパース ----
// 例: "00001マンガのタイトル.pdf" → { sortKey: "00001", displayName: "マンガのタイトル" }
function parseFileName(name) {
  const sortKey     = name.slice(0, 5);
  const withoutExt  = name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
  const displayName = withoutExt.slice(5);
  return { sortKey, displayName };
}

// ---- 描画 ----
function renderMangaList() {
  const wrap     = document.getElementById('manga-list');
  const statusEl = document.getElementById('manga-status');

  const total    = allManga.length;
  const unlocked = allManga.filter(m => unlockedSet.has(m.name)).length;

  statusEl.textContent = `解放済み ${unlocked} / ${total} 冊`;

  if (total === 0) {
    wrap.innerHTML = '<p style="text-align:center;padding:40px;color:var(--text-sub)">まだマンガがありません</p>';
    return;
  }

  wrap.innerHTML = allManga.map(m => {
    const { displayName } = parseFileName(m.name);
    const isUnlocked      = unlockedSet.has(m.name);
    const driveUrl        = `https://drive.google.com/file/d/${m.fileId}/view`;

    if (isUnlocked) {
      return `
        <a href="${driveUrl}" target="_blank" rel="noopener" class="manga-btn unlocked">
          <span class="manga-icon">📖</span>
          <span class="manga-name">${displayName}</span>
          <span class="manga-arrow">→</span>
        </a>`;
    } else {
      return `
        <div class="manga-btn locked">
          <span class="manga-icon">🔒</span>
          <span class="manga-name">${displayName}</span>
          <span class="manga-locked-msg">レベルアップで解放</span>
        </div>`;
    }
  }).join('');
}

// ---- 起動 ----
window.addEventListener('DOMContentLoaded', async () => {
  const params    = new URLSearchParams(location.search);
  mangaUserKey    = params.get('user');
  const user      = (typeof USERS !== 'undefined') && USERS.find(u => u.key === mangaUserKey);
  if (!user) { location.href = 'index.html'; return; }

  document.getElementById('manga-user-name').textContent = user.name + ' のマンガ';

  try {
    const [listJson, unlocksJson] = await Promise.all([
      apiFetch({ action: 'getMangaList' }),
      apiFetch({ action: 'getMangaUnlocks', user: mangaUserKey }),
    ]);
    allManga    = (listJson.ok && Array.isArray(listJson.data)) ? listJson.data : [];
    unlockedSet = new Set((unlocksJson.ok && Array.isArray(unlocksJson.data)) ? unlocksJson.data : []);
  } catch(e) {
    allManga    = [];
    unlockedSet = new Set();
  }

  renderMangaList();
});
