/* ============================================
   公司內部點餐工具 - 應用程式邏輯 (all.js)
   
   技術棧：
   - Google Identity Services (GSI) 進行 OAuth 登入
   - Google Sheets API v4 直接讀寫試算表
   - 純 Vanilla JavaScript，無框架
   ============================================ */

// ─────────────────────────────────────────────
// ★★★ 請在此填入您的 GCP 設定 ★★★
// ─────────────────────────────────────────────
const CLIENT_ID = '66868160153-7ehvpp3akn4412gdv2rrc6f2g9oj2pur.apps.googleusercontent.com';
const SPREADSHEET_ID = '1oHZeCYwX71MsrfYLhEkTpR8Ifoj-umBDShRRmkbQnP0';

// Google Sheets API 需要的 OAuth Scope
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

// 工作表名稱常數
const SHEET_USERS = 'Users';
const SHEET_MENU = 'Menu';
const SHEET_TODAY_CONFIG = 'TodayConfig';
const SHEET_ORDERS = 'Orders';


// ─────────────────────────────────────────────
// 全域狀態
// ─────────────────────────────────────────────
let currentUser = {
  email: '',
  name: '',
  role: '',          // '管理員' 或 '一般成員'
  accessToken: ''
};

let menuData = [];            // Menu 工作表的完整資料
let todayRestaurants = [];    // 今日開放的餐廳名稱
let todayOrders = [];         // 今日訂單
let allRestaurantNames = [];  // 所有不重複的餐廳名稱

// 篩選狀態
let activeRestaurant = '';    // 目前選擇的餐廳篩選
let activeCategory = '';      // 目前選擇的分類篩選

// Google API 載入狀態
let gapiLoaded = false;
let gsiLoaded = false;
let tokenClient = null;


// ─────────────────────────────────────────────
// DOM 元素快取
// ─────────────────────────────────────────────
const $loginSection = () => document.getElementById('login-section');
const $mainSection = () => document.getElementById('main-section');
const $unauthorizedSection = () => document.getElementById('unauthorized-section');
const $userDisplayName = () => document.getElementById('user-display-name');
const $tabAdminBtn = () => document.getElementById('tab-admin-btn');
const $todayRestaurantsText = () => document.getElementById('today-restaurants-text');
const $restaurantFilter = () => document.getElementById('restaurant-filter');
const $categoryFilter = () => document.getElementById('category-filter');
const $menuList = () => document.getElementById('menu-list');
const $orderSummaryList = () => document.getElementById('order-summary-list');
const $orderSummaryActions = () => document.getElementById('order-summary-actions');
const $adminRestaurantCheckboxes = () => document.getElementById('admin-restaurant-checkboxes');
const $toastContainer = () => document.getElementById('toast-container');
const $modalOverlay = () => document.getElementById('modal-overlay');
const $modalTitle = () => document.getElementById('modal-title');
const $modalMessage = () => document.getElementById('modal-message');
const $modalConfirmBtn = () => document.getElementById('modal-confirm-btn');


// ─────────────────────────────────────────────
// 初始化：等待 Google API 載入完成
// ─────────────────────────────────────────────

/**
 * 當 Google API Client Library (gapi) 載入完成後的回呼
 * 會自動被 gapi loader 呼叫
 */
function gapiInit() {
  gapi.load('client', async () => {
    await gapi.client.init({
      apiKey: API_KEY,
      discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
    });
    gapiLoaded = true;
    console.log('[初始化] gapi client 已載入');
    checkAllLoaded();
  });
}

/**
 * 當 Google Identity Services (GSI) 載入完成後的回呼
 */
function gsiInit() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: handleTokenResponse,
  });
  gsiLoaded = true;
  console.log('[初始化] GSI token client 已建立');
  checkAllLoaded();
}

/**
 * 檢查兩個 API 是否都載入完畢
 */
function checkAllLoaded() {
  if (gapiLoaded && gsiLoaded) {
    console.log('[初始化] 所有 Google API 已就緒');
  }
}

// 監聽 gapi.js 與 gsi/client 的載入
window.addEventListener('load', () => {
  // 等待 gapi 載入
  const waitForGapi = setInterval(() => {
    if (typeof gapi !== 'undefined') {
      clearInterval(waitForGapi);
      gapiInit();
    }
  }, 100);

  // 等待 GSI 載入
  const waitForGsi = setInterval(() => {
    if (typeof google !== 'undefined' && google.accounts) {
      clearInterval(waitForGsi);
      gsiInit();
    }
  }, 100);
});


// ─────────────────────────────────────────────
// Google 登入 / 登出
// ─────────────────────────────────────────────

/**
 * 點擊「Google 登入」按鈕時觸發
 * 使用 OAuth2 Token Client 請求存取權杖
 */
function handleGoogleLogin() {
  if (!tokenClient) {
    showToast('Google 服務尚未載入，請稍候再試', 'error');
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

/**
 * 接收到 OAuth2 存取權杖後的回呼
 * @param {Object} resp - Google 回傳的 token 物件
 */
async function handleTokenResponse(resp) {
  if (resp.error) {
    console.error('[登入] Token 錯誤:', resp);
    showToast('登入失敗，請再試一次', 'error');
    return;
  }

  currentUser.accessToken = resp.access_token;

  // 用 access token 取得使用者基本資訊
  try {
    const userInfo = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${resp.access_token}` }
    });
    const data = await userInfo.json();
    currentUser.email = data.email;
    currentUser.name = data.name || data.email.split('@')[0];
    console.log('[登入] 使用者:', currentUser.email);

    // 進行身分驗證
    await checkUserRole(currentUser.email);
  } catch (err) {
    console.error('[登入] 取得使用者資訊失敗:', err);
    showToast('取得帳號資訊失敗', 'error');
  }
}

/**
 * 登出：清除狀態並回到登入頁
 */
function handleLogout() {
  // 撤銷 token
  if (currentUser.accessToken) {
    google.accounts.oauth2.revoke(currentUser.accessToken, () => {
      console.log('[登出] Token 已撤銷');
    });
  }

  // 重置狀態
  currentUser = { email: '', name: '', role: '', accessToken: '' };
  menuData = [];
  todayRestaurants = [];
  todayOrders = [];
  activeRestaurant = '';
  activeCategory = '';

  // 切換畫面
  $loginSection().classList.remove('hidden');
  $mainSection().classList.add('hidden');
  $unauthorizedSection().classList.add('hidden');
}


// ─────────────────────────────────────────────
// 身分驗證：比對 Users 工作表
// ─────────────────────────────────────────────

/**
 * 登入後，從 Users 工作表中查找該 Email 並判斷角色
 * @param {string} email - 使用者的 Email
 */
async function checkUserRole(email) {
  try {
    const users = await fetchSheetData(`${SHEET_USERS}!A:C`);
    // users[0] 是標題列: [姓名, Email, 權限]
    // 從第 1 列開始搜尋
    const match = users.slice(1).find(row => row[1] && row[1].trim().toLowerCase() === email.toLowerCase());

    if (!match) {
      // Email 不在白名單中 → 顯示未授權
      console.warn('[身分驗證] 未找到授權:', email);
      $loginSection().classList.add('hidden');
      $unauthorizedSection().classList.remove('hidden');
      return;
    }

    // 設定角色
    currentUser.name = match[0] || currentUser.name;
    currentUser.role = match[2] || '一般成員';
    console.log(`[身分驗證] 角色: ${currentUser.role}`);

    // 切換到主介面
    $loginSection().classList.add('hidden');
    $unauthorizedSection().classList.add('hidden');
    $mainSection().classList.remove('hidden');

    // 顯示使用者名稱
    $userDisplayName().textContent = currentUser.name;

    // 若為管理員，顯示管理分頁
    if (currentUser.role === '管理員') {
      $tabAdminBtn().style.display = '';
    }

    // 載入菜單與今日設定
    await loadMenuAndConfig();
    showToast(`歡迎回來，${currentUser.name}！`, 'success');

  } catch (err) {
    console.error('[身分驗證] 讀取 Users 表失敗:', err);
    showToast('讀取使用者資料失敗，請檢查試算表權限', 'error');
  }
}


// ─────────────────────────────────────────────
// Google Sheets API 操作
// ─────────────────────────────────────────────

/**
 * 讀取試算表指定範圍的資料
 * @param {string} range - A1 表示法的範圍，例如 "Menu!A:D"
 * @returns {Promise<Array[]>} 二維陣列
 */
async function fetchSheetData(range) {
  const response = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
  });
  return response.result.values || [];
}

/**
 * 在工作表末端新增一列資料
 * @param {string} range - 寫入的工作表範圍，例如 "Orders!A:F"
 * @param {Array} rowData - 單列資料陣列
 */
async function appendRow(range, rowData) {
  await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: {
      values: [rowData],
    },
  });
}

/**
 * 清空工作表的指定範圍（保留標題列）
 * @param {string} range - 清空範圍，例如 "Orders!A2:F"
 */
async function clearSheet(range) {
  await gapi.client.sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
  });
}

/**
 * 覆寫 TodayConfig 工作表的內容
 * @param {string[]} restaurants - 要設定的餐廳名稱陣列
 */
async function updateTodayConfig(restaurants) {
  // 先清除舊資料（保留標題）
  await clearSheet(`${SHEET_TODAY_CONFIG}!A2:A`);

  if (restaurants.length === 0) return;

  // 寫入新的餐廳列表
  const values = restaurants.map(r => [r]);
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TODAY_CONFIG}!A2:A${restaurants.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
}


// ─────────────────────────────────────────────
// 載入菜單與今日餐廳設定
// ─────────────────────────────────────────────

/**
 * 從 Google Sheets 讀取 Menu 及 TodayConfig，
 * 並動態渲染篩選列與餐點卡片
 */
async function loadMenuAndConfig() {
  try {
    // 同時讀取 Menu 和 TodayConfig
    const [menuRaw, configRaw] = await Promise.all([
      fetchSheetData(`${SHEET_MENU}!A:D`),
      fetchSheetData(`${SHEET_TODAY_CONFIG}!A:A`),
    ]);

    // 解析 Menu（跳過標題列）
    // 欄位: [餐廳名稱, 品名, 單價, 分類]
    menuData = menuRaw.slice(1).map(row => ({
      restaurant: (row[0] || '').trim(),
      name: (row[1] || '').trim(),
      price: parseInt(row[2], 10) || 0,
      category: (row[3] || '').trim(),
    }));

    // 取得所有不重複的餐廳名稱（供管理員使用）
    allRestaurantNames = [...new Set(menuData.map(item => item.restaurant))];

    // 解析 TodayConfig（跳過標題列）
    todayRestaurants = configRaw.slice(1).map(row => (row[0] || '').trim()).filter(Boolean);

    console.log('[菜單] 已載入', menuData.length, '項餐點');
    console.log('[今日餐廳]', todayRestaurants);

    // 渲染 UI
    renderTodayBanner();
    renderRestaurantFilter();
    renderMenuCards();

    // 若為管理員，渲染管理頁的核取方塊
    if (currentUser.role === '管理員') {
      renderAdminCheckboxes();
    }

  } catch (err) {
    console.error('[載入菜單] 失敗:', err);
    showToast('載入菜單失敗，請重新整理', 'error');
    $menuList().innerHTML = `
      <div class="empty-state">
        <span class="material-icons-round">error_outline</span>
        <p>載入菜單時發生錯誤</p>
      </div>`;
  }
}


// ─────────────────────────────────────────────
// UI 渲染函式
// ─────────────────────────────────────────────

/**
 * 渲染今日餐廳橫幅
 */
function renderTodayBanner() {
  const el = $todayRestaurantsText();
  if (todayRestaurants.length === 0) {
    el.textContent = '今日尚未設定開放餐廳';
  } else {
    el.textContent = `今日開放：${todayRestaurants.join('、')}`;
  }
}

/**
 * 渲染餐廳篩選按鈕列
 */
function renderRestaurantFilter() {
  const container = $restaurantFilter();
  container.innerHTML = '';

  if (todayRestaurants.length === 0) return;

  // 「全部」按鈕
  const allBtn = document.createElement('button');
  allBtn.className = `filter-chip ${activeRestaurant === '' ? 'active' : ''}`;
  allBtn.textContent = '全部';
  allBtn.onclick = () => {
    activeRestaurant = '';
    activeCategory = '';
    renderRestaurantFilter();
    renderMenuCards();
  };
  container.appendChild(allBtn);

  // 各餐廳按鈕
  todayRestaurants.forEach(r => {
    const btn = document.createElement('button');
    btn.className = `filter-chip ${activeRestaurant === r ? 'active' : ''}`;
    btn.textContent = r;
    btn.onclick = () => {
      activeRestaurant = r;
      activeCategory = '';
      renderRestaurantFilter();
      renderCategoryFilter();
      renderMenuCards();
    };
    container.appendChild(btn);
  });

  // 渲染分類篩選
  renderCategoryFilter();
}

/**
 * 渲染分類篩選標籤列
 */
function renderCategoryFilter() {
  const container = $categoryFilter();
  container.innerHTML = '';

  // 取得目前篩選範圍內的分類
  let filtered = menuData.filter(item => todayRestaurants.includes(item.restaurant));
  if (activeRestaurant) {
    filtered = filtered.filter(item => item.restaurant === activeRestaurant);
  }

  const categories = [...new Set(filtered.map(item => item.category).filter(Boolean))];

  if (categories.length <= 1) return; // 只有一個分類就不需要篩選

  // 「全部分類」按鈕
  const allBtn = document.createElement('button');
  allBtn.className = `category-chip ${activeCategory === '' ? 'active' : ''}`;
  allBtn.textContent = '全部分類';
  allBtn.onclick = () => {
    activeCategory = '';
    renderCategoryFilter();
    renderMenuCards();
  };
  container.appendChild(allBtn);

  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `category-chip ${activeCategory === cat ? 'active' : ''}`;
    btn.textContent = cat;
    btn.onclick = () => {
      activeCategory = cat;
      renderCategoryFilter();
      renderMenuCards();
    };
    container.appendChild(btn);
  });
}

/**
 * 渲染餐點卡片
 */
function renderMenuCards() {
  const container = $menuList();
  container.innerHTML = '';

  // 篩選屬於今日餐廳的餐點
  let items = menuData.filter(item => todayRestaurants.includes(item.restaurant));

  // 進一步篩選餐廳
  if (activeRestaurant) {
    items = items.filter(item => item.restaurant === activeRestaurant);
  }

  // 進一步篩選分類
  if (activeCategory) {
    items = items.filter(item => item.category === activeCategory);
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-icons-round">no_meals</span>
        <p>${todayRestaurants.length === 0 ? '今日尚未設定開放餐廳，請聯繫管理員' : '目前篩選條件無符合的餐點'}</p>
      </div>`;
    return;
  }

  items.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'menu-card';
    card.style.animationDelay = `${index * 0.04}s`;

    const noteId = `note-${index}`;

    card.innerHTML = `
      <div class="menu-card-header">
        <span class="menu-card-name">${escapeHtml(item.name)}</span>
        <span class="menu-card-price">$${item.price}</span>
      </div>
      <div>
        <span class="menu-card-category">${escapeHtml(item.category)}</span>
        <span class="menu-card-restaurant">${escapeHtml(item.restaurant)}</span>
      </div>
      <div class="menu-card-body">
        <input type="text" id="${noteId}" placeholder="備註（如：不要香菜、微糖少冰）" />
        <button class="btn-order" onclick="submitOrder('${escapeHtml(item.restaurant)}', '${escapeHtml(item.name)}', ${item.price}, '${noteId}', this)">
          <span class="material-icons-round">add_shopping_cart</span> 點餐
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

/**
 * 渲染管理員頁面的餐廳核取方塊
 */
function renderAdminCheckboxes() {
  const container = $adminRestaurantCheckboxes();
  container.innerHTML = '';

  allRestaurantNames.forEach((name, index) => {
    const isChecked = todayRestaurants.includes(name);
    const id = `admin-cb-${index}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'checkbox-item';
    wrapper.onclick = (e) => {
      if (e.target.tagName !== 'INPUT') {
        const cb = wrapper.querySelector('input');
        cb.checked = !cb.checked;
      }
    };
    wrapper.innerHTML = `
      <input type="checkbox" id="${id}" value="${escapeHtml(name)}" ${isChecked ? 'checked' : ''} />
      <label for="${id}">${escapeHtml(name)}</label>
    `;
    container.appendChild(wrapper);
  });
}


// ─────────────────────────────────────────────
// 點餐提交
// ─────────────────────────────────────────────

/**
 * 送出訂單至 Orders 工作表
 * @param {string} restaurant - 餐廳名稱
 * @param {string} itemName - 品名
 * @param {number} price - 單價
 * @param {string} noteInputId - 備註輸入框的 DOM ID
 * @param {HTMLElement} btn - 觸發按鈕（用於顯示 loading 狀態）
 */
async function submitOrder(restaurant, itemName, price, noteInputId, btn) {
  const noteInput = document.getElementById(noteInputId);
  const note = noteInput ? noteInput.value.trim() : '';

  // 產生當下時間字串
  const now = new Date();
  const timeStr = formatDateTime(now);

  // 準備寫入資料
  const rowData = [timeStr, currentUser.email, restaurant, itemName, price, note];

  // 鎖定按鈕避免重複提交
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="material-icons-round spin">autorenew</span>';

  try {
    await appendRow(`${SHEET_ORDERS}!A:F`, rowData);
    showToast(`已成功點餐：${itemName}`, 'success');

    // 清空備註欄位
    if (noteInput) noteInput.value = '';

  } catch (err) {
    console.error('[點餐] 提交失敗:', err);
    showToast('點餐失敗，請再試一次', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}


// ─────────────────────────────────────────────
// 訂單確認（分頁 2）
// ─────────────────────────────────────────────

/**
 * 載入今日所有訂單並渲染在訂單確認區
 */
async function loadTodayOrders() {
  const listContainer = $orderSummaryList();
  const actionsContainer = $orderSummaryActions();

  listContainer.innerHTML = `
    <div class="loading-placeholder">
      <span class="material-icons-round spin">autorenew</span>
      <p>正在載入訂單...</p>
    </div>`;
  actionsContainer.classList.add('hidden');

  try {
    const ordersRaw = await fetchSheetData(`${SHEET_ORDERS}!A:F`);
    // 欄位: [點餐時間, 訂購人 Email, 餐廳名稱, 餐點內容, 金額, 備註]
    todayOrders = ordersRaw.slice(1).map(row => ({
      time: (row[0] || '').trim(),
      email: (row[1] || '').trim(),
      restaurant: (row[2] || '').trim(),
      item: (row[3] || '').trim(),
      price: parseInt(row[4], 10) || 0,
      note: (row[5] || '').trim(),
    }));

    renderOrderSummary();
  } catch (err) {
    console.error('[訂單] 載入失敗:', err);
    listContainer.innerHTML = `
      <div class="empty-state">
        <span class="material-icons-round">error_outline</span>
        <p>載入訂單時發生錯誤</p>
      </div>`;
  }
}

/**
 * 渲染訂單確認列表
 */
function renderOrderSummary() {
  const listContainer = $orderSummaryList();
  const actionsContainer = $orderSummaryActions();

  if (todayOrders.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <span class="material-icons-round">receipt_long</span>
        <p>今日尚無訂單紀錄</p>
      </div>`;
    actionsContainer.classList.add('hidden');
    return;
  }

  listContainer.innerHTML = '';

  // 依餐廳分組
  const grouped = {};
  todayOrders.forEach(order => {
    if (!grouped[order.restaurant]) grouped[order.restaurant] = [];
    grouped[order.restaurant].push(order);
  });

  let totalAmount = 0;

  Object.entries(grouped).forEach(([restaurant, orders]) => {
    // 餐廳標題
    const header = document.createElement('div');
    header.className = 'info-banner';
    header.innerHTML = `
      <span class="material-icons-round">storefront</span>
      <span>${escapeHtml(restaurant)}（共 ${orders.length} 份）</span>
    `;
    // 為了在 grid layout 下跨欄
    header.style.gridColumn = '1 / -1';
    listContainer.appendChild(header);

    orders.forEach(order => {
      totalAmount += order.price;

      const item = document.createElement('div');
      item.className = 'order-item';
      item.innerHTML = `
        <div class="order-item-info">
          <div class="order-item-name">${escapeHtml(order.item)}</div>
          <div class="order-item-detail">
            ${escapeHtml(order.email.split('@')[0])}
            ${order.note ? ` · ${escapeHtml(order.note)}` : ''}
          </div>
        </div>
        <div class="order-item-price">$${order.price}</div>
      `;
      listContainer.appendChild(item);
    });
  });

  // 合計列
  const totalBar = document.createElement('div');
  totalBar.className = 'order-total-bar';
  totalBar.style.gridColumn = '1 / -1';
  totalBar.innerHTML = `
    <span>合計（${todayOrders.length} 份）</span>
    <span>$${totalAmount}</span>
  `;
  listContainer.appendChild(totalBar);

  // 顯示操作按鈕
  actionsContainer.classList.remove('hidden');
}


/**
 * 一鍵複製訂單至剪貼簿（LINE 友善格式）
 */
function copyOrdersToClipboard() {
  if (todayOrders.length === 0) {
    showToast('目前沒有訂單可以複製', 'info');
    return;
  }

  const today = formatDate(new Date());
  let text = `📋 ${today} 點餐彙整\n${'─'.repeat(20)}\n\n`;

  // 依餐廳分組
  const grouped = {};
  todayOrders.forEach(order => {
    if (!grouped[order.restaurant]) grouped[order.restaurant] = [];
    grouped[order.restaurant].push(order);
  });

  let totalAmount = 0;

  Object.entries(grouped).forEach(([restaurant, orders]) => {
    text += `🏪 ${restaurant}\n`;
    orders.forEach(order => {
      totalAmount += order.price;
      const person = order.email.split('@')[0];
      const noteStr = order.note ? `（${order.note}）` : '';
      text += `  • ${order.item} $${order.price} - ${person}${noteStr}\n`;
    });
    text += '\n';
  });

  text += `${'─'.repeat(20)}\n`;
  text += `💰 合計：$${totalAmount}（共 ${todayOrders.length} 份）`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('訂單已複製到剪貼簿，可直接貼到 LINE！', 'success');
  }).catch(() => {
    // Fallback: 使用 textarea 複製
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('訂單已複製到剪貼簿！', 'success');
  });
}


// ─────────────────────────────────────────────
// 管理員功能
// ─────────────────────────────────────────────

/**
 * 儲存今日餐廳設定
 */
async function saveTodayConfig() {
  const checkboxes = $adminRestaurantCheckboxes().querySelectorAll('input[type="checkbox"]');
  const selected = [];
  checkboxes.forEach(cb => {
    if (cb.checked) selected.push(cb.value);
  });

  if (selected.length === 0) {
    showToast('請至少選擇一間餐廳', 'info');
    return;
  }

  try {
    await updateTodayConfig(selected);
    todayRestaurants = selected;

    // 重新渲染點餐頁面
    activeRestaurant = '';
    activeCategory = '';
    renderTodayBanner();
    renderRestaurantFilter();
    renderMenuCards();

    showToast(`已設定今日餐廳：${selected.join('、')}`, 'success');
  } catch (err) {
    console.error('[管理員] 儲存今日餐廳失敗:', err);
    showToast('儲存設定失敗，請再試一次', 'error');
  }
}

/**
 * 確認清空今日點餐（彈出 Modal）
 */
function confirmClearOrders() {
  showModal(
    '清空今日點餐',
    '確定要清空所有訂單資料嗎？此操作無法復原！',
    executeClearOrders
  );
}

/**
 * 執行清空 Orders（保留標題列）
 */
async function executeClearOrders() {
  closeModal();
  try {
    await clearSheet(`${SHEET_ORDERS}!A2:F`);
    todayOrders = [];
    showToast('已成功清空今日所有訂單', 'success');

    // 如果訂單分頁有顯示，重新渲染
    renderOrderSummary();
  } catch (err) {
    console.error('[管理員] 清空訂單失敗:', err);
    showToast('清空訂單失敗，請再試一次', 'error');
  }
}


// ─────────────────────────────────────────────
// 分頁切換
// ─────────────────────────────────────────────

/**
 * 切換分頁
 * @param {string} tabName - 分頁名稱 (order / summary / admin)
 */
function switchTab(tabName) {
  // 更新分頁按鈕狀態
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // 切換面板
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.remove('active');
  });
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // 若切換到訂單分頁，自動載入最新訂單
  if (tabName === 'summary') {
    loadTodayOrders();
  }
}


// ─────────────────────────────────────────────
// Toast 通知元件
// ─────────────────────────────────────────────

/**
 * 顯示快顯通知訊息
 * @param {string} message - 訊息內容
 * @param {'success'|'error'|'info'} type - 訊息類型
 */
function showToast(message, type = 'info') {
  const container = $toastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const iconMap = {
    success: 'check_circle',
    error: 'error',
    info: 'info',
  };

  toast.innerHTML = `
    <span class="material-icons-round">${iconMap[type] || 'info'}</span>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  // 3 秒後自動移除
  setTimeout(() => {
    toast.remove();
  }, 3000);
}


// ─────────────────────────────────────────────
// Modal 對話框
// ─────────────────────────────────────────────

/**
 * 顯示確認對話框
 * @param {string} title - 標題
 * @param {string} message - 訊息
 * @param {Function} onConfirm - 按下確認後的回呼
 */
function showModal(title, message, onConfirm) {
  $modalTitle().textContent = title;
  $modalMessage().textContent = message;
  $modalConfirmBtn().onclick = onConfirm;
  $modalOverlay().classList.remove('hidden');
}

/**
 * 關閉對話框
 */
function closeModal() {
  $modalOverlay().classList.add('hidden');
}


// ─────────────────────────────────────────────
// 工具函式
// ─────────────────────────────────────────────

/**
 * HTML 實體跳脫，避免 XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 格式化日期時間為 YYYY/MM/DD HH:mm
 * @param {Date} date
 * @returns {string}
 */
function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}`;
}

/**
 * 格式化日期為 YYYY/MM/DD
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}
