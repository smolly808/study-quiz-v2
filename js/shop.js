// =============================================
//  Shop Logic
//  Version: Ver.2026.04.01_v6
// =============================================

const SHOP_ITEMS = [
  { id: 'massage5',  name: 'マッサージ5分券',              cost: 1   },
  { id: 'massage10', name: 'マッサージ10分券',             cost: 2   },
  { id: 'stamp',     name: 'ふつうの軽音部のLINEスタンプ',  cost: 100 },
];

let shopUserKey   = null;
let pendingItemId = null;  // 購入確認中のアイテムID
let pendingReqId  = null;  // 利用申請確認中の購入ID

// ---- Data helpers ----
function getUserData(key) {
  try {
    const raw = localStorage.getItem('quiz_userdata_' + key);
    const d   = raw ? JSON.parse(raw) : {};
    return {
      lives:         typeof d.lives  === 'number' ? d.lives  : 3,
      coins:         typeof d.coins  === 'number' ? d.coins  : 0,
      lastTrialDate: d.lastTrialDate || null,
      lastLoginDate: d.lastLoginDate || null,
    };
  } catch(e) { return { lives: 3, coins: 0, lastTrialDate: null, lastLoginDate: null }; }
}

function saveUserData(key, data) {
  try { localStorage.setItem('quiz_userdata_' + key, JSON.stringify(data)); } catch(e) {}
}

function getPurchases(key) {
  try {
    const raw = localStorage.getItem('quiz_purchases_' + key);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function savePurchases(key, data) {
  try { localStorage.setItem('quiz_purchases_' + key, JSON.stringify(data)); } catch(e) {}
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

// ---- Render ----
function renderPage() {
  const ud = getUserData(shopUserKey);
  document.getElementById('shop-coin-count').textContent = ud.coins;
  renderUnused();
  renderShopItems(ud);
  // 履歴が開いていれば再描画
  if (document.getElementById('history-section').style.display !== 'none') {
    renderHistory();
  }
}

function renderShopItems(ud) {
  if (!ud) ud = getUserData(shopUserKey);
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
              ${ud.coins < item.cost ? 'disabled' : ''}>購入</button>
    </div>
  `).join('');
}

function renderUnused() {
  const purchases = getPurchases(shopUserKey).filter(p => p.status === 'unused');
  const section   = document.getElementById('unused-section');
  const list      = document.getElementById('unused-list');

  if (purchases.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  list.innerHTML = purchases.map(p => `
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
  const purchases = getPurchases(shopUserKey)
    .slice().sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
  const list = document.getElementById('history-list');

  if (purchases.length === 0) {
    list.innerHTML = '<p class="empty-msg">購入履歴はありません</p>';
    return;
  }

  const statusHtmlMap = {
    unused:  '<span class="status-badge unused">未使用</span>',
    pending: '<span class="status-badge pending">申請中</span>',
    used:    '<span class="status-badge used">使用済み</span>',
  };

  list.innerHTML = purchases.map(p => `
    <div class="purchase-card">
      <div class="purchase-info">
        <div class="purchase-name">${p.itemName}</div>
        <div class="purchase-date">購入日: ${formatDate(p.purchasedAt)}</div>
        ${p.approvedAt ? `<div class="purchase-date">承認日: ${formatDate(p.approvedAt)}</div>` : ''}
      </div>
      <div>${statusHtmlMap[p.status] || ''}</div>
    </div>
  `).join('');
}

function toggleHistory() {
  const sec = document.getElementById('history-section');
  const btn = document.getElementById('btn-history');
  const show = sec.style.display === 'none';
  sec.style.display = show ? 'block' : 'none';
  btn.textContent = show ? '📋 購入履歴を閉じる' : '📋 購入履歴';
  if (show) renderHistory();
}

// ---- Purchase ----
function askBuy(itemId) {
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return;
  const ud = getUserData(shopUserKey);
  if (ud.coins < item.cost) return;

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
  if (!item) return;

  const ud = getUserData(shopUserKey);
  if (ud.coins < item.cost) { cancelPurchase(); return; }

  ud.coins -= item.cost;
  saveUserData(shopUserKey, ud);

  const purchases = getPurchases(shopUserKey);
  purchases.push({
    id:          Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    itemId:      item.id,
    itemName:    item.name,
    cost:        item.cost,
    purchasedAt: new Date().toISOString(),
    status:      'unused',
    requestedAt: null,
    approvedAt:  null,
  });
  savePurchases(shopUserKey, purchases);

  cancelPurchase();
  renderPage();
}

// ---- Request use ----
function askRequest(purchaseId) {
  const purchases = getPurchases(shopUserKey);
  const p = purchases.find(x => x.id === purchaseId);
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
  const purchases = getPurchases(shopUserKey);
  const p = purchases.find(x => x.id === pendingReqId);
  if (p) {
    p.status      = 'pending';
    p.requestedAt = new Date().toISOString();
    savePurchases(shopUserKey, purchases);
  }
  cancelRequest();
  renderPage();
}

// ---- Boot ----
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  shopUserKey  = params.get('user');

  const user = (typeof USERS !== 'undefined') && USERS.find(u => u.key === shopUserKey);
  if (!user) {
    location.href = 'index.html';
    return;
  }

  document.getElementById('shop-user-name').textContent = user.name + ' のお買い物';
  renderPage();
});
