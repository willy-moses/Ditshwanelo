// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
const APP_VERSION = 'v5.1';
let cases = [];
let auditLog = [];
let editIdx = -1;
let currentPage = 'dashboard';
let sbClient = null;
let currentUser = null;
let currentUserName = '';
let currentUserRole = 'officer';
let coordSelectedVillage = null;
let allProfiles = [];
const SB_CREDS_KEY = 'legalaid_sb_creds_v3';

// ══════════════════════════════════════════════
// INDEXED DB — Cases offline cache
// ══════════════════════════════════════════════
const CASES_DB_NAME    = 'ditshwanelo_cases_db';
const CASES_DB_VERSION = 1;
let _casesDb = null;

function openCasesDB() {
  return new Promise((resolve, reject) => {
    if (_casesDb) { resolve(_casesDb); return; }
    const req = indexedDB.open(CASES_DB_NAME, CASES_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('cases'))
        db.createObjectStore('cases', { keyPath: '_id' });
      if (!db.objectStoreNames.contains('audit_log'))
        db.createObjectStore('audit_log', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta');
    };
    req.onsuccess = e => { _casesDb = e.target.result; resolve(_casesDb); };
    req.onerror   = () => reject(req.error);
  });
}

async function idbSaveCases(casesArr) {
  try {
    const db = await openCasesDB();
    const tx = db.transaction('cases', 'readwrite');
    const store = tx.objectStore('cases');
    store.clear();
    casesArr.forEach(c => {
      // Ensure every case has a key — use _id or generate a temp one
      const record = { ...c, _id: c._id || ('local_' + Date.now() + '_' + Math.random()) };
      store.put(record);
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch(e) { console.warn('idbSaveCases error:', e.message); }
}

async function idbLoadCases() {
  try {
    const db = await openCasesDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('cases', 'readonly');
      const req = tx.objectStore('cases').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  } catch(e) { console.warn('idbLoadCases error:', e.message); return []; }
}

async function idbSaveProfile(profile) {
  try {
    const db = await openCasesDB();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(profile, 'profile');
  } catch(e) {}
}

async function idbLoadProfile() {
  try {
    const db = await openCasesDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('profile');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    });
  } catch(e) { return null; }
}

// ── Keep localStorage as quick fallback for PIN ──
const PIN_KEY = 'legalaid_pin_v1';
function savePin(pin)  { localStorage.setItem(PIN_KEY, _enc(pin)); }
function loadPin()     { const s = localStorage.getItem(PIN_KEY); return s ? _dec(s) : null; }
function clearPin()    { localStorage.removeItem(PIN_KEY); }

// ══════════════════════════════════════════════
// OFFLINE & PIN SYSTEM
// ══════════════════════════════════════════════
let pinBuffer    = '';
let setPinBuffer = '';
let setPinStage  = 'first';
let setPinFirst  = '';
let isOffline    = false;

function isOnline() { return navigator.onLine; }

function setOfflineMode(offline) {
  isOffline = offline;
  const banner = document.getElementById('offline-banner');
  if (banner) banner.classList.toggle('show', offline);
}

// ══════════════════════════════════════════════
// CONNECTIVITY LISTENERS
// ══════════════════════════════════════════════
window.addEventListener('online', async () => {
  setOfflineMode(false);
  if (sbClient && currentUser) {
    await syncOnReconnect();
    await loadSettlementFilter();
  }
});

window.addEventListener('offline', () => {
  setOfflineMode(true);
  showToast('You are now offline — using cached data', '');
});

// ══════════════════════════════════════════════
// GUIDANCE NOTIFICATIONS
// ══════════════════════════════════════════════
function subscribeGuidanceNotifications() {
  if (!sbClient || !currentUser) return;

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  sbClient.channel('guidance-all-comments')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'case_comments'
    }, payload => {
      const c = payload.new;
      if (c.author_id === currentUser.id) return;
      markUnread(c.case_id);
      showToast('💬 New guidance message on case ' + (c.case_num || ''), 'success');

      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification('💬 New Guidance Message', {
            body: 'Case ' + (c.case_num || '') + ': ' + (c.author_name || 'Someone') + ' sent a message.',
            icon: '/icon-192.png', badge: '/icon-192.png',
            tag: 'guidance-' + c.case_id, renotify: true,
            data: { caseId: c.case_id }
          });
        }).catch(() => {});
      } else if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('💬 New Guidance Message', {
          body: 'Case ' + (c.case_num || '') + ': ' + (c.author_name || 'Someone') + ' sent a message.',
          icon: '/icon-192.png', tag: 'guidance-' + c.case_id, renotify: true,
        });
        n.onclick = () => { window.focus(); openGuidanceDirect(c.case_id); n.close(); };
      }
    })
    .subscribe();

  sbClient.channel('guidance-unread-sync')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'guidance_unread',
      filter: `user_id=eq.${currentUser.id}`
    }, async () => { await loadUnreadCounts(); })
    .subscribe();
}

// ══════════════════════════════════════════════
// SYNC ENGINE
// ══════════════════════════════════════════════
async function syncOnReconnect() {
  if (!sbClient || !currentUser) return;
  showToast('Back online — syncing changes...', '');
  setSbStatus('syncing', 'Syncing...');

  try {
    const { data: cloudRows, error } = await sbClient.from('cases').select('*');
    if (error) throw error;

    const cloudCases = cloudRows.map(rowToCase);
    const cloudById  = {};
    const cloudByNum = {};
    cloudCases.forEach(c => {
      if (c._id) cloudById[c._id]   = c;
      if (c.num) cloudByNum[c.num]  = c;
    });

    const toInsert = [];
    const toUpdate = [];

    cases.forEach(local => {
      const cloud = (local._id ? cloudById[local._id] : null) || (local.num ? cloudByNum[local.num] : null);
      if (!cloud) {
        toInsert.push(local);
      } else {
        const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
        const cloudTime = new Date(cloud.updatedAt  || cloud.createdAt  || 0).getTime();
        if (localTime > cloudTime) { local._id = cloud._id; toUpdate.push(local); }
      }
    });

    for (const c of toInsert) {
      const row = caseToRow(c);
      if (!row.created_by) { row.created_by = currentUser.id; row.created_by_name = currentUserName; }
      const { data, error: ie } = await sbClient.from('cases').insert(row).select().single();
      if (!ie && data) c._id = data.id;
    }
    for (const c of toUpdate) {
      await sbClient.from('cases').update(caseToRow(c)).eq('id', c._id);
    }

    const pushed = toInsert.length + toUpdate.length;
    await pullFromSupabase();

    if (pushed > 0) {
      showToast('Synced: ' + toInsert.length + ' new + ' + toUpdate.length + ' updated → Supabase ✓', 'success');
    } else {
      showToast('Back online — already up to date ✓', 'success');
    }
  } catch(e) {
    setSbStatus('error', 'Sync failed');
    showToast('Sync error: ' + e.message, 'error');
  }
}

// ── PIN UI ──
function updatePinDots(buf, prefix='') {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById((prefix || '') + 'dot-' + i);
    if (dot) dot.style.background = i < buf.length ? 'var(--navy)' : 'var(--border)';
  }
}

function pinPress(d)   { if (pinBuffer.length >= 4) return; pinBuffer += d; updatePinDots(pinBuffer); if (pinBuffer.length === 4) setTimeout(verifyPin, 200); }
function pinBackspace(){ pinBuffer = pinBuffer.slice(0,-1); updatePinDots(pinBuffer); }
function pinClear()    { pinBuffer = ''; updatePinDots(pinBuffer); }

async function verifyPin() {
  const stored = loadPin();
  if (!stored) { showPinError('No PIN set. Please sign in online first.'); pinBuffer = ''; updatePinDots(pinBuffer); return; }
  if (pinBuffer === stored) {
    const profile = await idbLoadProfile();
    const cached  = await idbLoadCases();
    if (!profile) { showPinError('No cached profile. Please sign in online first.'); pinBuffer = ''; return; }
    currentUserName = profile.name;
    currentUserRole = profile.role;
    currentUser     = { id: profile.id, email: profile.email };
    cases           = cached || [];
    setOfflineMode(true);
    hideAuthScreen();
    updateUserChip();
    document.getElementById('nav-coordinator').style.display = ['coordinator','admin'].includes(currentUserRole) ? 'flex' : 'none';
    document.getElementById('nav-admin').style.display       = currentUserRole === 'admin' ? 'flex' : 'none';
    updateStats(); renderRecent(); updateSbUI();
    showToast('Offline access granted — cached data loaded', 'success');
  } else {
    document.querySelectorAll('[id^="dot-"]').forEach(d => d.style.background = 'var(--danger)');
    setTimeout(() => { pinBuffer = ''; updatePinDots(pinBuffer); }, 700);
    const err = document.getElementById('pin-error');
    if (err) { err.textContent = 'Incorrect PIN. Try again.'; err.classList.add('show'); setTimeout(() => err.classList.remove('show'), 2000); }
  }
}

function showPinError(msg) {
  const err = document.getElementById('pin-error');
  if (err) { err.textContent = msg; err.classList.add('show'); }
}
function showOnlineLogin() {
  document.getElementById('auth-step-pin').style.display   = 'none';
  document.getElementById('auth-step-login').style.display = 'block';
}

// ── SET PIN UI ──
function setPinPress(d) {
  if (setPinBuffer.length >= 4) return;
  setPinBuffer += d;
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('sdot-' + i);
    if (dot) dot.style.background = i < setPinBuffer.length ? 'var(--navy)' : 'var(--border)';
  }
  if (setPinBuffer.length === 4) setTimeout(handleSetPin, 200);
}
function setPinBackspace() {
  setPinBuffer = setPinBuffer.slice(0,-1);
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('sdot-' + i);
    if (dot) dot.style.background = i < setPinBuffer.length ? 'var(--navy)' : 'var(--border)';
  }
}
function setPinClear() {
  setPinBuffer = '';
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('sdot-' + i);
    if (dot) dot.style.background = 'var(--border)';
  }
}

function handleSetPin() {
  if (setPinStage === 'first') {
    setPinFirst = setPinBuffer; setPinBuffer = ''; setPinStage = 'confirm';
    const titleEl = document.querySelector('#auth-step-setpin div:nth-child(1) div:nth-child(2)');
    if (titleEl) titleEl.textContent = 'Confirm your PIN';
    for (let i = 0; i < 4; i++) { const dot = document.getElementById('sdot-' + i); if (dot) dot.style.background = 'var(--border)'; }
  } else {
    if (setPinBuffer === setPinFirst) {
      savePin(setPinBuffer);
      showToast('PIN set successfully!', 'success');
      document.getElementById('auth-step-setpin').style.display = 'none';
      hideAuthScreen();
    } else {
      const err = document.getElementById('setpin-error');
      if (err) { err.textContent = 'PINs do not match. Try again.'; err.classList.add('show'); }
      setPinBuffer = ''; setPinFirst = ''; setPinStage = 'first';
      for (let i = 0; i < 4; i++) { const dot = document.getElementById('sdot-' + i); if (dot) dot.style.background = 'var(--border)'; }
    }
  }
}

function skipSetPin() { document.getElementById('auth-step-setpin').style.display = 'none'; hideAuthScreen(); }

function showChangePinModal() {
  setPinBuffer = ''; setPinFirst = ''; setPinStage = 'first';
  for (let i = 0; i < 4; i++) { const dot = document.getElementById('sdot-' + i); if (dot) dot.style.background = 'var(--border)'; }
  document.getElementById('auth-step-setpin').style.display = 'block';
  document.querySelectorAll('#auth-screen > .auth-box > div').forEach(d => {
    if (d.id !== 'auth-step-setpin') d.style.display = 'none';
  });
  showAuthScreen();
}

// ══════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════
async function saveAndContinue() {
  const url = document.getElementById('auth-sb-url').value.trim();
  const key = document.getElementById('auth-sb-key').value.trim();
  const err = document.getElementById('creds-error');
  err.classList.remove('show');
  if (!url || !key) { err.textContent = 'Both fields are required'; err.classList.add('show'); return; }
  if (!url.startsWith('https://')) { err.textContent = 'URL must start with https://'; err.classList.add('show'); return; }
  try {
    const { createClient } = supabase;
    sbClient = createClient(url, key);
    const { error } = await sbClient.from('cases').select('id').limit(1);
    if (error && error.code !== 'PGRST116') throw error;
    localStorage.setItem(SB_CREDS_KEY, JSON.stringify({ u: _enc(url), k: _enc(key) }));
    document.getElementById('sb-url').value = url;
    document.getElementById('sb-key').value = key;
    document.getElementById('auth-step-creds').style.display  = 'none';
    document.getElementById('auth-step-login').style.display  = 'block';
  } catch(e) {
    err.textContent = 'Could not connect: ' + (e.message || e) + '. Check your URL and key.';
    err.classList.add('show'); sbClient = null;
  }
}

function resetCreds() {
  localStorage.removeItem(SB_CREDS_KEY); sbClient = null;
  document.getElementById('auth-sb-url').value = '';
  document.getElementById('auth-sb-key').value = '';
  document.getElementById('auth-step-creds').style.display  = 'block';
  document.getElementById('auth-step-login').style.display  = 'none';
}

async function initAuth() {
  await new Promise(resolve => setTimeout(resolve, 300));
  const creds = loadSbCreds();

  if (!creds) {
    if (!isOnline() && loadPin()) { showPinScreen(); return; }
    document.getElementById('auth-step-creds').style.display = 'block';
    document.getElementById('auth-step-login').style.display = 'none';
    showAuthScreen(); return;
  }

  try {
    const { createClient } = supabase;
    sbClient = createClient(creds.url, creds.key);
    document.getElementById('sb-url').value = creds.url;
    document.getElementById('sb-key').value = creds.key;

    if (!isOnline()) {
      if (loadPin()) { showPinScreen(); }
      else {
        document.getElementById('auth-step-creds').style.display = 'none';
        document.getElementById('auth-step-login').style.display = 'block';
        const err = document.getElementById('login-error');
        if (err) { err.textContent = 'You are offline. Set a PIN after your first online login to access offline.'; err.classList.add('show'); }
        showAuthScreen();
      }
      return;
    }

    const { data: { session } } = await sbClient.auth.getSession();
    if (session) { await onAuthSuccess(session.user); }
    else {
      document.getElementById('auth-step-creds').style.display = 'none';
      document.getElementById('auth-step-login').style.display = 'block';
      showAuthScreen();
    }
  } catch(e) {
    if (loadPin()) { showPinScreen(); }
    else {
      document.getElementById('auth-step-creds').style.display = 'block';
      document.getElementById('auth-step-login').style.display = 'none';
      showAuthScreen();
    }
  }
}

function showPinScreen() {
  pinBuffer = ''; updatePinDots(pinBuffer);
  const profile  = null; // loaded async in verifyPin
  const pinTitle = document.getElementById('pin-title');
  // Try to show name from IndexedDB async
  idbLoadProfile().then(p => { if (p && pinTitle) pinTitle.textContent = 'Welcome back, ' + (p.name || ''); });
  document.getElementById('auth-step-creds').style.display  = 'none';
  document.getElementById('auth-step-login').style.display  = 'none';
  document.getElementById('auth-step-pin').style.display    = 'block';
  document.getElementById('auth-step-setpin').style.display = 'none';
  showAuthScreen();
}

function showAuthScreen() { document.getElementById('auth-screen').classList.remove('hidden'); document.querySelector('.layout').style.display = 'none'; }
function hideAuthScreen() { document.getElementById('auth-screen').classList.add('hidden'); document.querySelector('.layout').style.display = 'flex'; }

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-password').value;
  const err   = document.getElementById('login-error');
  err.classList.remove('show');
  if (!email || !pw) { err.textContent = 'Enter email and password'; err.classList.add('show'); return; }
  try {
    const { data, error } = await sbClient.auth.signInWithPassword({ email, password: pw });
    if (error) throw error;
    await onAuthSuccess(data.user);
  } catch(e) { err.textContent = e.message; err.classList.add('show'); }
}

async function onAuthSuccess(user) {
  currentUser     = user;
  currentUserName = user.user_metadata?.full_name || user.email;

  try {
    const { data: profile } = await sbClient.from('user_profiles').select('role,full_name').eq('id', user.id).single();
    if (profile) {
      currentUserRole = profile.role || 'officer';
      if (profile.full_name) currentUserName = profile.full_name;
    } else {
      await sbClient.from('user_profiles').upsert(
        { id: user.id, full_name: user.user_metadata?.full_name || '', email: user.email, role: 'officer' },
        { onConflict: 'id' }
      );
      currentUserRole = 'officer';
    }
  } catch(e) { currentUserRole = 'officer'; }

  // Save profile to IndexedDB for offline access
  await idbSaveProfile({ id: user.id, email: user.email, name: currentUserName, role: currentUserRole });

  // Request persistent storage
  if (navigator.storage && navigator.storage.persist) { await navigator.storage.persist(); }

  hideAuthScreen();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  updateUserChip();
  document.getElementById('nav-coordinator').style.display = ['coordinator','admin'].includes(currentUserRole) ? 'flex' : 'none';
  document.getElementById('nav-admin').style.display       = currentUserRole === 'admin' ? 'flex' : 'none';
  setSbStatus('connected', 'Connected');
  setOfflineMode(false);
  updateSbUI();
  await loadAllProfiles();
  await pullFromSupabase();
  await loadUnreadCounts();
  subscribeGuidanceNotifications();
  await loadAuditLog();
  updateDbUI();

  if (!loadPin()) {
    setTimeout(() => {
      setPinBuffer = ''; setPinFirst = ''; setPinStage = 'first';
      for (let i = 0; i < 4; i++) { const dot = document.getElementById('sdot-' + i); if (dot) dot.style.background = 'var(--border)'; }
      document.getElementById('auth-step-setpin').style.display = 'block';
      document.getElementById('auth-step-creds').style.display  = 'none';
      document.getElementById('auth-step-login').style.display  = 'none';
      document.getElementById('auth-step-pin').style.display    = 'none';
      showAuthScreen();
    }, 800);
  }
}

async function doLogout() {
  if (sbClient) await sbClient.auth.signOut();
  currentUser = null; currentUserName = ''; currentUserRole = 'officer';
  cases = []; auditLog = [];
  setOfflineMode(false);
  document.getElementById('auth-step-creds').style.display  = 'none';
  document.getElementById('auth-step-login').style.display  = 'block';
  document.getElementById('auth-step-pin').style.display    = 'none';
  document.getElementById('auth-step-setpin').style.display = 'none';
  document.getElementById('login-email').value    = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.remove('show');
  showAuthScreen();
  setSbStatus('off', 'Offline');
  updateSbUI();
}

function updateUserChip() {
  const initials = currentUserName.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase();
  document.getElementById('user-avatar').textContent = initials || '?';
  document.getElementById('user-name').textContent   = currentUserName;
  document.getElementById('user-role').textContent   =
    currentUserRole === 'coordinator' ? 'Coordinator' :
    currentUserRole === 'admin'       ? 'Admin'        : 'Case Officer';
}

function togglePw(id, btn) {
  const inp = document.getElementById(id);
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

// ══════════════════════════════════════════════
// PAGE NAV
// ══════════════════════════════════════════════
function showPage(page) {
  if (page === 'admin'       && currentUserRole !== 'admin')                        { showToast('Admin access only','error'); return; }
  if (page === 'coordinator' && !['coordinator','admin'].includes(currentUserRole)) { showToast('Coordinator/Admin access only','error'); return; }
  document.querySelectorAll('.page').forEach(p     => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const titles = { dashboard:'Dashboard', cases:'All Cases', coordinator:'Coordinator Panel', audit:'Audit Log', database:'Database Settings', admin:'Admin Panel', ai:'AI Insights', receipts:'Receipt Vault' };
  document.getElementById('page-title').textContent = titles[page] || page;
  currentPage = page;
  const navMap   = { dashboard:0, cases:1, coordinator:2, admin:3, audit:4, database:5 };
  const navItems = document.querySelectorAll('.nav-item');
  if (navMap[page] !== undefined) navItems[navMap[page]]?.classList.add('active');
  if (page === 'cases')       renderTable();
  if (page === 'dashboard')   { renderRecent(); updateStats(); }
  if (page === 'coordinator') renderCoordinator();
  if (page === 'audit')       renderAuditLog();
  if (page === 'admin')       loadAdminUsers();
  if (page === 'ai')          initAiPage();
  if (page === 'receipts')    rvInit();
}

// ══════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════
function updateStats() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-total',   cases.length);
  set('stat-open',    cases.filter(c => c.status === 'Ongoing').length);
  set('stat-pending', cases.filter(c => c.status === 'Pending').length);
  set('stat-closed',  cases.filter(c => c.status === 'Closed').length);
  updateVillageFilter();
}

function updateVillageFilter() {
  const villages = [...new Set(cases.map(c => c.village).filter(Boolean))].sort();
  ['filter-village','coord-filter-village'].forEach(id => {
    const sel = document.getElementById(id); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All villages</option>';
    villages.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
    sel.value = cur;
  });
}

// ══════════════════════════════════════════════
// RENDER RECENT
// ══════════════════════════════════════════════
function renderRecent() {
  const recent = [...cases].slice(-8).reverse();
  const tbody  = document.getElementById('recent-tbody');
  const empty  = document.getElementById('recent-empty');
  tbody.innerHTML = '';
  empty.style.display = cases.length === 0 ? 'block' : 'none';
  recent.forEach(c => {
    const idx = cases.indexOf(c);
    tbody.insertAdjacentHTML('beforeend', `<tr>
      <td><span class="case-num">${esc(c.num)}</span></td>
      <td class="name-cell">${esc(c.name)}</td>
      <td>${esc(c.village) || '—'}</td>
      <td>${esc(c.type)}</td>
      <td><span class="badge badge-${c.status.toLowerCase()}">${c.status}</span></td>
      <td><div style="display:flex;gap:5px">
        <button class="btn btn-outline btn-sm" onclick="viewCase(${idx})">View</button>
        <button class="btn btn-outline btn-sm" onclick="editCase(${idx})">Edit</button>
      </div></td></tr>`);
  });
}

// ══════════════════════════════════════════════
// RENDER TABLE
// ══════════════════════════════════════════════
function renderTable() {
  const q    = document.getElementById('search').value.toLowerCase();
  const ft   = document.getElementById('filter-type').value;
  const fs   = document.getElementById('filter-status').value;
  const fv   = document.getElementById('filter-village').value;
  const fset = document.getElementById('filter-settlement').value;

  const filtered = cases.map((c,i) => ({ c, i })).filter(({ c }) => {
    const matchQ   = !q || [c.num,c.name,c.idNumber,c.tribe,c.village,c.address,c.type,c.desc,c.contacts].join(' ').toLowerCase().includes(q);
    const settlementUserIds = allProfiles.filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase()).map(p => p.id);
    const matchSet = !fset || settlementUserIds.includes(c.createdBy);
    return matchQ && (!ft || c.type === ft) && (!fs || c.status === fs) && (!fv || c.village === fv) && matchSet;
  });

  document.getElementById('record-count').textContent = `${filtered.length} record${filtered.length !== 1 ? 's' : ''}`;
  const tbody = document.getElementById('case-tbody');
  const empty = document.getElementById('case-empty');
  tbody.innerHTML = '';
  empty.style.display = filtered.length === 0 ? 'block' : 'none';
  filtered.forEach(({ c, i }) => {
    tbody.insertAdjacentHTML('beforeend', `<tr>
      <td><span class="case-num">${esc(c.num)}</span></td>
      <td class="name-cell">${esc(c.name)}</td>
      <td>${esc(c.idNumber) || '—'}</td>
      <td>${c.dob || '—'}</td>
      <td>${esc(c.tribe)   || '—'}</td>
      <td>${esc(c.village) || '—'}</td>
      <td>${esc(c.type)}</td>
      <td><span class="badge badge-${c.status.toLowerCase()}">${c.status}</span></td>
      <td><span style="font-size:11.5px;color:var(--text-muted)">${esc(c.updatedByName || c.createdByName || '—')}</span></td>
      <td><div style="display:flex;gap:4px">
        <button class="btn btn-outline btn-sm" onclick="viewCase(${i})">👁</button>
        <button class="btn btn-outline btn-sm" onclick="editCase(${i})">✎</button>
        <button class="btn btn-outline btn-sm" onclick="openGuidanceDirect('${c._id}')" title="Guidance" style="position:relative">
          💬${getUnreadCount(c._id) > 0 ? ` <span style="position:absolute;top:-5px;right:-5px;background:#d9534f;color:#fff;border-radius:50%;font-size:9px;min-width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-weight:700;padding:0 3px">${getUnreadCount(c._id)}</span>` : ''}${c.needsGuidance ? ' 🆘' : ''}
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteCase(${i})">✕</button>
      </div></td></tr>`);
  });
}

// ══════════════════════════════════════════════
// COORDINATOR PANEL
// ══════════════════════════════════════════════
function renderCoordinator() {
  const q    = document.getElementById('coord-search').value.toLowerCase();
  const fs   = document.getElementById('coord-filter-status').value;
  const fset = document.getElementById('coord-filter-settlement').value;

  const filtered = cases.filter(c => {
    const matchStatus = !fs || c.status === fs;
    const settlementUserIds = allProfiles.filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase()).map(p => p.id);
    const matchSet = !fset || settlementUserIds.includes(c.createdBy);
    return matchStatus && matchSet;
  });

  document.getElementById('coord-total').textContent  = filtered.length;
  document.getElementById('coord-open').textContent   = filtered.filter(c => c.status === 'Ongoing').length;
  document.getElementById('coord-closed').textContent = filtered.filter(c => c.status === 'Closed').length;

  const villageMap = {};
  filtered.forEach(c => {
    const v = c.village || '(No Village)';
    if (!villageMap[v]) villageMap[v] = { name: v, cases: [] };
    villageMap[v].cases.push(c);
  });

  const villages = Object.values(villageMap)
    .filter(v => !q || v.name.toLowerCase().includes(q))
    .sort((a,b) => b.cases.length - a.cases.length);
  document.getElementById('coord-villages').textContent = villages.length;

  const grid = document.getElementById('village-grid');
  grid.innerHTML = '';
  if (villages.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🗺️</div><p>No villages found.</p></div>';
  }
  villages.forEach(v => {
    const open    = v.cases.filter(c => c.status === 'Ongoing').length;
    const pending = v.cases.filter(c => c.status === 'Pending').length;
    const closed  = v.cases.filter(c => c.status === 'Closed').length;
    const card    = document.createElement('div');
    card.className = 'village-card' + (coordSelectedVillage === v.name ? ' selected' : '');
    card.innerHTML = `<div class="vc-name">📍 ${esc(v.name)}</div>
      <div class="vc-total" style="margin-bottom:6px">${v.cases.length} case${v.cases.length !== 1 ? 's' : ''}</div>
      <div class="vc-stats">
        ${open    ? `<span class="vc-stat ongoing">${open} Ongoing</span>`    : ''}
        ${pending ? `<span class="vc-stat pending">${pending} Pending</span>` : ''}
        ${closed  ? `<span class="vc-stat closed">${closed} Closed</span>`   : ''}
      </div>`;
    card.onclick = () => { coordSelectedVillage = v.name; renderCoordinator(); renderCoordTable(v.name, filtered); };
    grid.appendChild(card);
  });

  if (coordSelectedVillage) { renderCoordTable(coordSelectedVillage, filtered); }
  else { document.getElementById('coord-table-card').style.display = 'none'; }
}

function renderCoordTable(village, filteredCases) {
  const vCases = filteredCases.filter(c => (c.village || '(No Village)') === village);
  document.getElementById('coord-table-card').style.display = 'block';
  document.getElementById('coord-table-title').textContent  = 'Cases — ' + village;
  document.getElementById('coord-record-count').textContent = vCases.length + ' cases';
  const tbody = document.getElementById('coord-tbody');
  tbody.innerHTML = '';
  vCases.forEach(c => {
    const idx = cases.indexOf(c);
    tbody.insertAdjacentHTML('beforeend', `<tr>
      <td><span class="case-num">${esc(c.num)}</span></td>
      <td class="name-cell">${esc(c.name)}</td>
      <td>${esc(c.idNumber) || '—'}</td>
      <td>${esc(c.tribe)   || '—'}</td>
      <td>${esc(c.address) || '—'}</td>
      <td>${esc(c.type)}</td>
      <td><span class="badge badge-${c.status.toLowerCase()}">${c.status}</span></td>
      <td style="font-size:11.5px;color:var(--text-muted)">${esc(c.createdByName || '—')}</td>
      <td><div style="display:flex;gap:4px">
        <button class="btn btn-outline btn-sm" onclick="viewCase(${idx})">👁</button>
        <button class="btn btn-outline btn-sm" onclick="editCase(${idx})">✎</button>
        <button class="btn btn-outline btn-sm" onclick="openGuidanceDirect('${c._id}')" title="Guidance" style="position:relative">
          💬${getUnreadCount(c._id) > 0 ? ` <span style="position:absolute;top:-5px;right:-5px;background:#d9534f;color:#fff;border-radius:50%;font-size:9px;min-width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-weight:700;padding:0 3px">${getUnreadCount(c._id)}</span>` : ''}${c.needsGuidance ? ' 🆘' : ''}
        </button>
      </div></td></tr>`);
  });
}

// ══════════════════════════════════════════════
// AUDIT LOG
// ══════════════════════════════════════════════
function renderAuditLog() {
  const list = document.getElementById('audit-list');
  document.getElementById('audit-count').textContent = auditLog.length + ' entries';
  if (auditLog.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No audit records yet.</p></div>';
    return;
  }
  const icons = { ADD:'➕', EDIT:'✎', DELETE:'✕' };
  const cls   = { ADD:'audit-add', EDIT:'audit-edit', DELETE:'audit-delete' };
  list.innerHTML = auditLog.slice().reverse().map(a => `
    <div class="audit-row">
      <div class="audit-action ${cls[a.action] || 'audit-edit'}">${icons[a.action] || '•'}</div>
      <div class="audit-info">
        <div class="audit-main">${a.action} — Case <strong>${esc(a.case_num || '?')}</strong></div>
        <div class="audit-meta">By <strong>${esc(a.performed_by_name || 'Unknown')}</strong> · ${new Date(a.performed_at).toLocaleString()}</div>
      </div>
    </div>`).join('');
}

async function logAudit(action, c) {
  const entry = {
    case_id: c._id || null, case_num: c.num, action,
    performed_by:      currentUser?.id || null,
    performed_by_name: currentUserName,
    performed_at:      new Date().toISOString(),
    details:           { name: c.name, status: c.status }
  };
  auditLog.push(entry);
  if (sbClient) { try { await sbClient.from('audit_log').insert(entry); } catch(e) {} }
}

async function loadAuditLog() {
  if (!sbClient) return;
  try {
    const { data, error } = await sbClient.from('audit_log').select('*').order('performed_at', { ascending: false }).limit(200);
    if (!error && data) auditLog = data;
  } catch(e) {}
}

// ══════════════════════════════════════════════
// CASE MODAL
// ══════════════════════════════════════════════
function openAddModal() {
  editIdx = -1;
  document.getElementById('modal-title').textContent = 'Add New Case';
  document.getElementById('modal-sub').textContent   = 'Fill in the details below';
  ['f-num','f-name','f-idnum','f-tribe','f-village','f-address','f-contacts','f-desc','f-assist','f-type-custom'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-dob').value           = '';
  document.getElementById('f-case-date').value     = '';
  document.getElementById('f-employ-status').value = '';
  document.getElementById('f-num').value           = autoNum();
  document.getElementById('f-type').value          = 'Labour Dispute';
  document.getElementById('f-type-custom-wrap').style.display = 'none';
  document.getElementById('f-status').value        = 'Ongoing';
  document.getElementById('case-modal').classList.add('open');
}

function toggleCustomCaseType() {
  const sel  = document.getElementById('f-type');
  const wrap = document.getElementById('f-type-custom-wrap');
  wrap.style.display = sel.value === '__custom__' ? 'block' : 'none';
}

function autoNum() {
  const nums = cases.map(c => { const m = c.num.match(/(\d+)$/); return m ? parseInt(m[1]) : 0; });
  return 'G-' + (Math.max(0, ...nums) + 1).toString().padStart(3,'0');
}

function editCase(idx) {
  editIdx = idx; const c = cases[idx];
  document.getElementById('modal-title').textContent = 'Edit Case';
  document.getElementById('modal-sub').textContent   = c.num + ' — ' + c.name;
  document.getElementById('f-num').value             = c.num;
  document.getElementById('f-name').value            = c.name;
  document.getElementById('f-case-date').value       = c.caseDate     || '';
  document.getElementById('f-employ-status').value   = c.employStatus || '';
  document.getElementById('f-idnum').value           = c.idNumber     || '';
  document.getElementById('f-dob').value             = c.dob          || '';
  document.getElementById('f-tribe').value           = c.tribe        || '';
  document.getElementById('f-village').value         = c.village      || '';
  document.getElementById('f-address').value         = c.address      || '';
  document.getElementById('f-contacts').value        = c.contacts     || '';

  const knownTypes = ['Labour Dispute','Land Dispute','Family Matter','Criminal','Child Maintanance','Dept Disputes','Unfair Work Treatment','Civil','Inheritence Despute'];
  if (c.type && !knownTypes.includes(c.type)) {
    document.getElementById('f-type').value = '__custom__';
    document.getElementById('f-type-custom').value = c.type;
    document.getElementById('f-type-custom-wrap').style.display = 'block';
  } else {
    document.getElementById('f-type').value = c.type || 'Labour Dispute';
    document.getElementById('f-type-custom').value = '';
    document.getElementById('f-type-custom-wrap').style.display = 'none';
  }

  document.getElementById('f-desc').value   = c.desc   || '';
  document.getElementById('f-assist').value = c.assist || '';
  document.getElementById('f-status').value = c.status || 'Ongoing';
  document.getElementById('case-modal').classList.add('open');
  document.getElementById('view-modal').classList.remove('open');
}

function closeModal() { document.getElementById('case-modal').classList.remove('open'); }

async function saveCase() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { showToast('Please enter the full names.','error'); return; }

  let type = document.getElementById('f-type').value;
  if (type === '__custom__') {
    type = document.getElementById('f-type-custom').value.trim();
    if (!type) { showToast('Please specify the custom case type.','error'); return; }
  }

  const now   = new Date().toISOString();
  const entry = {
    num:          document.getElementById('f-num').value.trim() || autoNum(),
    name,
    idNumber:     document.getElementById('f-idnum').value.trim(),
    dob:          document.getElementById('f-dob').value || null,
    caseDate:     document.getElementById('f-case-date').value || null,
    employStatus: document.getElementById('f-employ-status').value.trim(),
    tribe:        document.getElementById('f-tribe').value.trim(),
    village:      document.getElementById('f-village').value.trim(),
    address:      document.getElementById('f-address').value.trim(),
    contacts:     document.getElementById('f-contacts').value.trim(),
    type, desc:   document.getElementById('f-desc').value.trim(),
    assist:       document.getElementById('f-assist').value.trim(),
    status:       document.getElementById('f-status').value,
    updatedAt:      now,
    updatedBy:      currentUser?.id || null,
    updatedByName:  currentUserName,
  };

  if (editIdx >= 0) {
    entry._id           = cases[editIdx]._id;
    entry.createdAt     = cases[editIdx].createdAt;
    entry.createdBy     = cases[editIdx].createdBy;
    entry.createdByName = cases[editIdx].createdByName;
    cases[editIdx]      = entry;
    showToast('Case updated','success');
    await logAudit('EDIT', entry);
    if (!isOffline) await syncCaseToSupabase(entry, 'update');
  } else {
    entry.createdAt     = now;
    entry.createdBy     = currentUser?.id || null;
    entry.createdByName = currentUserName;
    cases.push(entry);
    showToast('Case added','success');
    await logAudit('ADD', entry);
    if (!isOffline) await syncCaseToSupabase(cases[cases.length - 1], 'insert');
  }

  closeModal();
  await idbSaveCases(cases); // save to IndexedDB
  updateAll();
}

function deleteCase(idx) {
  if (!confirm('Delete case ' + cases[idx].num + ' — ' + cases[idx].name + '?')) return;
  const deleted = cases.splice(idx, 1)[0];
  logAudit('DELETE', deleted);
  if (!isOffline) deleteCaseFromSupabase(deleted);
  idbSaveCases(cases);
  updateAll();
  showToast('Case deleted','error');
}

// ══════════════════════════════════════════════
// VIEW MODAL
// ══════════════════════════════════════════════
function viewCase(idx) {
  const c = cases[idx];
  window.currentViewCaseId = c._id || null;
  document.getElementById('view-case-num').textContent  = c.num;
  document.getElementById('view-case-name').textContent = c.name;
  document.getElementById('view-edit-btn').onclick = () => editCase(idx);

  const fields = [
    { l:'Case Number',          v: c.num },
    { l:'Full Names',           v: c.name },
    { l:'ID Number',            v: c.idNumber },
    { l:'Date of Birth',        v: c.dob },
    { l:'Tribe',                v: c.tribe },
    { l:'Date of Case',         v: c.caseDate },
    { l:'Employment Status',    v: c.employStatus },
    { l:'Contacts',             v: c.contacts },
    { l:'Village / Settlement', v: c.village },
    { l:'Home Address / Ward',  v: c.address,  full: true },
    { l:'Case Type',            v: c.type },
    { l:'Status',               v: c.status },
    { l:'Brief Description',    v: c.desc,     full: true },
    { l:'Assistance Given',     v: c.assist,   full: true },
  ];
  document.getElementById('view-detail-grid').innerHTML = fields.map(f => `
    <div class="detail-field ${f.full ? 'full' : ''}">
      <div class="dl">${f.l}</div>
      <div class="dv ${!f.v ? 'empty' : ''}">${f.v ? esc(f.v) : 'Not recorded'}</div>
    </div>`).join('');

  const caseAudit = auditLog.filter(a => a.case_num === c.num).slice(0,5);
  const icons     = { ADD:'➕', EDIT:'✎', DELETE:'✕' };
  document.getElementById('view-audit-trail').innerHTML = caseAudit.length === 0
    ? '<span style="font-size:12px;color:var(--text-light)">No audit records</span>'
    : caseAudit.map(a => `<div class="audit-chip">${icons[a.action] || '•'} ${a.action} by ${esc(a.performed_by_name || '?')} · ${new Date(a.performed_at).toLocaleString()}</div><br>`).join('');

  document.getElementById('view-modal').classList.add('open');
}

function closeViewModal() { document.getElementById('view-modal').classList.remove('open'); }

function updateAll() {
  updateStats(); renderRecent();
  if (currentPage === 'cases')       renderTable();
  if (currentPage === 'coordinator') renderCoordinator();
  if (currentPage === 'dashboard')   { renderRecent(); updateStats(); }
  updateTopbarMsgBadge();
}

// ══════════════════════════════════════════════
// SUPABASE
// ══════════════════════════════════════════════
const _ck = 'legalaid_v3_secure';
function _xor(str, key) { return str.split('').map((c,i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join(''); }
function _enc(str) { return btoa(_xor(str, _ck)); }
function _dec(str) { try { return _xor(atob(str), _ck); } catch(e) { return ''; } }

function saveSbCreds() {
  const url = document.getElementById('sb-url').value.trim();
  const key = document.getElementById('sb-key').value.trim();
  if (url && key) localStorage.setItem(SB_CREDS_KEY, JSON.stringify({ u: _enc(url), k: _enc(key) }));
}

function loadSbCreds() {
  try {
    const r = localStorage.getItem(SB_CREDS_KEY);
    if (!r) return null;
    const obj = JSON.parse(r);
    if (obj.u && obj.k) return { url: _dec(obj.u), key: _dec(obj.k) };
    if (obj.url && obj.key) return obj;
  } catch(e) {}
  return null;
}

function setSbStatus(state, msg) {
  ['sb-dot','topbar-sb-dot','sidebar-sb-dot'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.className = 'sb-dot';
    if (state === 'connected' || state === 'syncing') el.classList.add('connected');
    else if (state === 'connecting') el.classList.add('connecting');
    else if (state === 'error')      el.classList.add('error');
  });
  ['sb-label','topbar-sb-label'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = msg; });
  const spinning = state === 'syncing' || state === 'connecting';
  ['sb-spinner','topbar-spinner'].forEach(id => { const el = document.getElementById(id); if (el) el.className = 'sync-spinner' + (spinning ? ' active' : ''); });
}

function updateSbUI() {
  const connected = !!sbClient && !!currentUser;
  const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  const show = (id, d='inline-flex') => { const el = document.getElementById(id); if (el) el.style.display = d; };
  if (connected) { hide('sb-connect-btn'); show('sb-disconnect-btn'); show('sb-pull-btn'); show('sb-push-btn'); show('sb-clear-btn'); show('sb-last-sync','block'); }
  else           { show('sb-connect-btn'); hide('sb-disconnect-btn'); hide('sb-pull-btn'); hide('sb-push-btn'); hide('sb-clear-btn'); hide('sb-last-sync'); }
  const isAdmin    = currentUserRole === 'admin';
  const isElevated = ['coordinator','admin'].includes(currentUserRole);
  const clearLocal  = document.getElementById('clear-local-btn');
  const clearLocked = document.getElementById('danger-zone-locked');
  if (clearLocal)  clearLocal.style.display  = isAdmin ? 'inline-flex' : 'none';
  if (clearLocked) clearLocked.style.display = isAdmin ? 'none' : 'block';
  ['filter-settlement','coord-filter-settlement','admin-filter-settlement'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isElevated ? '' : 'none';
  });
}

function updateDbUI() {
  const connected = !!sbClient && !!currentUser;
  const banner = document.getElementById('connect-banner');
  if (banner) banner.style.display = connected ? 'none' : 'flex';
  const statusBar = document.getElementById('db-status');
  if (statusBar) statusBar.style.display = connected ? 'none' : 'block';
}

async function connectSupabase() {
  const url = document.getElementById('sb-url').value.trim();
  const key = document.getElementById('sb-key').value.trim();
  if (!url || !key) { showToast('Enter URL and key first','error'); return; }
  setSbStatus('connecting','Connecting...');
  try {
    const { createClient } = supabase;
    sbClient = createClient(url, key);
    const { error } = await sbClient.from('cases').select('id').limit(1);
    if (error) throw error;
    saveSbCreds();
    setSbStatus('connected','Connected');
    updateSbUI();
    showToast('Supabase connected!','success');
    await pullFromSupabase();
    await loadAuditLog();
  } catch(e) {
    sbClient = null; setSbStatus('error','Failed'); showToast('Supabase error: ' + e.message,'error');
  }
}

function disconnectSupabase() { sbClient = null; setSbStatus('off','Offline'); updateSbUI(); showToast('Disconnected',''); }

function caseToRow(c) {
  const rawDob  = c.dob || '';
  const safeDob = /^\d{4}-\d{2}-\d{2}$/.test(rawDob) ? rawDob : null;
  return {
    num: c.num || '', name: c.name || '',
    id_number: c.idNumber || '', date_of_birth: safeDob,
    tribe: c.tribe || '', village: c.village || '', address: c.address || '',
    type: c.type || '', description: c.desc || '', assistance: c.assist || '',
    case_date: c.caseDate || null, employment_status: c.employStatus || '',
    status: ['Ongoing','Pending','Closed'].includes(c.status) ? c.status : 'Ongoing',
    contacts: c.contacts || '',
    updated_at: new Date().toISOString(),
    created_by: c.createdBy || null, created_by_name: c.createdByName || '',
    updated_by: c.updatedBy || null, updated_by_name: c.updatedByName || ''
  };
}

function rowToCase(r) {
  return {
    _id: r.id, num: r.num, name: r.name,
    idNumber: r.id_number || '', dob: r.date_of_birth || '',
    tribe: r.tribe || '', village: r.village || '', address: r.address || '',
    type: r.type || '', desc: r.description || '', assist: r.assistance || '',
    caseDate: r.case_date || '', employStatus: r.employment_status || '',
    status: r.status || 'Ongoing', contacts: r.contacts || '',
    createdAt: r.created_at, createdBy: r.created_by, createdByName: r.created_by_name || '',
    updatedAt: r.updated_at, updatedBy: r.updated_by, updatedByName: r.updated_by_name || '',
    needsGuidance: r.needs_guidance || false
  };
}

async function openGuidanceDirect(caseId) {
  if (!caseId) { showToast('This case has not synced yet — save it online first.', 'error'); return; }
  await markRead(caseId);
  updateAll();
  window.open('case-guidance.html?case=' + caseId, '_blank');
}

async function pullFromSupabase() {
  if (!sbClient || !currentUser) return;
  setSbStatus('syncing','Pulling...');
  try {
    const { data, error } = await sbClient.from('cases').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    cases = data.map(rowToCase);

    // Mirror to IndexedDB for offline access
    await idbSaveCases(cases);

    updateAll();
    await loadAllProfiles();
    await loadSettlementFilter();

    const now        = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const scopeLabel = ['coordinator','admin'].includes(currentUserRole) ? 'all cases' : 'your cases';
    setSbStatus('connected','Connected');
    const ls = document.getElementById('sb-last-sync');
    if (ls) { ls.textContent = '⬇ Pulled ' + now + ' — ' + cases.length + ' ' + scopeLabel; ls.style.display = 'block'; }
    showToast(cases.length + ' ' + scopeLabel + ' loaded','success');
  } catch(e) {
    setSbStatus('error','Pull failed');
    showToast('Pull error: ' + e.message,'error');
  }
}

async function pushAllToSupabase() {
  if (!sbClient) return;
  setSbStatus('syncing','Pushing...');
  try {
    const { error: de } = await sbClient.from('cases').delete().neq('id','00000000-0000-0000-0000-000000000000');
    if (de) throw de;
    if (cases.length > 0) {
      let pushed = 0, failed = 0;
      for (const c of cases) {
        const row = caseToRow(c);
        if (!row.created_by) { row.created_by = currentUser.id; row.created_by_name = row.created_by_name || currentUserName; }
        const { data, error } = await sbClient.from('cases').insert(row).select().single();
        if (error) { console.warn('Failed to push case', c.num, ':', error.message); failed++; }
        else { c._id = data.id; pushed++; }
      }
      if (failed > 0) showToast(pushed + ' pushed, ' + failed + ' failed — check console','error');
      else showToast(pushed + ' cases pushed to Supabase ✓','success');
      await pullFromSupabase();
    } else { showToast('No cases to push',''); }
    setSbStatus('connected','Connected');
    const ls = document.getElementById('sb-last-sync');
    if (ls) { ls.textContent = '⬆ Pushed ' + new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); ls.style.display = 'block'; }
  } catch(e) { setSbStatus('error','Push failed'); showToast('Push error: ' + e.message,'error'); }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && sbClient && currentUser && !isOffline) {
    await pullFromSupabase();
  }
});

async function syncCaseToSupabase(c, mode) {
  if (!sbClient) return;
  setSbStatus('syncing','Syncing...');
  try {
    const row = caseToRow(c);
    if (mode === 'update' && c._id) {
      const { error } = await sbClient.from('cases').update(row).eq('id', c._id);
      if (error) throw error;
    } else {
      const { data, error } = await sbClient.from('cases').insert(row).select().single();
      if (error) throw error;
      c._id = data.id;
    }
    const now = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    setSbStatus('connected','Connected');
    const ls = document.getElementById('sb-last-sync');
    if (ls) { ls.textContent = '✓ Synced ' + now; ls.style.display = 'block'; }
  } catch(e) { setSbStatus('error','Sync failed'); showToast('Sync error: ' + e.message,'error'); }
}

async function deleteCaseFromSupabase(c) {
  if (!sbClient || !c._id) return;
  try { await sbClient.from('cases').delete().eq('id', c._id); } catch(e) {}
}

async function clearSupabaseData() {
  if (currentUserRole !== 'admin') { showToast('Admin access only','error'); return; }
  if (!sbClient) return;
  if (!confirm('Delete ALL cases from Supabase? Cannot be undone.')) return;
  try {
    const { error } = await sbClient.from('cases').delete().neq('id','00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    showToast('Cloud data cleared','error');
  } catch(e) { showToast('Error: ' + e.message,'error'); }
}

// ══════════════════════════════════════════════
// EXCEL — DOWNLOAD ONLY (no file linking)
// ══════════════════════════════════════════════
function buildWorkbook() {
  const wb  = XLSX.utils.book_new();
  const hdr = ['Case No.','Full Names','ID Number','Date of Birth','Tribe','Village','Address','Case Type','Date of Case','Employment Status','Description','Assistance','Status','Contacts','Created By','Last Edited By'];
  const rows = cases.map(c => [c.num,c.name,c.idNumber,c.dob,c.tribe,c.village,c.address,c.type,c.caseDate||'',c.employStatus||'',c.desc,c.assist,c.status,c.contacts,c.createdByName,c.updatedByName]);
  const ws  = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
  ws['!cols'] = [10,26,16,14,14,18,22,18,14,16,36,32,12,20,18,18].map(w => ({ wch: w }));
  const ws2 = XLSX.utils.aoa_to_sheet([
    ['Metric','Count'],
    ['Total',   cases.length],
    ['Ongoing', cases.filter(c => c.status === 'Ongoing').length],
    ['Pending', cases.filter(c => c.status === 'Pending').length],
    ['Closed',  cases.filter(c => c.status === 'Closed').length]
  ]);
  XLSX.utils.book_append_sheet(wb, ws,  'Case Register');
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');
  return wb;
}

function exportFallback() {
  const date = new Date().toISOString().slice(0,10);
  XLSX.writeFile(buildWorkbook(), 'case_register_' + date + '.xlsx');
  showToast('Excel downloaded','success');
}

async function clearAllData() {
  if (currentUserRole !== 'admin') { showToast('Admin access only','error'); return; }
  if (!confirm('Clear all local cases from this device?')) return;
  cases = [];
  await idbSaveCases([]);
  updateAll();
  showToast('Local data cleared','error');
}

// ══════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════
let editingUserId = null;
const CREATE_USER_FN_URL = 'https://rsfpqgctxuiawcoglede.supabase.co/functions/v1/create-user';

async function adminCreateUser() {
  if (currentUserRole !== 'admin') { showToast('Admin access only', 'error'); return; }
  const err = document.getElementById('au-error');
  err.classList.remove('show');
  const name       = document.getElementById('au-name').value.trim();
  const email      = document.getElementById('au-email').value.trim();
  const password   = document.getElementById('au-password').value;
  const role       = document.getElementById('au-role').value;
  const settlement = document.getElementById('au-settlement').value.trim();
  if (!name || !email || !password) { err.textContent = 'Name, email and password are required'; err.classList.add('show'); return; }
  if (password.length < 6) { err.textContent = 'Password must be at least 6 characters'; err.classList.add('show'); return; }
  const btn = document.getElementById('au-submit-btn');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    if (!session) throw new Error('Your session has expired — please sign in again.');
    const res = await fetch(CREATE_USER_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ name, email, password, role, settlement }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to create user');
    showToast('User "' + name + '" created successfully', 'success');
    document.getElementById('au-name').value = '';
    document.getElementById('au-email').value = '';
    document.getElementById('au-password').value = '';
    document.getElementById('au-settlement').value = '';
    document.getElementById('au-role').value = 'officer';
    await sbClient.from('audit_log').insert({ action:'USER_CREATE', case_num:null, performed_by:currentUser.id, performed_by_name:currentUserName, performed_at:new Date().toISOString(), details:{ new_user_email:email, new_user_name:name, role } });
    await loadAdminUsers();
  } catch(e) { err.textContent = e.message; err.classList.add('show'); }
  finally { btn.disabled = false; btn.textContent = '✨ Create User'; }
}

async function loadAdminUsers() {
  if (!sbClient || currentUserRole !== 'admin') return;
  const fset = document.getElementById('admin-filter-settlement')?.value || '';
  try {
    const { data: profiles, error } = await sbClient.from('user_profiles').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    allProfiles = profiles || [];
    const { data: caseCounts } = await sbClient.from('cases').select('created_by, village');
    const settlementUserIds  = allProfiles.filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase()).map(p => p.id);
    const filteredCaseCounts = fset ? (caseCounts||[]).filter(c => settlementUserIds.includes(c.created_by)) : (caseCounts||[]);
    const visibleProfiles    = fset ? allProfiles.filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase()) : allProfiles;

    document.getElementById('admin-total-users').textContent  = visibleProfiles.length;
    document.getElementById('admin-officers').textContent     = visibleProfiles.filter(p => p.role==='officer').length;
    document.getElementById('admin-coordinators').textContent = visibleProfiles.filter(p => p.role==='coordinator').length;
    document.getElementById('admin-user-count').textContent   = visibleProfiles.length + ' users';

    const tbody = document.getElementById('admin-tbody');
    const empty = document.getElementById('admin-empty');
    tbody.innerHTML = '';
    empty.style.display = visibleProfiles.length === 0 ? 'block' : 'none';

    const countMap = {};
    filteredCaseCounts.forEach(r => { if (r.created_by) countMap[r.created_by] = (countMap[r.created_by]||0)+1; });

    visibleProfiles.forEach(p => {
      const isMe      = p.id === currentUser.id;
      const caseCount = countMap[p.id] || 0;
      const joined    = p.created_at ? new Date(p.created_at).toLocaleDateString('en-GB') : '—';
      const roleBadge = {
        officer:     '<span style="background:#dbeafe;color:#1a4a8a;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600">Officer</span>',
        coordinator: '<span style="background:#fef7e6;color:#8a5c00;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600">Coordinator</span>',
        admin:       '<span style="background:#f3e8ff;color:#6b21a8;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600">Admin</span>',
      }[p.role] || p.role;
      tbody.insertAdjacentHTML('beforeend', `<tr>
        <td class="name-cell">${esc(p.full_name||'—')} ${isMe ? '<span style="font-size:10px;color:var(--text-muted)">(you)</span>' : ''}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(p.email||'—')}</td>
        <td>${roleBadge}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(p.settlement||'—')}</td>
        <td style="text-align:center;font-weight:600;color:var(--navy)">${caseCount}</td>
        <td style="font-size:12px;color:var(--text-muted)">${joined}</td>
        <td>${isMe ? '<span style="font-size:12px;color:var(--text-light)">—</span>'
          : `<select onchange="changeUserRole('${p.id}', this.value, this)" style="font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--cream)">
              <option value="officer"     ${p.role==='officer'     ? 'selected':''}>Officer</option>
              <option value="coordinator" ${p.role==='coordinator' ? 'selected':''}>Coordinator</option>
              <option value="admin"       ${p.role==='admin'       ? 'selected':''}>Admin</option>
             </select>`}</td>
        <td><div style="display:flex;gap:5px">
          <button class="btn btn-outline btn-sm" onclick="openEditUserModal('${p.id}')">✎ Edit</button>
          ${isMe
            ? '<span style="font-size:11px;color:var(--text-light);padding:4px">Cannot delete self</span>'
            : `<button class="btn btn-danger btn-sm" onclick="deleteUser('${p.id}','${esc(p.full_name||p.email)}')">✕ Delete</button>`}
        </div></td></tr>`);
    });
  } catch(e) { showToast('Error loading users: ' + e.message,'error'); }
}

async function changeUserRole(userId, newRole, selectEl) {
  if (currentUserRole !== 'admin') { showToast('Admin only','error'); return; }
  try {
    const { error } = await sbClient.from('user_profiles').update({ role: newRole, updated_at: new Date().toISOString() }).eq('id', userId);
    if (error) throw error;
    selectEl.setAttribute('data-original', newRole);
    showToast('Role updated to ' + newRole,'success');
    const p = allProfiles.find(x => x.id === userId);
    if (p) p.role = newRole;
    await sbClient.from('audit_log').insert({ action:'ROLE_CHANGE', case_num:null, performed_by:currentUser.id, performed_by_name:currentUserName, performed_at:new Date().toISOString(), details:{ user_id:userId, new_role:newRole } });
  } catch(e) { showToast('Error: ' + e.message,'error'); }
}

function updateTopbarMsgBadge() {
  const count = unreadCaseIds.size;
  const btn   = document.getElementById('topbar-msg-btn');
  const badge = document.getElementById('topbar-msg-badge');
  if (!btn || !badge) return;
  btn.style.display = 'inline-flex';
  if (count > 0) { badge.textContent = count; badge.style.display = 'flex'; }
  else { badge.style.display = 'none'; }
}

function openEditUserModal(userId) {
  const p = allProfiles.find(x => x.id === userId); if (!p) return;
  editingUserId = userId;
  document.getElementById('edit-user-sub').textContent  = p.email;
  document.getElementById('eu-name').value              = p.full_name  || '';
  document.getElementById('eu-email').value             = p.email      || '';
  document.getElementById('eu-role').value              = p.role       || 'officer';
  document.getElementById('eu-settlement').value        = p.settlement || '';
  document.getElementById('edit-user-modal').classList.add('open');
}

function closeEditUserModal() { document.getElementById('edit-user-modal').classList.remove('open'); editingUserId = null; }

async function saveEditUser() {
  if (!editingUserId || currentUserRole !== 'admin') return;
  const name       = document.getElementById('eu-name').value.trim();
  const role       = document.getElementById('eu-role').value;
  const settlement = document.getElementById('eu-settlement').value.trim();
  if (!name) { showToast('Name is required','error'); return; }
  try {
    const { error } = await sbClient.from('user_profiles').update({ full_name:name, role, settlement, updated_at:new Date().toISOString() }).eq('id', editingUserId);
    if (error) throw error;
    const p = allProfiles.find(x => x.id === editingUserId);
    if (p) { p.full_name = name; p.role = role; p.settlement = settlement; }
    showToast('User updated successfully','success');
    await sbClient.from('audit_log').insert({ action:'USER_EDIT', case_num:null, performed_by:currentUser.id, performed_by_name:currentUserName, performed_at:new Date().toISOString(), details:{ user_id:editingUserId, new_name:name, new_role:role, settlement } });
    closeEditUserModal();
    await loadAdminUsers();
  } catch(e) { showToast('Error: ' + e.message,'error'); }
}

async function deleteUser(userId, displayName) {
  if (currentUserRole !== 'admin') { showToast('Admin only','error'); return; }
  if (userId === currentUser.id)   { showToast('Cannot delete your own account','error'); return; }
  if (!confirm(`Delete user "${displayName}"?\n\nThis removes their profile and access. Their cases will remain in the system.`)) return;
  try {
    const { error } = await sbClient.from('user_profiles').delete().eq('id', userId);
    if (error) throw error;
    showToast('User "' + displayName + '" removed','error');
    await sbClient.from('audit_log').insert({ action:'USER_DELETE', case_num:null, performed_by:currentUser.id, performed_by_name:currentUserName, performed_at:new Date().toISOString(), details:{ deleted_user_id:userId, deleted_name:displayName } });
    await loadAdminUsers();
  } catch(e) { showToast('Error: ' + e.message,'error'); }
}

// ══════════════════════════════════════════════
// SETTLEMENT FILTER
// ══════════════════════════════════════════════
async function loadSettlementFilter() {
  if (!sbClient || !currentUser) return;
  try {
    const { data: profiles, error } = await sbClient.from('user_profiles').select('settlement, full_name, role');
    if (error || !profiles || profiles.length === 0) return;
    const withSettlement = profiles.filter(p => p.settlement && p.settlement.trim() !== '');
    if (withSettlement.length === 0) return;
    const seen = new Set(), opts = [];
    withSettlement.forEach(p => {
      const key = p.settlement.trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); opts.push({ value: p.settlement.trim(), label: p.settlement.trim() + ' (' + (p.full_name||'Unknown') + ')' }); }
    });
    opts.sort((a,b) => a.label.localeCompare(b.label));
    ['filter-settlement','coord-filter-settlement','admin-filter-settlement'].forEach(id => {
      const sel = document.getElementById(id); if (!sel) return;
      sel.innerHTML = '<option value="">All settlements</option>';
      opts.forEach(o => { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; sel.appendChild(opt); });
    });
  } catch(e) { console.warn('Settlement filter error:', e.message); }
}

async function loadAllProfiles() {
  if (!sbClient) return;
  try {
    const { data, error } = await sbClient.from('user_profiles').select('id, full_name, role, settlement');
    if (!error && data) allProfiles = data;
  } catch(e) {}
}

// ══════════════════════════════════════════════
// AI INSIGHTS
// ══════════════════════════════════════════════
let aiSelCase = null;
const AI_SYS  = `You are a legal case analyst for Ditshwanelo — The Botswana Centre for Human Rights. Analyse case data and produce clear, professional insights. Use **bold** for headings and key points. Cite specific numbers. Be thorough but concise.`;

function initAiPage() {
  const k = ['gsk_','xx','xx','your','key','here'].join('');
  document.getElementById('ai-api-key').value = k;
  sessionStorage.setItem('ditsh_ai_key', k);
  aiRenderCaseGrid();
}
function aiSaveKey(v) { if (v.trim()) sessionStorage.setItem('ditsh_ai_key', v.trim()); else sessionStorage.removeItem('ditsh_ai_key'); }
function aiGetKey() { return ['gsk_y0a3','37r1K7wH','roZOBRAy','WGdyb3FY','jVTlPNP1','w3zjoeBc','SR1m9bVX'].join(''); }
function aiTab(t) {
  ['overview','case','village','custom'].forEach(x => {
    document.getElementById('aitab-' + x).classList.toggle('active', x === t);
    document.getElementById('aip-'   + x).style.display = x === t ? '' : 'none';
  });
}

function aiDigest() {
  if (!cases.length) return 'No cases in the system yet.';
  const byStatus = {}, byType = {}, byVillage = {};
  cases.forEach(c => {
    byStatus[c.status||'Unknown']   = (byStatus[c.status||'Unknown']||0)+1;
    byType[c.type||'Unknown']       = (byType[c.type||'Unknown']||0)+1;
    byVillage[c.village||'Unknown'] = (byVillage[c.village||'Unknown']||0)+1;
  });
  const summary = [`Total cases: ${cases.length}`,`Status breakdown: ${JSON.stringify(byStatus)}`,`Case types: ${JSON.stringify(byType)}`,`Villages (${Object.keys(byVillage).length}): ${JSON.stringify(byVillage)}`,'','=== FULL CASE DETAILS ===',''].join('\n');
  const fullCases = cases.map(c => [`Case: ${c.num||'?'}`,`Name: ${c.name||'?'}`,`ID Number: ${c.idNumber||'—'}`,`DOB: ${c.dob||'—'}`,`Tribe: ${c.tribe||'—'}`,`Village: ${c.village||'—'}`,`Address: ${c.address||'—'}`,`Contacts: ${c.contacts||'—'}`,`Type: ${c.type||'—'}`,`Status: ${c.status||'—'}`,`Date of Case: ${c.caseDate||'—'}`,`Employment Status: ${c.employStatus||'—'}`,`Officer: ${c.createdByName||'—'}`,`Description: ${c.desc||'—'}`,`Assistance Given: ${c.assist||'—'}`,'---'].join('\n')).join('\n');
  return summary + fullCases;
}

function aiCaseDetail(c) {
  return [`Case: ${c.num}`,`Name: ${c.name}`,`ID: ${c.idNumber||'—'}`,`DOB: ${c.dob||'—'}`,`Tribe: ${c.tribe||'—'}`,`Village: ${c.village||'—'}`,`Address: ${c.address||'—'}`,`Type: ${c.type||'—'}`,`Status: ${c.status||'—'}`,`Description: ${c.desc||'—'}`,`Assistance: ${c.assist||'—'}`,`Contacts: ${c.contacts||'—'}`,`Officer: ${c.createdByName||'—'}`].join('\n');
}

async function aiCall(prompt, outId, ubarId, utxtId, btnId) {
  const key = aiGetKey();
  const btn = document.getElementById(btnId);
  btn.classList.add('loading'); btn.disabled = true;
  const out = document.getElementById(outId);
  out.innerHTML = '<span class="scursor"></span>';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:1500, messages:[{ role:'system', content:AI_SYS },{ role:'user', content:prompt }] })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({ error:{ message:res.statusText } })); throw new Error(e.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();
    const full = data.choices?.[0]?.message?.content || '';
    out.innerHTML = aiFmt(full);
    const inTok = data.usage?.prompt_tokens || 0, outTok = data.usage?.completion_tokens || 0;
    const ub = document.getElementById(ubarId), ut = document.getElementById(utxtId);
    if (ub && ut) { ut.textContent = inTok + ' in · ' + outTok + ' out tokens'; ub.style.display = 'flex'; }
  } catch(e) { out.innerHTML = `<p style="color:var(--danger)">⚠️ <strong>Error:</strong> ${esc(e.message)}</p>`; }
  finally { btn.classList.remove('loading'); btn.disabled = false; }
}

function aiFmt(t) {
  return '<p>' + t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/^#{1,4}\s+(.+)$/gm,'<h4>$1</h4>').replace(/^[-•]\s+(.+)$/gm,'<li>$1</li>').replace(/(<li>[\s\S]*?<\/li>)/g,'<ul>$1</ul>').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>') + '</p>';
}

function aiCopy(id) { navigator.clipboard.writeText(document.getElementById(id).innerText || '').then(() => showToast('Copied to clipboard','success')).catch(() => {}); }

const aiOvPrompts = {
  full:    d => `Comprehensive analysis of this Ditshwanelo case register:\n\n${d}`,
  summary: d => `Write a 5-7 sentence executive summary for senior management of this case register:\n\n${d}`,
  trends:  d => `Analyse trends and patterns. What case types are most common? Geographic clusters? Open/closed ratio insights?\n\n${d}`,
  risk:    d => `Identify the highest-risk or most urgent cases. Flag anything open too long or complex. Be specific.\n\n${d}`,
  recs:    d => `Provide 5-8 specific actionable recommendations for case management, resource allocation, and strategy.\n\n${d}`,
  report:  d => `Full management report: Executive Summary, Statistics, Key Findings, Geographic Analysis, Recommendations, Conclusion.\n\n${d}`,
};
const aiOvTitles = { full:'Case Register Overview', summary:'Executive Summary', trends:'Trends & Patterns', risk:'Risk Case Analysis', recs:'Recommendations', report:'Full Report' };

function aiOverviewRun(mode) { document.getElementById('ai-ov-title').textContent = aiOvTitles[mode] || 'Overview'; aiCall(aiOvPrompts[mode](aiDigest()), 'ai-ov-body','ai-ov-ubar','ai-ov-utxt','ai-ov-btn'); }

const aiVlPrompts = {
  full:         d => `Geographic/village analysis of this case data:\n\n${d}`,
  hotspots:     d => `Identify top 5-8 hotspot villages with highest case concentrations. What's driving the numbers?\n\n${d}`,
  distribution: d => `How are cases distributed geographically? Concentrated or spread? What does this mean for service delivery?\n\n${d}`,
  types:        d => `For each major village, break down case types. Identify village-specific patterns or anomalies.\n\n${d}`,
  underserved:  d => `Identify underserved villages where numbers are suspiciously low or unresolved cases suggest lack of resources.\n\n${d}`,
};

function aiVillageRun(mode) { aiCall(aiVlPrompts[mode](aiDigest()), 'ai-vl-body','ai-vl-ubar','ai-vl-utxt','ai-vl-btn'); }

function aiRenderCaseGrid() {
  const grid = document.getElementById('ai-case-grid');
  if (!cases.length) { grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;grid-column:1/-1">No cases loaded yet.</div>'; return; }
  grid.innerHTML = cases.map((c,i) => `
    <div class="csc" id="aic-${i}" onclick="aiSelectCase(${i})">
      <div class="csc-num">${esc(c.num||'—')}</div>
      <div class="csc-name">${esc(c.name||'Unknown')}</div>
      <div class="csc-meta">${esc(c.type||'—')} · ${esc(c.village||'—')} · <span style="font-weight:600;color:${c.status==='Ongoing'?'var(--info)':c.status==='Pending'?'var(--warn)':'var(--success)'}">${esc(c.status||'—')}</span></div>
    </div>`).join('');
}

function aiSelectCase(i) {
  aiSelCase = i;
  document.querySelectorAll('.csc').forEach((el,j) => el.classList.toggle('sel', j===i));
  const c = cases[i];
  document.getElementById('ai-cs-title').textContent = (c.num||'Case') + ' · ' + (c.name||'Unknown');
  document.getElementById('ai-cs-btn').disabled = false;
}

function aiCaseRun() {
  if (aiSelCase === null) return;
  aiCall(`Professional case brief for Ditshwanelo. Include: 1) Case Summary 2) Key Facts 3) Status Assessment 4) Recommended Next Steps 5) Red flags or urgent concerns.\n\n${aiCaseDetail(cases[aiSelCase])}`, 'ai-cs-body','ai-cs-ubar','ai-cs-utxt','ai-cs-btn');
}

function aiSetQ(q) { document.getElementById('ai-cq').value = q; }
function aiCustomRun() {
  const q = document.getElementById('ai-cq').value.trim();
  if (!q) { showToast('Please type a question first','error'); return; }
  aiCall(`Analyse this Ditshwanelo case data and answer:\n\nQUESTION: ${q}\n\nDATA:\n${aiDigest()}`, 'ai-cq-body','ai-cq-ubar','ai-cq-utxt','ai-cq-btn');
}

// ══════════════════════════════════════════════
// UNREAD GUIDANCE
// ══════════════════════════════════════════════
async function markUnread(caseId) {
  if (!sbClient || !currentUser) return;
  await sbClient.from('guidance_unread').upsert(
    { case_id:caseId, user_id:currentUser.id, unread:true, updated_at:new Date().toISOString() },
    { onConflict:'case_id,user_id' }
  );
  await loadUnreadCounts();
}

async function markRead(caseId) {
  if (!sbClient || !currentUser) return;
  await sbClient.from('guidance_unread').update({ unread:false, updated_at:new Date().toISOString() }).eq('case_id', caseId).eq('user_id', currentUser.id);
  await loadUnreadCounts();
}

let unreadCaseIds = new Set();

async function loadUnreadCounts() {
  if (!sbClient || !currentUser) return;
  try {
    const { data, error } = await sbClient.from('guidance_unread').select('case_id').eq('user_id', currentUser.id).eq('unread', true);
    if (error) throw error;
    unreadCaseIds = new Set((data || []).map(r => r.case_id));
    updateAll();
    updateTopbarMsgBadge();
  } catch(e) { console.warn('loadUnreadCounts error:', e.message); }
}

function getUnreadCount(caseId) { return unreadCaseIds.has(caseId) ? 1 : 0; }

function openGuidanceInbox() {
  if (unreadCaseIds.size === 0) { showToast('No unread guidance messages', ''); return; }
  [...unreadCaseIds].forEach(caseId => openGuidanceDirect(caseId));
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function showToast(msg, type='') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openCaseGuidance() {
  if (!window.currentViewCaseId) { alert('Open a case first.'); return; }
  window.open('case-guidance.html?case=' + window.currentViewCaseId, '_blank');
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
document.getElementById('case-modal').addEventListener('click',      e => { if (e.target === document.getElementById('case-modal'))      closeModal(); });
document.getElementById('view-modal').addEventListener('click',      e => { if (e.target === document.getElementById('view-modal'))      closeViewModal(); });
document.getElementById('edit-user-modal').addEventListener('click', e => { if (e.target === document.getElementById('edit-user-modal')) closeEditUserModal(); });

document.querySelector('.layout').style.display = 'none';
setSbStatus('off','Offline');
updateSbUI();
updateDbUI();

const savedCreds = loadSbCreds();
if (savedCreds) {
  document.getElementById('sb-url').value = savedCreds.url;
  document.getElementById('sb-key').value = savedCreds.key;
}

initAuth();
document.getElementById('logo-auth').src    = LOGO_BASE64;
document.getElementById('logo-sidebar').src = LOGO_BASE64;