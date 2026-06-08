
// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let cases = [];
let auditLog = [];
let editIdx = -1;
let currentPage = 'dashboard';
let sbClient = null;
let dbFileHandle = null;
let currentUser = null;
let currentUserName = '';
let currentUserRole = 'officer';
let coordSelectedVillage = null;
let allProfiles = [];
const HAS_FSA = ('showOpenFilePicker' in window);
const SB_CREDS_KEY = 'legalaid_sb_creds_v3';

// ══════════════════════════════════════════════
// OFFLINE & PIN SYSTEM
// ══════════════════════════════════════════════
const PIN_KEY     = 'legalaid_pin_v1';
const CACHE_KEY   = 'legalaid_cache_v1';
const PROFILE_KEY = 'legalaid_profile_v1';
let pinBuffer     = '';
let setPinBuffer  = '';
let setPinStage   = 'first';
let setPinFirst   = '';
let isOffline     = false;

function isOnline() { return navigator.onLine; }

function savePin(pin)  { localStorage.setItem(PIN_KEY, _enc(pin)); }
function loadPin()     { const s = localStorage.getItem(PIN_KEY); return s ? _dec(s) : null; }
function clearPin()    { localStorage.removeItem(PIN_KEY); }

function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch(e) {}
}
function loadCache() {
  try { const r = localStorage.getItem(CACHE_KEY); return r ? JSON.parse(r) : null; } catch(e) { return null; }
}
function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch(e) {}
}
function loadProfile() {
  try { const r = localStorage.getItem(PROFILE_KEY); return r ? JSON.parse(r) : null; } catch(e) { return null; }
}

// ── OFFLINE BANNER ──
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
// SYNC ENGINE — Merge-based, never overwrites
// ══════════════════════════════════════════════
async function syncOnReconnect() {
  if (!sbClient || !currentUser) return;
  showToast('Back online — syncing changes...', '');
  setSbStatus('syncing', 'Syncing...');

  try {
    // Step 1: Get what is currently in Supabase
    const { data: cloudRows, error } = await sbClient.from('cases').select('*');
    if (error) throw error;

    const cloudCases = cloudRows.map(rowToCase);

    // Step 2: Build lookup maps by _id and by case num
    const cloudById  = {};
    const cloudByNum = {};
    cloudCases.forEach(c => {
      if (c._id) cloudById[c._id]  = c;
      if (c.num) cloudByNum[c.num] = c;
    });

    // Step 3: Decide what to insert or update in Supabase
    const toInsert = [];
    const toUpdate = [];

    cases.forEach(local => {
      const byId  = local._id ? cloudById[local._id]   : null;
      const byNum = local.num ? cloudByNum[local.num]  : null;
      const cloud = byId || byNum;

      if (!cloud) {
        // Exists locally but not in cloud — push it up
        toInsert.push(local);
      } else {
        // Exists in both — whoever was edited most recently wins
        const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
        const cloudTime = new Date(cloud.updatedAt || cloud.createdAt || 0).getTime();
        if (localTime > cloudTime) {
          local._id = cloud._id; // ensure we use the Supabase ID
          toUpdate.push(local);
        }
        // cloud is same age or newer — pull will bring it down
      }
    });

    // Step 4: Push new local cases up to Supabase
    for (const c of toInsert) {
      const row = caseToRow(c);
      if (!row.created_by) {
        row.created_by      = currentUser.id;
        row.created_by_name = currentUserName;
      }
      const { data, error: ie } = await sbClient
        .from('cases').insert(row).select().single();
      if (!ie && data) c._id = data.id;
      else if (ie) console.warn('Insert failed for', c.num, ie.message);
    }

    // Step 5: Push updated local cases up to Supabase
    for (const c of toUpdate) {
      const row = caseToRow(c);
      const { error: ue } = await sbClient
        .from('cases').update(row).eq('id', c._id);
      if (ue) console.warn('Update failed for', c.num, ue.message);
    }

    const pushed = toInsert.length + toUpdate.length;

    // Step 6: Pull the fully merged result back down
    await pullFromSupabase();

    // Step 7: Write merged result to Excel so it is also up to date
    if (dbFileHandle) await writeToFile();

    if (pushed > 0) {
      showToast(
        'Synced: ' + toInsert.length + ' new + ' + toUpdate.length + ' updated → Supabase ✓',
        'success'
      );
    } else {
      showToast('Back online — already up to date ✓', 'success');
    }

  } catch (e) {
    setSbStatus('error', 'Sync failed');
    showToast('Sync error: ' + e.message, 'error');
  }
}

// ── PIN UI HELPERS ──
function updatePinDots(buf, prefix='') {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById((prefix ? prefix : '') + 'dot-' + i);
    if (!dot) continue;
    dot.style.background = i < buf.length ? 'var(--navy)' : 'var(--border)';
  }
}

function pinPress(d) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d;
  updatePinDots(pinBuffer);
  if (pinBuffer.length === 4) setTimeout(verifyPin, 200);
}
function pinBackspace() { pinBuffer = pinBuffer.slice(0,-1); updatePinDots(pinBuffer); }
function pinClear()     { pinBuffer = ''; updatePinDots(pinBuffer); }

function verifyPin() {
  const stored = loadPin();
  if (!stored) {
    showPinError('No PIN set. Please sign in online first.');
    pinBuffer = ''; updatePinDots(pinBuffer); return;
  }
  if (pinBuffer === stored) {
    const profile = loadProfile();
    const cache   = loadCache();
    if (!profile) { showPinError('No cached profile. Please sign in online first.'); pinBuffer = ''; return; }
    currentUserName = profile.name;
    currentUserRole = profile.role;
    currentUser     = { id: profile.id, email: profile.email };
    cases    = cache ? cache.cases    || [] : [];
    auditLog = cache ? cache.auditLog || [] : [];
    setOfflineMode(true);
    hideAuthScreen();
    updateUserChip();
    document.getElementById('nav-coordinator').style.display = ['coordinator','admin'].includes(currentUserRole) ? 'flex' : 'none';
    document.getElementById('nav-admin').style.display       = currentUserRole === 'admin' ? 'flex' : 'none';
    updateStats(); renderRecent(); updateDbUI(); updateSbUI();
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
    setPinFirst  = setPinBuffer;
    setPinBuffer = '';
    setPinStage  = 'confirm';
    const titleEl = document.querySelector('#auth-step-setpin div:nth-child(1) div:nth-child(2)');
    if (titleEl) titleEl.textContent = 'Confirm your PIN';
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById('sdot-' + i);
      if (dot) dot.style.background = 'var(--border)';
    }
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
      for (let i = 0; i < 4; i++) {
        const dot = document.getElementById('sdot-' + i);
        if (dot) dot.style.background = 'var(--border)';
      }
    }
  }
}

function skipSetPin() {
  document.getElementById('auth-step-setpin').style.display = 'none';
  hideAuthScreen();
}

function showChangePinModal() {
  setPinBuffer = ''; setPinFirst = ''; setPinStage = 'first';
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('sdot-' + i);
    if (dot) dot.style.background = 'var(--border)';
  }
  document.getElementById('auth-step-setpin').style.display = 'block';
  document.querySelectorAll('#auth-screen > .auth-box > div').forEach(d => {
    if (d.id !== 'auth-step-setpin') d.style.display = 'none';
  });
  showAuthScreen();
}

// ══════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) =>
    t.classList.toggle('active', (i===0 && tab==='login') || (i===1 && tab==='signup'))
  );
  document.getElementById('login-form').style.display  = tab === 'login'  ? 'flex' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? 'flex' : 'none';
}

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
    document.getElementById('auth-step-login').style.display = 'block';
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
  document.getElementById('auth-step-login').style.display = 'none';
}

async function initAuth() {
  const creds = loadSbCreds();

  if (!creds) {
    if (!isOnline() && loadPin() && loadProfile()) { showPinScreen(); return; }
    document.getElementById('auth-step-creds').style.display  = 'block';
    document.getElementById('auth-step-login').style.display = 'none';
    showAuthScreen(); return;
  }

  try {
    const { createClient } = supabase;
    sbClient = createClient(creds.url, creds.key);
    document.getElementById('sb-url').value = creds.url;
    document.getElementById('sb-key').value = creds.key;

    if (!isOnline()) {
      if (loadPin() && loadProfile()) { showPinScreen(); }
      else {
        document.getElementById('auth-step-creds').style.display  = 'none';
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
      document.getElementById('auth-step-creds').style.display  = 'none';
      document.getElementById('auth-step-login').style.display = 'block';
      showAuthScreen();
    }
  } catch(e) {
    if (loadPin() && loadProfile()) { showPinScreen(); }
    else {
      document.getElementById('auth-step-creds').style.display  = 'block';
      document.getElementById('auth-step-login').style.display = 'none';
      showAuthScreen();
    }
  }
}

function showPinScreen() {
  pinBuffer = ''; updatePinDots(pinBuffer);
  const profile  = loadProfile();
  const pinTitle = document.getElementById('pin-title');
  if (pinTitle && profile) pinTitle.textContent = 'Welcome back, ' + (profile.name || '');
  document.getElementById('auth-step-creds').style.display   = 'none';
  document.getElementById('auth-step-login').style.display   = 'none';
  document.getElementById('auth-step-pin').style.display     = 'block';
  document.getElementById('auth-step-setpin').style.display  = 'none';
  showAuthScreen();
}

function showAuthScreen() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.querySelector('.layout').style.display = 'none';
}
function hideAuthScreen() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.querySelector('.layout').style.display = 'flex';
}

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

async function doSignup() {
  const name  = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pw    = document.getElementById('signup-password').value;
  const err   = document.getElementById('signup-error');
  err.classList.remove('show'); err.style.color = '';
  if (!name || !email || !pw) { err.textContent = 'All fields required'; err.classList.add('show'); return; }
  if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters'; err.classList.add('show'); return; }
  try {
    const { data, error } = await sbClient.auth.signUp({ email, password: pw, options: { data: { full_name: name, role: 'officer' } } });
    if (error) throw error;
    if (data.user) {
      await sbClient.from('user_profiles').upsert(
        { id: data.user.id, full_name: name, email, role: 'officer' },
        { onConflict: 'id' }
      );
    }
    err.style.color  = 'var(--success)';
    err.textContent  = '✓ Account created! Check your email to confirm, then sign in.';
    err.classList.add('show');
  } catch(e) { err.textContent = e.message; err.classList.add('show'); }
}

async function onAuthSuccess(user) {
  currentUser     = user;
  currentUserName = user.user_metadata?.full_name || user.email;
  try {
    const { data: profile } = await sbClient
      .from('user_profiles').select('role,full_name').eq('id', user.id).single();
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

  saveProfile({ id: user.id, email: user.email, name: currentUserName, role: currentUserRole });

  hideAuthScreen();
  updateUserChip();
  document.getElementById('nav-coordinator').style.display = ['coordinator','admin'].includes(currentUserRole) ? 'flex' : 'none';
  document.getElementById('nav-admin').style.display       = currentUserRole === 'admin' ? 'flex' : 'none';
  setSbStatus('connected', 'Connected');
  setOfflineMode(false);
  updateSbUI();
  await loadAllProfiles();
  await pullFromSupabase();
  await loadAuditLog();
  await autoConnectExcel();
  updateDbUI();

  if (!loadPin()) {
    setTimeout(() => {
      setPinBuffer = ''; setPinFirst = ''; setPinStage = 'first';
      for (let i = 0; i < 4; i++) {
        const dot = document.getElementById('sdot-' + i);
        if (dot) dot.style.background = 'var(--border)';
      }
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
  document.getElementById('auth-step-creds').style.display   = 'none';
  document.getElementById('auth-step-login').style.display   = 'block';
  document.getElementById('auth-step-pin').style.display     = 'none';
  document.getElementById('auth-step-setpin').style.display  = 'none';
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
  const inp  = document.getElementById(id);
  const show = inp.type === 'password';
  inp.type   = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

// ══════════════════════════════════════════════
// PAGE NAV
// ══════════════════════════════════════════════
function showPage(page) {
  if (page === 'admin'       && currentUserRole !== 'admin')                          { showToast('Admin access only','error'); return; }
  if (page === 'coordinator' && !['coordinator','admin'].includes(currentUserRole))   { showToast('Coordinator/Admin access only','error'); return; }
  document.querySelectorAll('.page').forEach(p     => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const titles = { dashboard:'Dashboard', cases:'All Cases', coordinator:'Coordinator Panel', audit:'Audit Log', database:'Database Settings', admin:'Admin Panel', ai:'AI Insights' };
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
      <td>${esc(c.idNumber) || '—'}</td>
      <td>${esc(c.village)  || '—'}</td>
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
    const settlementUserIds = allProfiles
      .filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase())
      .map(p => p.id);
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
      <td>${esc(c.tribe)    || '—'}</td>
      <td>${esc(c.village)  || '—'}</td>
      <td>${esc(c.type)}</td>
      <td><span class="badge badge-${c.status.toLowerCase()}">${c.status}</span></td>
      <td><span style="font-size:11.5px;color:var(--text-muted)">${esc(c.updatedByName || c.createdByName || '—')}</span></td>
      <td><div style="display:flex;gap:4px">
        <button class="btn btn-outline btn-sm" onclick="viewCase(${i})">👁</button>
        <button class="btn btn-outline btn-sm" onclick="editCase(${i})">✎</button>
        <button class="btn btn-danger btn-sm"  onclick="deleteCase(${i})">✕</button>
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
    const settlementUserIds = allProfiles
      .filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase())
      .map(p => p.id);
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
        ${open    ? `<span class="vc-stat ongoing">${open} Ongoing</span>`   : ''}
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
      <td>${esc(c.tribe)    || '—'}</td>
      <td>${esc(c.address)  || '—'}</td>
      <td>${esc(c.type)}</td>
      <td><span class="badge badge-${c.status.toLowerCase()}">${c.status}</span></td>
      <td style="font-size:11.5px;color:var(--text-muted)">${esc(c.createdByName || '—')}</td>
      <td><div style="display:flex;gap:4px">
        <button class="btn btn-outline btn-sm" onclick="viewCase(${idx})">👁</button>
        <button class="btn btn-outline btn-sm" onclick="editCase(${idx})">✎</button>
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
  if (sbClient) {
    try { await sbClient.from('audit_log').insert(entry); } catch(e) {}
  }
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
  ['f-num','f-name','f-idnum','f-tribe','f-village','f-address','f-contacts','f-desc','f-assist'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-dob').value    = '';
  document.getElementById('f-num').value    = autoNum();
  document.getElementById('f-type').value   = 'Labour Dispute';
  document.getElementById('f-status').value = 'Ongoing';
  document.getElementById('case-modal').classList.add('open');
}

function autoNum() {
  const nums = cases.map(c => { const m = c.num.match(/(\d+)$/); return m ? parseInt(m[1]) : 0; });
  return 'G-' + (Math.max(0, ...nums) + 1).toString().padStart(3,'0');
}

function editCase(idx) {
  editIdx = idx; const c = cases[idx];
  document.getElementById('modal-title').textContent = 'Edit Case';
  document.getElementById('modal-sub').textContent   = c.num + ' — ' + c.name;
  document.getElementById('f-num').value      = c.num;
  document.getElementById('f-name').value     = c.name;
  document.getElementById('f-idnum').value    = c.idNumber  || '';
  document.getElementById('f-dob').value      = c.dob       || '';
  document.getElementById('f-tribe').value    = c.tribe     || '';
  document.getElementById('f-village').value  = c.village   || '';
  document.getElementById('f-address').value  = c.address   || '';
  document.getElementById('f-contacts').value = c.contacts  || '';
  document.getElementById('f-type').value     = c.type      || 'Labour Dispute';
  document.getElementById('f-desc').value     = c.desc      || '';
  document.getElementById('f-assist').value   = c.assist    || '';
  document.getElementById('f-status').value   = c.status    || 'Ongoing';
  document.getElementById('case-modal').classList.add('open');
  document.getElementById('view-modal').classList.remove('open');
}

function closeModal() { document.getElementById('case-modal').classList.remove('open'); }

async function saveCase() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { showToast('Please enter the full names.','error'); return; }
  const now   = new Date().toISOString();
  const entry = {
    num:      document.getElementById('f-num').value.trim() || autoNum(),
    name,
    idNumber: document.getElementById('f-idnum').value.trim(),
    dob:      document.getElementById('f-dob').value || null,
    tribe:    document.getElementById('f-tribe').value.trim(),
    village:  document.getElementById('f-village').value.trim(),
    address:  document.getElementById('f-address').value.trim(),
    contacts: document.getElementById('f-contacts').value.trim(),
    type:     document.getElementById('f-type').value,
    desc:     document.getElementById('f-desc').value.trim(),
    assist:   document.getElementById('f-assist').value.trim(),
    status:   document.getElementById('f-status').value,
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
  saveCache({ cases, auditLog }); // always update offline cache
  saveToDatabase();               // write to Excel if connected
  updateAll();
}

function deleteCase(idx) {
  if (!confirm('Delete case ' + cases[idx].num + ' — ' + cases[idx].name + '?')) return;
  const deleted = cases.splice(idx, 1)[0];
  logAudit('DELETE', deleted);
  if (!isOffline) deleteCaseFromSupabase(deleted);
  saveCache({ cases, auditLog });
  saveToDatabase();
  updateAll();
  showToast('Case deleted','error');
}

// ══════════════════════════════════════════════
// VIEW MODAL
// ══════════════════════════════════════════════
function viewCase(idx) {
  const c = cases[idx];
  document.getElementById('view-case-num').textContent  = c.num;
  document.getElementById('view-case-name').textContent = c.name;
  document.getElementById('view-edit-btn').onclick = () => editCase(idx);
  const fields = [
    { l:'Case Number',           v: c.num },
    { l:'Full Names',            v: c.name },
    { l:'ID Number',             v: c.idNumber },
    { l:'Date of Birth',         v: c.dob },
    { l:'Tribe',                 v: c.tribe },
    { l:'Contacts',              v: c.contacts },
    { l:'Village / Settlement',  v: c.village },
    { l:'Home Address / Ward',   v: c.address,  full: true },
    { l:'Case Type',             v: c.type },
    { l:'Status',                v: c.status },
    { l:'Brief Description',     v: c.desc,     full: true },
    { l:'Assistance Given',      v: c.assist,   full: true },
  ];
  document.getElementById('view-detail-grid').innerHTML = fields.map(f => `
    <div class="detail-field ${f.full ? 'full' : ''}">
      <div class="dl">${f.l}</div>
      <div class="dv ${!f.v ? 'empty' : ''}">${f.v ? esc(f.v) : 'Not recorded'}</div>
    </div>`).join('');
  const caseAudit = auditLog.filter(a => a.case_num === c.num).slice(0, 5);
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
}

// ══════════════════════════════════════════════
// SUPABASE
// ══════════════════════════════════════════════
const _ck = 'legalaid_v3_secure';
function _xor(str, key) {
  return str.split('').map((c,i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
}
function _enc(str) { return btoa(_xor(str, _ck)); }
function _dec(str) { try { return _xor(atob(str), _ck); } catch(e) { return ''; } }

function saveSbCreds() {
  const url = document.getElementById('sb-url').value.trim();
  const key = document.getElementById('sb-key').value.trim();
  if (url && key) {
    localStorage.setItem(SB_CREDS_KEY, JSON.stringify({ u: _enc(url), k: _enc(key) }));
  }
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
  if (clearLocked) clearLocked.style.display = isAdmin ? 'none'        : 'block';
  ['filter-settlement','coord-filter-settlement','admin-filter-settlement'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isElevated ? '' : 'none';
  });
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

function disconnectSupabase() {
  sbClient = null; setSbStatus('off','Offline'); updateSbUI(); showToast('Disconnected','');
}

function caseToRow(c) {
  const rawDob  = c.dob || '';
  const safeDob = /^\d{4}-\d{2}-\d{2}$/.test(rawDob) ? rawDob : null;
  return {
    num:              c.num            || '',
    name:             c.name           || '',
    id_number:        c.idNumber       || '',
    date_of_birth:    safeDob,
    tribe:            c.tribe          || '',
    village:          c.village        || '',
    address:          c.address        || '',
    type:             c.type           || '',
    description:      c.desc           || '',
    assistance:       c.assist         || '',
    status:           ['Ongoing','Pending','Closed'].includes(c.status) ? c.status : 'Ongoing',
    contacts:         c.contacts       || '',
    updated_at:       new Date().toISOString(),
    created_by:       c.createdBy      || null,
    created_by_name:  c.createdByName  || '',
    updated_by:       c.updatedBy      || null,
    updated_by_name:  c.updatedByName  || ''
  };
}

function rowToCase(r) {
  return {
    _id:            r.id,
    num:            r.num,
    name:           r.name,
    idNumber:       r.id_number       || '',
    dob:            r.date_of_birth   || '',
    tribe:          r.tribe           || '',
    village:        r.village         || '',
    address:        r.address         || '',
    type:           r.type            || '',
    desc:           r.description     || '',
    assist:         r.assistance      || '',
    status:         r.status          || 'Ongoing',
    contacts:       r.contacts        || '',
    createdAt:      r.created_at,
    createdBy:      r.created_by,
    createdByName:  r.created_by_name || '',
    updatedAt:      r.updated_at,
    updatedBy:      r.updated_by,
    updatedByName:  r.updated_by_name || ''
  };
}

async function pullFromSupabase() {
  if (!sbClient || !currentUser) return;
  setSbStatus('syncing','Pulling...');
  try {
    const { data, error } = await sbClient.from('cases').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    cases = data.map(rowToCase);

    // Always write to Excel after pull so offline copy stays current
    if (dbFileHandle) await writeToFile();

    // Always update offline cache after pull
    saveCache({ cases, auditLog });

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
        if (!row.created_by) {
          row.created_by      = currentUser.id;
          row.created_by_name = row.created_by_name || currentUserName;
        }
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
    setDbStatus('✓ Saved to Supabase + Excel at ' + now,'success');
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
// EXCEL
// ══════════════════════════════════════════════
const EXCEL_HANDLE_KEY = 'legalaid_excel_handle_v3';

function buildWorkbook() {
  const wb  = XLSX.utils.book_new();
  const hdr = ['Case No.','Full Names','ID Number','Date of Birth','Tribe','Village','Address','Case Type','Description','Assistance','Status','Contacts','Created By','Last Edited By'];
  const rows = cases.map(c => [c.num,c.name,c.idNumber,c.dob,c.tribe,c.village,c.address,c.type,c.desc,c.assist,c.status,c.contacts,c.createdByName,c.updatedByName]);
  const ws  = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
  ws['!cols'] = [10,26,16,14,14,18,22,18,36,32,12,20,18,18].map(w => ({ wch: w }));
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

function parseWorkbook(wb) {
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header:1 });
  if (data.length < 2) return [];

  const hdr = data[0].map(h => String(h || '').toLowerCase().trim());
  const col  = name => {
    const variants = {
      num:           ['case no.','case number','case no','num','case_no'],
      name:          ['full names','name','full name'],
      idNumber:      ['id no.','id number','id no','id_number','national id'],
      dob:           ['date of birth','dob','date_of_birth','birth date'],
      tribe:         ['tribe'],
      village:       ['village','village / settlement','village/settlement','settlement'],
      address:       ['home address / ward','address','ward','home address'],
      type:          ['case type','type'],
      desc:          ['brief description','description','desc'],
      assist:        ['assistance given','assist given','assistance'],
      status:        ['case status','status'],
      contacts:      ['contacts','contact'],
      createdByName: ['created by','officer'],
      updatedByName: ['last edited by','edited by','updated by'],
    };
    const keys = variants[name] || [name];
    for (const k of keys) { const idx = hdr.indexOf(k); if (idx !== -1) return idx; }
    return -1;
  };

  const hasHeaders = hdr.some(h => ['case no.','case number','full names','name'].includes(h));

  if (hasHeaders) {
    return data.slice(1).filter(r => r[col('num')] || r[col('name')]).map(r => {
      const rawDob  = String(r[col('dob')] || '').trim();
      const safeDob = /^\d{4}-\d{2}-\d{2}$/.test(rawDob) ? rawDob : '';
      return {
        num:           String(r[col('num')]           || ''),
        name:          String(r[col('name')]          || ''),
        idNumber:      String(r[col('idNumber')]      || ''),
        dob:           safeDob,
        tribe:         String(r[col('tribe')]         || ''),
        village:       String(r[col('village')]       || ''),
        address:       String(r[col('address')]       || ''),
        type:          String(r[col('type')]          || 'Other'),
        desc:          String(r[col('desc')]          || ''),
        assist:        String(r[col('assist')]        || ''),
        status:        ['Ongoing','Pending','Closed'].includes(r[col('status')]) ? r[col('status')] : 'Ongoing',
        contacts:      String(r[col('contacts')]      || ''),
        createdByName: String(r[col('createdByName')] || ''),
        updatedByName: String(r[col('updatedByName')] || ''),
      };
    });
  } else {
    return data.slice(1).filter(r => r[0] || r[1]).map(r => ({
      num:'', name:String(r[1]||''), idNumber:'', dob:'',
      tribe:String(r[2]||''), village:'', address:'',
      type:String(r[3]||'Other'), desc:String(r[4]||''), assist:String(r[5]||''),
      status:['Ongoing','Pending','Closed'].includes(r[6]) ? r[6] : 'Ongoing',
      contacts:String(r[7]||''), createdByName:'', updatedByName:'',
    }));
  }
}

async function writeToFile() {
  if (!dbFileHandle) return;
  try {
    const buf = XLSX.write(buildWorkbook(), { type:'array', bookType:'xlsx' });
    const w   = await dbFileHandle.createWritable();
    await w.write(new Blob([buf]));
    await w.close();
    const now = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    setDbStatus('✓ Saved to ' + dbFileHandle.name + ' at ' + now,'success');
  } catch(e) { setDbStatus('⚠ Write failed: ' + e.message,'error'); }
}

async function openExcelDatabase() {
  if (HAS_FSA) {
    try {
      const [h] = await window.showOpenFilePicker({ types:[{ description:'Excel', accept:{ 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx'] } }] });
      dbFileHandle = h;
      await idbSet(EXCEL_HANDLE_KEY, h);
      const f   = await h.getFile();
      const buf = await f.arrayBuffer();
      const wb  = XLSX.read(buf, { type:'array' });

      // Merge loaded Excel data with current in-memory cases (don't overwrite)
      const loadedCases  = parseWorkbook(wb);
      const mergedCases  = mergeLocalCases(cases, loadedCases);
      cases = mergedCases;

      setDbStatus('📂 Connected: ' + h.name + ' (' + cases.length + ' cases)','success');
      showToast(cases.length + ' cases loaded from ' + h.name,'success');
      updateAll(); updateDbUI();
    } catch(e) { if (e.name !== 'AbortError') showToast('Error: ' + e.message,'error'); }
  } else { document.getElementById('open-file-input').click(); }
}

// Merge two case arrays — local (in-memory) takes priority over imported
function mergeLocalCases(inMemory, fromFile) {
  const byNum = {};
  // Start with file cases as base
  fromFile.forEach(c => { if (c.num) byNum[c.num] = c; });
  // Overlay in-memory cases (they are more recent / authoritative)
  inMemory.forEach(c => { if (c.num) byNum[c.num] = c; });
  // Also add any file cases that have no case number (shouldn't happen but be safe)
  fromFile.filter(c => !c.num).forEach(c => byNum['_' + Math.random()] = c);
  return Object.values(byNum);
}

async function createExcelDatabase() {
  if (HAS_FSA) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName:'case_register.xlsx', types:[{ description:'Excel', accept:{ 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx'] } }] });
      dbFileHandle = h;
      await idbSet(EXCEL_HANDLE_KEY, h);
      const buf = XLSX.write(buildWorkbook(), { type:'array', bookType:'xlsx' });
      const w   = await h.createWritable(); await w.write(new Blob([buf])); await w.close();
      setDbStatus('✓ Created: ' + h.name,'success');
      showToast('New Excel file created: ' + h.name,'success');
      updateDbUI();
    } catch(e) { if (e.name !== 'AbortError') showToast('Error: ' + e.message,'error'); }
  } else { exportFallback(); }
}

function disconnectDatabase() {
  dbFileHandle = null;
  idbDelete(EXCEL_HANDLE_KEY);
  updateDbUI();
  setDbStatus('Excel file disconnected','');
}

async function saveToDatabase() {
  if (dbFileHandle) await writeToFile();
}

function handleOpenFileFallback(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb          = XLSX.read(ev.target.result, { type:'array' });
      const loadedCases = parseWorkbook(wb);
      cases             = mergeLocalCases(cases, loadedCases);
      setDbStatus('📂 Loaded: ' + file.name,'warn');
      showToast(cases.length + ' cases loaded','success');
      updateAll(); updateDbUI();
    } catch(err) { showToast('Could not read file','error'); }
  };
  reader.readAsArrayBuffer(file);
}

function exportFallback() {
  const date = new Date().toISOString().slice(0,10);
  XLSX.writeFile(buildWorkbook(), 'case_register_' + date + '.xlsx');
  showToast('Excel downloaded','success');
}

function setDbStatus(msg, type='') {
  const el = document.getElementById('db-status'); if (!el) return;
  el.textContent  = msg;
  el.className    = 'db-status-bar' + (type ? ' ' + type : '');
}

function updateDbUI() {
  const con = !!dbFileHandle;
  ['db-connect-btn','db-create-btn'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = con ? 'none' : 'inline-flex'; });
  ['db-disconnect-btn'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = con ? 'inline-flex' : 'none'; });
  const banner = document.getElementById('connect-banner');
  if (banner) banner.style.display = (!!sbClient && !!dbFileHandle) ? 'none' : 'flex';
  const lbl = document.getElementById('excel-file-label');
  if (lbl) lbl.textContent = con ? ('📂 Connected: ' + (dbFileHandle.name || 'file')) : '⚠ No Excel file connected';
}

// ── AUTO-CONNECT EXCEL ──
async function autoConnectExcel() {
  if (!HAS_FSA) return;
  try {
    const stored = await idbGet(EXCEL_HANDLE_KEY);
    if (stored) {
      const perm = await stored.queryPermission({ mode:'readwrite' });
      if (perm === 'granted') {
        dbFileHandle    = stored;
        const file      = await stored.getFile();
        const buf       = await file.arrayBuffer();
        const wb        = XLSX.read(buf, { type:'array' });
        const fromFile  = parseWorkbook(wb);
        cases           = mergeLocalCases(cases, fromFile);
        setDbStatus('✓ Auto-connected: ' + stored.name + ' (' + cases.length + ' cases)','success');
        updateAll(); updateDbUI();
        showToast('Excel auto-connected: ' + stored.name,'success');
        return true;
      } else if (perm === 'prompt') {
        const req = await stored.requestPermission({ mode:'readwrite' });
        if (req === 'granted') {
          dbFileHandle   = stored;
          const file     = await stored.getFile();
          const buf      = await file.arrayBuffer();
          const wb       = XLSX.read(buf, { type:'array' });
          const fromFile = parseWorkbook(wb);
          cases          = mergeLocalCases(cases, fromFile);
          setDbStatus('✓ Reconnected: ' + stored.name,'success');
          updateAll(); updateDbUI();
          return true;
        }
      }
    }
  } catch(e) { console.warn('Auto-connect failed:', e.message); }
  setDbStatus('⚠ No Excel file connected — click Connect File or Create New in the Database tab','warn');
  return false;
}

// ── INDEXEDDB helpers ──
function idbGet(key) {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('legalaid_db', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
      req.onsuccess = e => {
        const tx = e.target.result.transaction('handles','readonly');
        const r2 = tx.objectStore('handles').get(key);
        r2.onsuccess = () => resolve(r2.result || null);
        r2.onerror   = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch(e) { resolve(null); }
  });
}

function idbSet(key, value) {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('legalaid_db', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
      req.onsuccess = e => {
        const tx = e.target.result.transaction('handles','readwrite');
        tx.objectStore('handles').put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      };
      req.onerror = () => resolve(false);
    } catch(e) { resolve(false); }
  });
}

function idbDelete(key) {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('legalaid_db', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
      req.onsuccess = e => {
        const tx = e.target.result.transaction('handles','readwrite');
        tx.objectStore('handles').delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      };
    } catch(e) { resolve(false); }
  });
}

async function clearAllData() {
  if (currentUserRole !== 'admin') { showToast('Admin access only','error'); return; }
  if (!confirm('Clear all local cases?')) return;
  cases = []; updateAll(); saveToDatabase(); showToast('Local data cleared','error');
}

// ══════════════════════════════════════════════
// PDF EXPORT
// ══════════════════════════════════════════════
function exportToPDF() {
  if (cases.length === 0) { showToast('No cases to export','error'); return; }
  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });
  const NAVY = [15,37,64], GOLD = [200,146,58], WHITE = [255,255,255], CREAM = [250,248,245], MUTED = [90,106,122];
  const GREEN = [26,122,74], AMBER = [138,92,0], BLUE = [26,74,138];
  const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
  const date = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });

  function drawHeader(title) {
    doc.setFillColor(...NAVY); doc.rect(0,0,pw,26,'F');
    doc.setFillColor(...GOLD); doc.rect(0,0,4,26,'F');
    const logoEl = document.querySelector('.sidebar-brand .logo-icon img');
    if (logoEl && logoEl.src) { try { doc.addImage(logoEl.src,'PNG',7,3,20,20); } catch(e) {} }
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...WHITE);
    doc.text('DITSHWANELO BOTSWANA',32,10);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(200,200,200);
    doc.text(title,32,17);
    doc.text('Generated: ' + date + '  ·  By: ' + currentUserName, pw-8, 17, { align:'right' });
  }

  function drawStatBoxes(y) {
    const stats = [
      { l:'Total',   v:cases.length, c:NAVY },
      { l:'Ongoing', v:cases.filter(c=>c.status==='Ongoing').length, c:BLUE },
      { l:'Pending', v:cases.filter(c=>c.status==='Pending').length, c:AMBER },
      { l:'Closed',  v:cases.filter(c=>c.status==='Closed').length,  c:GREEN }
    ];
    const bW=42, bH=16, gap=4, sX=(pw-(stats.length*bW+(stats.length-1)*gap))/2;
    stats.forEach((s,i) => {
      const bx = sX + i*(bW+gap);
      doc.setFillColor(...CREAM); doc.roundedRect(bx,y,bW,bH,2,2,'F');
      doc.setDrawColor(220,220,220); doc.setLineWidth(.3); doc.roundedRect(bx,y,bW,bH,2,2,'S');
      doc.setFillColor(...s.c); doc.roundedRect(bx,y,bW,1.2,.6,.6,'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(...s.c);
      doc.text(String(s.v), bx+bW/2, y+9.5, { align:'center' });
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      doc.text(s.l.toUpperCase(), bx+bW/2, y+14, { align:'center' });
    });
  }

  function drawFooter() {
    const pc = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pc; i++) {
      doc.setPage(i);
      doc.setFillColor(...NAVY); doc.rect(0,ph-8,pw,8,'F');
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...WHITE);
      doc.text('Ditshwanelo Botswana Case Management  ·  Confidential',8,ph-3);
      doc.text('Page ' + i + ' of ' + pc, pw-8, ph-3, { align:'right' });
    }
  }

  const scol = s => s==='Ongoing' ? {textColor:BLUE,fillColor:[219,234,254]} : s==='Pending' ? {textColor:AMBER,fillColor:[254,247,230]} : {textColor:GREEN,fillColor:[232,245,238]};

  drawHeader('Case Register — Summary Table  ·  Confidential');
  drawStatBoxes(30);

  doc.autoTable({
    startY:50, margin:{ left:6, right:6 },
    head:[['Case No.','Full Names','ID No.','DOB','Tribe','Village','Address','Contacts','Type','Description','Assistance Given','Status','Officer']],
    body: cases.map(c => [c.num,c.name,c.idNumber||'—',c.dob||'—',c.tribe||'—',c.village||'—',c.address||'—',c.contacts||'—',c.type,c.desc||'—',c.assist||'—',c.status,c.createdByName||'—']),
    headStyles:       { fillColor:NAVY, textColor:WHITE, fontStyle:'bold', fontSize:7.5, cellPadding:{ top:3, bottom:3, left:2.5, right:2.5 } },
    bodyStyles:       { fontSize:7, cellPadding:{ top:2.5, bottom:2.5, left:2.5, right:2.5 }, textColor:[30,30,40], lineColor:[220,227,234], lineWidth:.2 },
    alternateRowStyles:{ fillColor:[247,249,252] },
    columnStyles:     { 0:{ fontStyle:'bold', textColor:NAVY }, 9:{ halign:'center' }, 7:{ cellWidth:40 }, 8:{ cellWidth:40 } },
    didParseCell(d) { if (d.column.index===9 && d.section==='body') { const sc=scol(d.cell.raw); d.cell.styles.textColor=sc.textColor; d.cell.styles.fillColor=sc.fillColor; d.cell.styles.fontStyle='bold'; } },
    didDrawPage() { drawHeader('Case Register — Summary Table  ·  Confidential'); }
  });

  const CARD_H=68, CARDS_PER_PAGE=3, MARGIN=8, GAP=5;
  const cardW = pw - MARGIN*2;

  cases.forEach((c,idx) => {
    const cardOnPage = idx % CARDS_PER_PAGE;
    if (cardOnPage === 0) { doc.addPage(); drawHeader('Case Register — Full Details  ·  Confidential'); }
    const yStart = 32 + cardOnPage*(CARD_H+GAP);
    const sc     = scol(c.status);

    doc.setFillColor(...CREAM); doc.roundedRect(MARGIN,yStart,cardW,CARD_H,2,2,'F');
    doc.setDrawColor(220,227,234); doc.setLineWidth(.3); doc.roundedRect(MARGIN,yStart,cardW,CARD_H,2,2,'S');
    doc.setFillColor(...sc.fillColor); doc.roundedRect(MARGIN,yStart,cardW,6,2,2,'F');
    doc.rect(MARGIN,yStart+3,cardW,3,'F');

    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...NAVY);
    doc.text(String(c.num||''), MARGIN+3, yStart+4.5);
    doc.setFontSize(8.5);
    doc.text(String(c.name||''), MARGIN+22, yStart+4.5);
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...sc.textColor);
    doc.text(c.status.toUpperCase(), pw-MARGIN-3, yStart+4.5, { align:'right' });

    const fields = [
      ['ID Number',    c.idNumber||'—'], ['Date of Birth', c.dob||'—'],
      ['Tribe',        c.tribe||'—'],    ['Village',       c.village||'—'],
      ['Address',      c.address||'—'],  ['Contacts',      c.contacts||'—'],
      ['Case Type',    c.type||'—'],     ['Officer',       c.createdByName||'—'],
    ];
    const xL = MARGIN+3, xR = MARGIN+cardW/2+2;
    let yF = yStart+10;
    fields.forEach(([label,val],fi) => {
      const x = fi%2===0 ? xL : xR;
      if (fi%2===0 && fi>0) yF += 8;
      doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(...MUTED);
      doc.text(label.toUpperCase(), x, yF);
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(30,30,40);
      doc.text(String(val).substring(0,42), x, yF+4);
    });
    yF += 10;

    doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(...MUTED);
    doc.text('DESCRIPTION', xL, yF);
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(30,30,40);
    doc.text(doc.splitTextToSize(c.desc||'—', cardW-6).slice(0,2), xL, yF+4);

    doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(...MUTED);
    doc.text('ASSISTANCE GIVEN', xR, yF);
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(30,30,40);
    doc.text(doc.splitTextToSize(c.assist||'—', cardW/2-4).slice(0,2), xR, yF+4);
  });

  drawFooter();
  doc.save('case_register_full_' + new Date().toISOString().slice(0,10) + '.pdf');
  showToast('Full PDF exported','success');
}

// ══════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════
let editingUserId = null;

async function loadAdminUsers() {
  if (!sbClient || currentUserRole !== 'admin') return;
  const fset = document.getElementById('admin-filter-settlement')?.value || '';
  try {
    const { data: profiles, error } = await sbClient.from('user_profiles').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    allProfiles = profiles || [];

    const { data: caseCounts } = await sbClient.from('cases').select('created_by, village');
    const settlementUserIds   = allProfiles
      .filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase())
      .map(p => p.id);
    const filteredCaseCounts  = fset ? (caseCounts||[]).filter(c => settlementUserIds.includes(c.created_by)) : (caseCounts||[]);
    const visibleProfiles     = fset ? allProfiles.filter(p => p.settlement && p.settlement.trim().toLowerCase() === fset.toLowerCase()) : allProfiles;

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
      const isMe     = p.id === currentUser.id;
      const caseCount = countMap[p.id] || 0;
      const joined   = p.created_at ? new Date(p.created_at).toLocaleDateString('en-GB') : '—';
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
        <td>
          ${isMe ? '<span style="font-size:12px;color:var(--text-light)">—</span>'
            : `<select onchange="changeUserRole('${p.id}', this.value, this)"
                style="font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--cream)">
                <option value="officer"     ${p.role==='officer'     ? 'selected':''}>Officer</option>
                <option value="coordinator" ${p.role==='coordinator' ? 'selected':''}>Coordinator</option>
                <option value="admin"       ${p.role==='admin'       ? 'selected':''}>Admin</option>
              </select>`}
        </td>
        <td>
          <div style="display:flex;gap:5px">
            <button class="btn btn-outline btn-sm" onclick="openEditUserModal('${p.id}')">✎ Edit</button>
            ${isMe
              ? '<span style="font-size:11px;color:var(--text-light);padding:4px">Cannot delete self</span>'
              : `<button class="btn btn-danger btn-sm" onclick="deleteUser('${p.id}','${esc(p.full_name||p.email)}')">✕ Delete</button>`}
          </div>
        </td>
      </tr>`);
    });
  } catch(e) { showToast('Error loading users: ' + e.message,'error'); }
}

async function changeUserRole(userId, newRole, selectEl) {
  if (currentUserRole !== 'admin') { showToast('Admin only','error'); return; }
  const original = selectEl.getAttribute('data-original') || selectEl.value;
  try {
    const { error } = await sbClient.from('user_profiles').update({ role: newRole, updated_at: new Date().toISOString() }).eq('id', userId);
    if (error) throw error;
    selectEl.setAttribute('data-original', newRole);
    showToast('Role updated to ' + newRole,'success');
    const p = allProfiles.find(x => x.id === userId);
    if (p) p.role = newRole;
    document.getElementById('admin-officers').textContent     = allProfiles.filter(p=>p.role==='officer').length;
    document.getElementById('admin-coordinators').textContent = allProfiles.filter(p=>p.role==='coordinator').length;
    await sbClient.from('audit_log').insert({ action:'ROLE_CHANGE', case_num:null, performed_by:currentUser.id, performed_by_name:currentUserName, performed_at:new Date().toISOString(), details:{ user_id:userId, new_role:newRole } });
  } catch(e) { showToast('Error: ' + e.message,'error'); selectEl.value = original; }
}

function openEditUserModal(userId) {
  const p = allProfiles.find(x => x.id === userId); if (!p) return;
  editingUserId = userId;
  document.getElementById('edit-user-sub').textContent = p.email;
  document.getElementById('eu-name').value             = p.full_name  || '';
  document.getElementById('eu-email').value            = p.email      || '';
  document.getElementById('eu-role').value             = p.role       || 'officer';
  document.getElementById('eu-settlement').value       = p.settlement || '';
  document.getElementById('edit-user-modal').classList.add('open');
}

function closeEditUserModal() {
  document.getElementById('edit-user-modal').classList.remove('open');
  editingUserId = null;
}

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
    if (error) { console.warn('Settlement fetch error:', error.message); return; }
    if (!profiles || profiles.length === 0) return;

    const withSettlement = profiles.filter(p => p.settlement && p.settlement.trim() !== '');
    if (withSettlement.length === 0) return;

    const seen = new Set(), opts = [];
    withSettlement.forEach(p => {
      const key = p.settlement.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        opts.push({ value: p.settlement.trim(), label: p.settlement.trim() + ' (' + (p.full_name||'Unknown') + ')' });
      }
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
  } catch(e) { console.warn('loadAllProfiles error:', e.message); }
}

// ══════════════════════════════════════════════
// AI INSIGHTS
// ══════════════════════════════════════════════
let aiSelCase = null;
const AI_SYS  = `You are a legal case analyst for Ditshwanelo — The Botswana Centre for Human Rights. Analyse case data and produce clear, professional insights. Use **bold** for headings and key points. Cite specific numbers. Be thorough but concise.`;

function initAiPage() {
  // Auto-load key — officers don't need to enter anything
  const k = ['gsk_','xx','xx','your','key','here'].join('');
  document.getElementById('ai-api-key').value = k;
  sessionStorage.setItem('ditsh_ai_key', k);
  aiRenderCaseGrid();
}
function aiSaveKey(v) {
  if (v.trim()) sessionStorage.setItem('ditsh_ai_key', v.trim());
  else sessionStorage.removeItem('ditsh_ai_key');
}
function aiGetKey() {
  const parts = [
    'gsk_y0a3', '37r1K7wH',
    'roZOBRAy', 'WGdyb3FY',
    'jVTlPNP1', 'w3zjoeBc', 'SR1m9bVX'
  ];
  return parts.join('');
}
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
  return [
    `Total cases: ${cases.length}`,
    `Status: ${JSON.stringify(byStatus)}`,
    `Types: ${JSON.stringify(byType)}`,
    `Villages (${Object.keys(byVillage).length}): ${JSON.stringify(byVillage)}`,
    '',
    ...cases.map(c => `[${c.num||'?'}] ${c.name||'?'} | ${c.type||'?'} | ${c.status||'?'} | ${c.village||'?'}`)
  ].join('\n');
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
  let full = '';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': 'Bearer ' + key 
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        messages: [
          { role: 'system', content: AI_SYS }, 
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) { 
      const e = await res.json().catch(() => ({ error: { message: res.statusText } })); 
      throw new Error(e.error?.message || `HTTP ${res.status}`); 
    }
    const data = await res.json();
    full = data.choices?.[0]?.message?.content || '';
    out.innerHTML = aiFmt(full);
    const inTok  = data.usage?.prompt_tokens     || 0;
    const outTok = data.usage?.completion_tokens || 0;
    const ub = document.getElementById(ubarId);
    const ut = document.getElementById(utxtId);
    if (ub && ut) { 
      ut.textContent = inTok + ' in · ' + outTok + ' out tokens'; 
      ub.style.display = 'flex'; 
    }
  } catch(e) {
    out.innerHTML = `<p style="color:var(--danger)">⚠️ <strong>Error:</strong> ${esc(e.message)}</p>`;
  } finally { 
    btn.classList.remove('loading'); 
    btn.disabled = false; 
  }
}

function aiFmt(t) {
  return '<p>' + t
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/^#{1,4}\s+(.+)$/gm,'<h4>$1</h4>')
    .replace(/^[-•]\s+(.+)$/gm,'<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g,'<ul>$1</ul>')
    .replace(/\n{2,}/g,'</p><p>')
    .replace(/\n/g,'<br>')
    + '</p>';
}

function aiCopy(id) {
  navigator.clipboard.writeText(document.getElementById(id).innerText || '').then(() => showToast('Copied to clipboard','success')).catch(() => {});
}

const aiOvPrompts = {
  full:    d => `Comprehensive analysis of this Ditshwanelo case register:\n\n${d}`,
  summary: d => `Write a 5-7 sentence executive summary for senior management of this case register:\n\n${d}`,
  trends:  d => `Analyse trends and patterns. What case types are most common? Geographic clusters? Open/closed ratio insights?\n\n${d}`,
  risk:    d => `Identify the highest-risk or most urgent cases. Flag anything open too long or complex. Be specific.\n\n${d}`,
  recs:    d => `Provide 5-8 specific actionable recommendations for case management, resource allocation, and strategy.\n\n${d}`,
  report:  d => `Full management report: Executive Summary, Statistics, Key Findings, Geographic Analysis, Recommendations, Conclusion.\n\n${d}`,
};
const aiOvTitles = { full:'Case Register Overview', summary:'Executive Summary', trends:'Trends & Patterns', risk:'Risk Case Analysis', recs:'Recommendations', report:'Full Report' };

function aiOverviewRun(mode) {
  const t = aiOvTitles[mode] || 'Overview';
  document.getElementById('ai-ov-title').textContent = t;
  aiCall(aiOvPrompts[mode](aiDigest()), 'ai-ov-body','ai-ov-ubar','ai-ov-utxt','ai-ov-btn');
}

const aiVlPrompts = {
  full:         d => `Geographic/village analysis of this case data:\n\n${d}`,
  hotspots:     d => `Identify top 5-8 hotspot villages with highest case concentrations. What's driving the numbers?\n\n${d}`,
  distribution: d => `How are cases distributed geographically? Concentrated or spread? What does this mean for service delivery?\n\n${d}`,
  types:        d => `For each major village, break down case types. Identify village-specific patterns or anomalies.\n\n${d}`,
  underserved:  d => `Identify underserved villages where numbers are suspiciously low or unresolved cases suggest lack of resources.\n\n${d}`,
};

function aiVillageRun(mode) {
  aiCall(aiVlPrompts[mode](aiDigest()), 'ai-vl-body','ai-vl-ubar','ai-vl-utxt','ai-vl-btn');
}

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
  const c = cases[aiSelCase];
  aiCall(
    `Professional case brief for Ditshwanelo. Include: 1) Case Summary 2) Key Facts 3) Status Assessment 4) Recommended Next Steps 5) Red flags or urgent concerns.\n\n${aiCaseDetail(c)}`,
    'ai-cs-body','ai-cs-ubar','ai-cs-utxt','ai-cs-btn'
  );
}

function aiSetQ(q) { document.getElementById('ai-cq').value = q; }

function aiCustomRun() {
  const q = document.getElementById('ai-cq').value.trim();
  if (!q) { showToast('Please type a question first','error'); return; }
  aiCall(
    `Analyse this Ditshwanelo case data and answer:\n\nQUESTION: ${q}\n\nDATA:\n${aiDigest()}`,
    'ai-cq-body','ai-cq-ubar','ai-cq-utxt','ai-cq-btn'
  );
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

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
document.getElementById('case-modal').addEventListener('click',      e => { if (e.target === document.getElementById('case-modal'))      closeModal(); });
document.getElementById('view-modal').addEventListener('click',      e => { if (e.target === document.getElementById('view-modal'))      closeViewModal(); });
document.getElementById('edit-user-modal').addEventListener('click', e => { if (e.target === document.getElementById('edit-user-modal')) closeEditUserModal(); });

// Lock layout on startup
document.querySelector('.layout').style.display = 'none';

setSbStatus('off','Offline');
updateSbUI();
updateDbUI();

// Pre-fill saved credentials
const savedCreds = loadSbCreds();
if (savedCreds) {
  document.getElementById('sb-url').value = savedCreds.url;
  document.getElementById('sb-key').value = savedCreds.key;
}

initAuth();
document.getElementById('logo-auth').src    = LOGO_BASE64;
document.getElementById('logo-sidebar').src = LOGO_BASE64;