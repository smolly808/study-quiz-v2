// =============================================
//  Shop Logic  (Google Sheets 版)
//  Version: Ver.2026.04.02_v1
// =============================================

const SHOP_ITEMS = [
  { id: 'massage5',  name: 'マッサージ5分券',              cost: 15   },
  { id: 'massage10', name: 'マッサージ10分券',             cost: 30   },
  { id: 'iphone1h',  name: 'iPhone制限 1時間延長',         cost: 75   },
  { id: 'iphone1d',  name: 'iPhone制限 1日延長',           cost: 150  },
  { id: 'smaho3gb',  name: 'スマホ 3ギガバイト購入',         cost: 75   },
  { id: 'stamp',     name: 'ふつうの軽音部のLINEスタンプ',  cost: 750  },
];

let shopUserKey   = null;
let pendingItemId = null;
let pendingReqId  = null;

// インメモリキャッシュ
let _udShop    = null;   // ユーザーデータ
let _purchases = null;   // 購入履歴

// ---- API ----
async function apiFetch(params) {
  const url = SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res  = await fetch(url);
  return res.json();
}

// ---- ユーザーデータ ----
async function loadUserData() {
  try {
    const json = await apiFetch({ action: 'getUserData', user: shopUserKey });
    if (json.ok && json.data) {
      const d = json.data;
      _udShop = {
        lives:         typeof d.lives === 'number' ? d.lives : 3,
        coins:         typeof d.coins === 'number' ? d.coins : 0,
        lastTrialDate: d.lastTrialDate || null,
        lastLoginDate: d.lastLoginDate || null,
      };
      return;
    }
  } catch(e) {}
  // フォールバック: localStorage
  try {
    const raw = localStorage.getItem('quiz_userdata_' + shopUserKey);
    const d   = raw ? JSON.parse(raw) : {};
    _udShop = {
      lives:         typeof d.lives === 'number' ? d.lives : 3,
      coins:         typeof d.coins === 'number' ? d.coins : 0,
      lastTrialDate: d.lastTrialDate || null,
      lastLoginDate: d.lastLoginDate || null,
    };
  } catch(e) { _udShop = { lives: 3, coins: 0, lastTrialDate: null, lastLoginDate: null }; }
}

function saveUserData() {
  // ローカル同期
  try { localStorage.setItem('quiz_userdata_' + shopUserKey, JSON.stringify(_udShop)); } catch(e) {}
  // GAS 非同期保存
  apiFetch({
    action:        'saveUserData',
    user:          shopUserKey,
    lives:         _udShop.lives,
    coins:         _udShop.coins,
    lastTrialDate: _udShop.lastTrialDate || '',
    lastLoginDate: _udShop.lastLoginDate || '',
  }).catch(() => {});
}

// ---- 購入履歴 ----
async function loadPurchases() {
  try {
    const json = await apiFetch({ action: 'getPurchases', user: shopUserKey });
    if (json.ok && Array.isArray(json.data)) {
      _purchases = json.data;
      return;
    }
  } catch(e) {}
  // フォールバック: localStorage
  try {
    const raw = localStorage.getItem('quiz_purchases_' + shopUserKey);
    _purchases = raw ? JSON.parse(raw) : [];
  } catch(e) { _purchases = []; }
}

// ---- ユーティリティ ----
// JST（日本時間）の現在時刻をISO形式で返す
function nowJST() {
  const d   = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

// ---- 描画 ----
function renderPage() {
  document.getElementById('shop-coin-count').textContent = _udShop.coins;
  renderUnused();
  renderShopItems();
  if (document.getElementById('history-section').style.display !== 'none') {
    renderHistory();
  }
}

function renderShopItems() {
  const wrap = document.getElementById('shop-items-list');
  wrap.innerHTML = SHOP_ITEMS.map(item => `
    <div class="shop-item-card">
      <div class="shop-item-info">
        <div class="shop-item-name">${item.name}</div>
        <div class="shop-item-cost">
          <span class="coin-icon"></span>${item.cost}コイン
        </div>
      </div>
      <button class="btn-buy" onclick="askBuy('${item.id}')"
              ${_udShop.coins < item.cost ? 'disabled' : ''}>購入</button>
    </div>
  `).join('');
}

function renderUnused() {
  const unused  = _purchases.filter(p => p.status === 'unused');
  const section = document.getElementById('unused-section');
  const list    = document.getElementById('unused-list');
  if (unused.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = unused.map(p => `
    <div class="purchase-card">
      <div class="purchase-info">
        <div class="purchase-name">${p.itemName}</div>
        <div class="purchase-date">購入日: ${formatDate(p.purchasedAt)}</div>
      </div>
      <button class="btn-request" onclick="askRequest('${p.id}')">利用申請</button>
    </div>
  `).join('');
}

function renderHistory() {
  const sorted = _purchases.slice().sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
  const list   = document.getElementById('history-list');
  if (sorted.length === 0) {
    list.innerHTML = '<p class="empty-msg">購入履歴はありません</p>';
    return;
  }
  const badgeHtml = {
    unused:  '<span class="status-badge unused">未使用</span>',
    pending: '<span class="status-badge pending">申請中</span>',
    used:    '<span class="status-badge used">使用済み</span>',
  };
  list.innerHTML = sorted.map(p => `
    <div class="purchase-card">
      <div class="purchase-info">
        <div class="purchase-name">${p.itemName}</div>
        <div class="purchase-date">購入日: ${formatDate(p.purchasedAt)}</div>
        ${p.approvedAt ? `<div class="purchase-date">承認日: ${formatDate(p.approvedAt)}</div>` : ''}
      </div>
      <div>${badgeHtml[p.status] || ''}</div>
    </div>
  `).join('');
}

function toggleHistory() {
  const sec  = document.getElementById('history-section');
  const btn  = document.getElementById('btn-history');
  const show = sec.style.display === 'none';
  sec.style.display = show ? 'block' : 'none';
  btn.textContent   = show ? '📋 購入履歴を閉じる' : '📋 購入履歴';
  if (show) renderHistory();
}

// ---- 購入 ----
function askBuy(itemId) {
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item || _udShop.coins < item.cost) return;
  pendingItemId = itemId;
  document.getElementById('confirm-msg').textContent =
    `コイン${item.cost}枚を払って、「${item.name}」を購入しますか？`;
  document.getElementById('confirm-overlay').style.display = 'flex';
}

function cancelPurchase() {
  pendingItemId = null;
  document.getElementById('confirm-overlay').style.display = 'none';
}

function doPurchase() {
  if (!pendingItemId) return;
  const item = SHOP_ITEMS.find(i => i.id === pendingItemId);
  if (!item || _udShop.coins < item.cost) { cancelPurchase(); return; }

  // コイン消費
  _udShop.coins -= item.cost;
  saveUserData();

  // 購入レコード作成
  const newPurchase = {
    id:          Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    itemId:      item.id,
    itemName:    item.name,
    cost:        item.cost,
    purchasedAt: nowJST(),
    status:      'unused',
    requestedAt: null,
    approvedAt:  null,
  };
  _purchases.push(newPurchase);

  // GAS に非同期保存
  apiFetch({
    action:      'addPurchase',
    user:        shopUserKey,
    id:          newPurchase.id,
    itemId:      newPurchase.itemId,
    itemName:    encodeURIComponent(newPurchase.itemName),
    cost:        newPurchase.cost,
    purchasedAt: newPurchase.purchasedAt,
  }).catch(() => {});

  cancelPurchase();
  renderPage();
}

// ---- 利用申請 ----
function askRequest(purchaseId) {
  const p = _purchases.find(x => x.id === purchaseId);
  if (!p) return;
  pendingReqId = purchaseId;
  document.getElementById('request-msg').textContent =
    `「${p.itemName}」の利用申請をしますか？管理者が承認すると使用済みになります。`;
  document.getElementById('request-overlay').style.display = 'flex';
}

function cancelRequest() {
  pendingReqId = null;
  document.getElementById('request-overlay').style.display = 'none';
}

function doRequest() {
  if (!pendingReqId) return;
  const p = _purchases.find(x => x.id === pendingReqId);
  if (p) {
    p.status      = 'pending';
    p.requestedAt = nowJST();
    // GAS に非同期保存
    apiFetch({
      action: 'updatePurchase',
      id:     p.id,
      status: 'pending',
      date:   p.requestedAt,
    }).catch(() => {});
  }
  cancelRequest();
  renderPage();
}

// ---- 起動 ----
window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  shopUserKey  = params.get('user');
  const user   = (typeof USERS !== 'undefined') && USERS.find(u => u.key === shopUserKey);
  if (!user) { location.href = 'index.html'; return; }

  document.getElementById('shop-user-name').textContent = user.name + ' のお買い物';

  // ローディング表示
  document.getElementById('shop-items-list').innerHTML =
    '<p style="text-align:center;padding:24px;color:var(--text-sub)">読み込み中…</p>';

  // GAS からデータ取得（並列）
  await Promise.all([loadUserData(), loadPurchases()]);
  renderPage();
});
