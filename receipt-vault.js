/* ══════════════════════════════════════
   RECEIPT VAULT — IndexedDB storage
   No file linking. Auto-saves silently.
══════════════════════════════════════ */

// ── STATE ──
var rvReceipts   = [];
var rvCompanies  = [];
var rvCategories = [];
var rvBranches   = [];
var rvEditId     = null;
var rvNextId     = 1;

var RV_PALETTE = [
  {bg:'#fef3c7',fg:'#92400e'},{bg:'#d1fae5',fg:'#065f46'},
  {bg:'#dbeafe',fg:'#1e40af'},{bg:'#ede9fe',fg:'#5b21b6'},
  {bg:'#fce7f3',fg:'#9d174d'},{bg:'#e0f2fe',fg:'#0369a1'},
  {bg:'#fee2e2',fg:'#991b1b'},{bg:'#fff7ed',fg:'#c2410c'},
  {bg:'#f0fdf4',fg:'#166534'},{bg:'#fdf4ff',fg:'#7e22ce'}
];
var RV_BAR_COLORS = [
  '#c8923a','#5b8dee','#34c98a','#e05c5c','#a78bfa',
  '#f97316','#14b8a6','#ec4899','#84cc16','#6b7280'
];

// ══════════════════════════════════════
// INDEXED DB
// ══════════════════════════════════════
var RV_DB_NAME    = 'ditshwanelo_receipts_db';
var RV_DB_VERSION = 1;
var _rvDb         = null;

function rvOpenDB() {
  return new Promise(function(resolve, reject) {
    if (_rvDb) { resolve(_rvDb); return; }
    var req = indexedDB.open(RV_DB_NAME, RV_DB_VERSION);

    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('receipts'))
        db.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('companies'))
        db.createObjectStore('companies', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('categories'))
        db.createObjectStore('categories', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('branches'))
        db.createObjectStore('branches', { keyPath: 'name' });
    };

    req.onsuccess = function(e) {
      _rvDb = e.target.result;
      resolve(_rvDb);
    };

    req.onerror = function() {
      reject(req.error);
    };
  });
}

// Generic get all from a store
function rvGetAll(storeName) {
  return rvOpenDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx  = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).getAll();
      req.onsuccess = function() { resolve(req.result || []); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// Generic put (add or update)
function rvPut(storeName, record) {
  return rvOpenDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx  = db.transaction(storeName, 'readwrite');
      var req = tx.objectStore(storeName).put(record);
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// Generic delete by key
function rvDelete(storeName, key) {
  return rvOpenDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx  = db.transaction(storeName, 'readwrite');
      var req = tx.objectStore(storeName).delete(key);
      req.onsuccess = function() { resolve(); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// Clear entire store
function rvClearStore(storeName) {
  return rvOpenDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx  = db.transaction(storeName, 'readwrite');
      var req = tx.objectStore(storeName).clear();
      req.onsuccess = function() { resolve(); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// ── SAVE STATUS ──
function rvSetDotState(state, txt) {
  var dot = document.getElementById('rv-dot');
  var lbl = document.getElementById('rv-save-txt');
  if (dot) dot.className = 'rv-dot ' + state;
  if (lbl) lbl.textContent = txt;
}

function rvFlashSaved() {
  rvSetDotState('saving', 'Saving…');
  setTimeout(function() {
    rvSetDotState('saved', 'Auto-saved ✓');
    setTimeout(function() {
      rvSetDotState('linked', 'IndexedDB · Auto-save on');
    }, 1500);
  }, 400);
}

// ══════════════════════════════════════
// INIT — called by showPage('receipts')
// ══════════════════════════════════════
async function rvInit() {
  rvSetDotState('saving', 'Loading…');

  // Request persistent storage so browser never auto-clears
  if (navigator.storage && navigator.storage.persist) {
    await navigator.storage.persist();
  }

  try {
    rvReceipts   = await rvGetAll('receipts');
    rvCompanies  = await rvGetAll('companies');
    rvCategories = await rvGetAll('categories');
    rvBranches   = await rvGetAll('branches');

    // Sync rvNextId to avoid ID collisions
    if (rvReceipts.length > 0) {
      rvNextId = Math.max.apply(null, rvReceipts.map(function(r) { return r.id || 0; })) + 1;
    }

    rvPopulateDropdowns();
    rvRenderManage();
    rvRenderTable();
    rvSetDotState('linked', 'IndexedDB · Auto-save on');
  } catch(e) {
    rvSetDotState('error', 'Storage error — ' + e.message);
    rvToast('IndexedDB error: ' + e.message, 'err');
  }
}

// ══════════════════════════════════════
// TABS
// ══════════════════════════════════════
function rvSwitchTab(name, btn) {
  document.querySelectorAll('.rv-panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.rv-tab').forEach(function(b)   { b.classList.remove('active'); });
  document.getElementById('rv-panel-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'summary') rvRenderSummary();
}

// ══════════════════════════════════════
// COMPANIES
// ══════════════════════════════════════
async function rvAddCompany() {
  var val = document.getElementById('rv-new-company').value.trim();
  if (!val) return rvToast('Enter a company name.', 'err');
  for (var i = 0; i < rvCompanies.length; i++) {
    if (rvCompanies[i].name.toLowerCase() === val.toLowerCase())
      return rvToast('"' + val + '" already exists.', 'err');
  }
  var item = { name: val, colorBg: RV_PALETTE[rvCompanies.length % RV_PALETTE.length].bg, colorFg: RV_PALETTE[rvCompanies.length % RV_PALETTE.length].fg };
  try {
    await rvPut('companies', item);
    rvCompanies.push(item);
    document.getElementById('rv-new-company').value = '';
    rvRenderManage();
    rvPopulateDropdowns();
    rvFlashSaved();
    rvToast('"' + val + '" added.');
  } catch(e) { rvToast('Save failed: ' + e.message, 'err'); }
}

async function rvDelCompany(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try {
    await rvDelete('companies', name);
    rvCompanies = rvCompanies.filter(function(c) { return c.name !== name; });
    rvRenderManage();
    rvPopulateDropdowns();
    rvFlashSaved();
    rvToast('"' + name + '" removed.');
  } catch(e) { rvToast('Delete failed: ' + e.message, 'err'); }
}

// ══════════════════════════════════════
// CATEGORIES
// ══════════════════════════════════════
async function rvAddCategory() {
  var val = document.getElementById('rv-new-category').value.trim();
  if (!val) return rvToast('Enter a category name.', 'err');
  for (var i = 0; i < rvCategories.length; i++) {
    if (rvCategories[i].name.toLowerCase() === val.toLowerCase())
      return rvToast('"' + val + '" already exists.', 'err');
  }
  var item = { name: val, colorBg: RV_PALETTE[rvCategories.length % RV_PALETTE.length].bg, colorFg: RV_PALETTE[rvCategories.length % RV_PALETTE.length].fg };
  try {
    await rvPut('categories', item);
    rvCategories.push(item);
    document.getElementById('rv-new-category').value = '';
    rvRenderManage();
    rvPopulateDropdowns();
    rvFlashSaved();
    rvToast('"' + val + '" added.');
  } catch(e) { rvToast('Save failed: ' + e.message, 'err'); }
}

async function rvDelCategory(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try {
    await rvDelete('categories', name);
    rvCategories = rvCategories.filter(function(c) { return c.name !== name; });
    rvRenderManage();
    rvPopulateDropdowns();
    rvFlashSaved();
    rvToast('"' + name + '" removed.');
  } catch(e) { rvToast('Delete failed: ' + e.message, 'err'); }
}

// ══════════════════════════════════════
// BRANCHES
// ══════════════════════════════════════
async function rvAddBranch() {
  var val = document.getElementById('rv-new-branch').value.trim();
  if (!val) return rvToast('Enter a branch name.', 'err');
  for (var i = 0; i < rvBranches.length; i++) {
    if (rvBranches[i].name.toLowerCase() === val.toLowerCase())
      return rvToast('"' + val + '" already exists.', 'err');
  }
  var item = { name: val };
  try {
    await rvPut('branches', item);
    rvBranches.push(item);
    document.getElementById('rv-new-branch').value = '';
    rvRenderManage();
    rvPopulateDropdowns();
    rvFlashSaved();
    rvToast('"' + val + '" added.');
  } catch(e) { rvToast('Save failed: ' + e.message, 'err'); }
}

async function rvDelBranch(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try {
    await rvDelete('branches', name);
    rvBranches = rvBranches.filter(function(b) { return b.name !== name; });
    rvRenderManage();
    rvPopulateDropdowns();
    rvFlashSaved();
    rvToast('"' + name + '" removed.');
  } catch(e) { rvToast('Delete failed: ' + e.message, 'err'); }
}

// ══════════════════════════════════════
// RECEIPTS — ADD / EDIT / DELETE
// ══════════════════════════════════════
async function rvSubmitForm() {
  var date    = document.getElementById('rv-f-date').value.trim();
  var amount  = parseFloat(document.getElementById('rv-f-amount').value);
  var from    = document.getElementById('rv-f-from').value;
  var purpose = document.getElementById('rv-f-purpose').value;
  var branch  = document.getElementById('rv-f-branch').value;
  var notes   = document.getElementById('rv-f-notes').value.trim();

  if (!date || !from)               return rvToast('Date and Company are required.', 'err');
  if (!purpose)                     return rvToast('Please select a category.', 'err');
  if (!branch)                      return rvToast('Please select a branch.', 'err');
  if (isNaN(amount) || amount <= 0) return rvToast('Enter a valid positive amount.', 'err');

  try {
    if (rvEditId !== null) {
      var updated = { id: rvEditId, date: date, amount: amount, from: from, purpose: purpose, branch: branch, notes: notes };
      await rvPut('receipts', updated);
      rvReceipts = rvReceipts.map(function(r) { return r.id === rvEditId ? updated : r; });
      rvCancelEdit();
      rvToast('Receipt updated.');
    } else {
      var newItem = { date: date, amount: amount, from: from, purpose: purpose, branch: branch, notes: notes };
      var newId = await rvPut('receipts', newItem);
      newItem.id = newId;
      rvReceipts.push(newItem);
      rvClearForm();
      rvToast('Receipt added.');
    }
    rvFlashSaved();
    rvRenderTable();
  } catch(e) { rvToast('Save failed: ' + e.message, 'err'); }
}

async function rvDelReceipt(id) {
  if (!confirm('Delete this receipt?')) return;
  try {
    await rvDelete('receipts', id);
    rvReceipts = rvReceipts.filter(function(r) { return r.id !== id; });
    rvFlashSaved();
    rvRenderTable();
    rvToast('Receipt deleted.');
  } catch(e) { rvToast('Delete failed: ' + e.message, 'err'); }
}

function rvStartEdit(id) {
  var r = rvReceipts.find(function(x) { return x.id === id; });
  if (!r) return;
  rvEditId = id;
  document.getElementById('rv-f-date').value    = r.date;
  document.getElementById('rv-f-amount').value  = r.amount;
  document.getElementById('rv-f-from').value    = r.from;
  document.getElementById('rv-f-purpose').value = r.purpose;
  document.getElementById('rv-f-branch').value  = r.branch || '';
  document.getElementById('rv-f-notes').value   = r.notes  || '';
  document.getElementById('rv-form-title').textContent   = '✏️ Edit Receipt';
  document.getElementById('rv-submit-btn').textContent   = 'Update Receipt';
  document.getElementById('rv-cancel-btn').style.display = 'inline-flex';
  var firstTab = document.querySelector('.rv-tab');
  if (firstTab) firstTab.click();
  var page = document.getElementById('page-receipts');
  if (page) page.scrollTop = 0;
}

function rvCancelEdit() {
  rvEditId = null;
  rvClearForm();
  document.getElementById('rv-form-title').textContent   = '➕ Add Receipt';
  document.getElementById('rv-submit-btn').textContent   = 'Add Receipt';
  document.getElementById('rv-cancel-btn').style.display = 'none';
}

function rvClearForm() {
  ['rv-f-date','rv-f-amount','rv-f-from','rv-f-purpose','rv-f-branch','rv-f-notes'].forEach(function(id) {
    document.getElementById(id).value = '';
  });
}

// ══════════════════════════════════════
// RENDER HELPERS
// ══════════════════════════════════════
function rvFmt(n) {
  return 'BWP ' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function rvEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function rvToast(msg, type) {
  if (typeof showToast === 'function') { showToast(msg); return; }
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;color:#fff;font-weight:600;font-size:13px;z-index:9999;background:' + (type === 'err' ? '#8a1a1a' : '#1a7a4a');
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 3000);
}

function rvBadgeForCat(name) {
  for (var i = 0; i < rvCategories.length; i++) {
    if (rvCategories[i].name === name) {
      var bg = rvCategories[i].colorBg || '#f3f4f6';
      var fg = rvCategories[i].colorFg || '#374151';
      return '<span class="badge" style="background:' + bg + ';color:' + fg + '">' + rvEsc(name) + '</span>';
    }
  }
  return '<span class="badge" style="background:var(--border-light);color:var(--text-muted)">' + rvEsc(name || '—') + '</span>';
}

function rvPopulateDropdowns() {
  // Company dropdowns
  ['rv-f-from','rv-fc-company'].forEach(function(id, i) {
    var sel = document.getElementById(id); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + (i === 0 ? '— Select company —' : 'All companies') + '</option>';
    rvCompanies.forEach(function(item) {
      var o = document.createElement('option');
      o.value = item.name; o.textContent = item.name;
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  });

  // Category dropdowns
  ['rv-f-purpose','rv-fc-purpose'].forEach(function(id, i) {
    var sel = document.getElementById(id); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + (i === 0 ? '— Select category —' : 'All categories') + '</option>';
    rvCategories.forEach(function(item) {
      var o = document.createElement('option');
      o.value = item.name; o.textContent = item.name;
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  });

  // Branch dropdowns
  ['rv-f-branch','rv-fc-branch','rv-sum-branch'].forEach(function(id, i) {
    var sel = document.getElementById(id); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + (i === 0 ? '— Select branch —' : 'All branches') + '</option>';
    rvBranches.forEach(function(item) {
      var o = document.createElement('option');
      o.value = item.name; o.textContent = item.name;
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  });
}

function rvRenderManage() {
  // Companies
  var cEl = document.getElementById('rv-company-list');
  if (cEl) {
    if (!rvCompanies.length) {
      cEl.innerHTML = '<div class="rv-list-empty">No companies yet.</div>';
    } else {
      cEl.innerHTML = rvCompanies.map(function(item) {
        var bg = item.colorBg || '#f3f4f6';
        var fg = item.colorFg || '#374151';
        return '<div class="rv-list-item">' +
          '<span class="badge" style="background:' + bg + ';color:' + fg + ';margin-right:4px">' + rvEsc(item.name) + '</span>' +
          '<span class="lname">' + rvEsc(item.name) + '</span>' +
          '<button class="rv-list-item-del" onclick="rvDelCompany(\'' + rvEsc(item.name) + '\')">✕</button></div>';
      }).join('');
    }
  }

  // Categories
  var kEl = document.getElementById('rv-category-list');
  if (kEl) {
    if (!rvCategories.length) {
      kEl.innerHTML = '<div class="rv-list-empty">No categories yet.</div>';
    } else {
      kEl.innerHTML = rvCategories.map(function(item) {
        var bg = item.colorBg || '#f3f4f6';
        var fg = item.colorFg || '#374151';
        return '<div class="rv-list-item">' +
          '<span class="badge" style="background:' + bg + ';color:' + fg + ';margin-right:4px">' + rvEsc(item.name) + '</span>' +
          '<span class="lname">' + rvEsc(item.name) + '</span>' +
          '<button class="rv-list-item-del" onclick="rvDelCategory(\'' + rvEsc(item.name) + '\')">✕</button></div>';
      }).join('');
    }
  }

  // Branches
  var bEl = document.getElementById('rv-branch-list');
  if (bEl) {
    if (!rvBranches.length) {
      bEl.innerHTML = '<div class="rv-list-empty">No branches yet.</div>';
    } else {
      bEl.innerHTML = rvBranches.map(function(item) {
        return '<div class="rv-list-item">' +
          '<span class="rv-branch-badge" style="margin-right:4px">📍 ' + rvEsc(item.name) + '</span>' +
          '<span class="lname">' + rvEsc(item.name) + '</span>' +
          '<button class="rv-list-item-del" onclick="rvDelBranch(\'' + rvEsc(item.name) + '\')">✕</button></div>';
      }).join('');
    }
  }
}

function rvFilteredReceipts() {
  var fc = document.getElementById('rv-fc-company') ? document.getElementById('rv-fc-company').value : '';
  var fp = document.getElementById('rv-fc-purpose') ? document.getElementById('rv-fc-purpose').value : '';
  var fb = document.getElementById('rv-fc-branch')  ? document.getElementById('rv-fc-branch').value  : '';
  return rvReceipts.filter(function(r) {
    return (!fc || r.from === fc) && (!fp || r.purpose === fp) && (!fb || r.branch === fb);
  });
}

function rvClearFilters() {
  document.getElementById('rv-fc-company').value = '';
  document.getElementById('rv-fc-purpose').value = '';
  document.getElementById('rv-fc-branch').value  = '';
  rvRenderTable();
}

function rvRenderTable() {
  var list  = rvFilteredReceipts();
  var tbody = document.getElementById('rv-tbody');
  var tfoot = document.getElementById('rv-tfoot');
  var empty = document.getElementById('rv-empty-msg');

  // Grand total always from ALL receipts (unfiltered)
  var grandTotal = rvReceipts.reduce(function(s, r) { return s + (r.amount || 0); }, 0);
  var hdr = document.getElementById('rv-header-total');
  if (hdr) hdr.textContent = rvFmt(grandTotal);

  var titleEl = document.getElementById('rv-table-title');
  var countEl = document.getElementById('rv-table-count');
  if (titleEl) titleEl.textContent = 'Receipts (' + list.length + ')';
  if (countEl) countEl.textContent = list.length + ' records';

  if (!list.length) {
    if (tbody) tbody.innerHTML = '';
    if (tfoot) tfoot.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }

  if (empty) empty.style.display = 'none';

  var filtered_total = list.reduce(function(s, r) { return s + (r.amount || 0); }, 0);

  if (tbody) {
    tbody.innerHTML = list.map(function(r) {
      return '<tr>' +
        '<td>' + rvEsc(r.date) + '</td>' +
        '<td class="rv-td-from">' + rvEsc(r.from) + '</td>' +
        '<td><span class="rv-branch-badge">📍 ' + rvEsc(r.branch || '—') + '</span></td>' +
        '<td>' + rvBadgeForCat(r.purpose) + '</td>' +
        '<td class="rv-td-notes">' + (r.notes ? rvEsc(r.notes) : '—') + '</td>' +
        '<td class="rv-td-amt">' + rvFmt(r.amount) + '</td>' +
        '<td><div class="actions">' +
          '<button class="icon-btn" onclick="rvStartEdit(' + r.id + ')" title="Edit">✏️</button>' +
          '<button class="icon-btn" onclick="rvDelReceipt(' + r.id + ')" title="Delete">🗑️</button>' +
        '</div></td></tr>';
    }).join('');
  }

  if (tfoot) {
    var fc  = document.getElementById('rv-fc-company') ? document.getElementById('rv-fc-company').value : '';
    var fp  = document.getElementById('rv-fc-purpose') ? document.getElementById('rv-fc-purpose').value : '';
    var fb  = document.getElementById('rv-fc-branch')  ? document.getElementById('rv-fc-branch').value  : '';
    var parts = [];
    if (fc) parts.push(fc);
    if (fp) parts.push(fp);
    if (fb) parts.push('Branch: ' + fb);
    var label = parts.length ? 'Total — ' + parts.join(' + ') : 'Grand Total';
    tfoot.innerHTML = '<tr><td colspan="5" style="font-weight:700">' + rvEsc(label) + '</td>' +
      '<td class="rv-td-amt" style="font-size:15px">' + rvFmt(filtered_total) + '</td><td></td></tr>';
  }
}

// ══════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════
function rvRenderSummary() {
  var body = document.getElementById('rv-summary-body');
  var sel  = document.getElementById('rv-sum-branch') ? document.getElementById('rv-sum-branch').value : '';
  var src  = sel ? rvReceipts.filter(function(r) { return r.branch === sel; }) : rvReceipts;

  if (!src.length) {
    body.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><p>No receipts' + (sel ? ' for branch "' + rvEsc(sel) + '"' : '') + ' to summarise.</p></div>';
    return;
  }

  var total = src.reduce(function(s, r) { return s + (r.amount || 0); }, 0);

  function group(key) {
    var m = {};
    src.forEach(function(r) {
      var k = r[key] || 'Unknown';
      m[k] = (m[k] || 0) + r.amount;
    });
    return Object.keys(m).map(function(k) { return [k, m[k]]; }).sort(function(a, b) { return b[1] - a[1]; });
  }

  function rows(entries, useBadge) {
    return entries.map(function(e, i) {
      var pct      = total ? (e[1] / total * 100) : 0;
      var nameHtml = useBadge
        ? '<div style="margin-bottom:5px">' + rvBadgeForCat(e[0]) + '</div>'
        : '<span class="rv-sum-name">' + rvEsc(e[0]) + '</span>';
      return '<div class="rv-sum-row">' +
        '<div class="rv-sum-left">' + nameHtml +
          '<div class="rv-bar-track"><div class="rv-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + RV_BAR_COLORS[i % RV_BAR_COLORS.length] + '"></div></div></div>' +
        '<div class="rv-sum-right"><span class="rv-s-amt">' + rvFmt(e[1]) + '</span><span class="rv-s-pct">' + pct.toFixed(1) + '%</span></div></div>';
    }).join('');
  }

  var branchSection = !sel
    ? '<div class="rv-sum-section"><div class="rv-sum-heading">By Branch</div>' + rows(group('branch'), false) + '</div>'
    : '';

  body.innerHTML =
    '<div class="rv-sum-section"><div class="rv-sum-heading">By Category</div>'  + rows(group('purpose'), true)  + '</div>' +
    '<div class="rv-sum-section"><div class="rv-sum-heading">By Company</div>'   + rows(group('from'),    false) + '</div>' +
    branchSection +
    '<div class="rv-grand-row"><span>Grand Total' + (sel ? ' — ' + rvEsc(sel) + ' Branch' : '') + '</span><span>' + rvFmt(total) + '</span></div>';
}

function rvExportPDF() { rvRenderSummary(); window.print(); }

// ══════════════════════════════════════
// EXCEL EXPORT (download only)
// ══════════════════════════════════════
function rvExportExcel() {
  if (typeof XLSX === 'undefined') { rvToast('SheetJS not loaded.', 'err'); return; }

  var wb = XLSX.utils.book_new();

  // Receipts sheet
  var rRows = rvReceipts.map(function(r) {
    return { Date: r.date, Amount: r.amount, From: r.from, Purpose: r.purpose, Branch: r.branch || '', Notes: r.notes || '' };
  });
  var wsR = XLSX.utils.json_to_sheet(
    rRows.length ? rRows : [{ Date:'', Amount:'', From:'', Purpose:'', Branch:'', Notes:'' }],
    { header: ['Date','Amount','From','Purpose','Branch','Notes'] }
  );
  wsR['!cols'] = [{ wch:14 },{ wch:12 },{ wch:24 },{ wch:18 },{ wch:18 },{ wch:32 }];
  XLSX.utils.book_append_sheet(wb, wsR, 'Receipts');

  // Companies sheet
  var cRows = rvCompanies.map(function(c) { return { Name: c.name, ColorBg: c.colorBg, ColorFg: c.colorFg }; });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    cRows.length ? cRows : [{ Name:'', ColorBg:'', ColorFg:'' }],
    { header: ['Name','ColorBg','ColorFg'] }
  ), 'Companies');

  // Categories sheet
  var kRows = rvCategories.map(function(c) { return { Name: c.name, ColorBg: c.colorBg, ColorFg: c.colorFg }; });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    kRows.length ? kRows : [{ Name:'', ColorBg:'', ColorFg:'' }],
    { header: ['Name','ColorBg','ColorFg'] }
  ), 'Categories');

  // Branches sheet
  var bRows = rvBranches.map(function(b) { return { Name: b.name }; });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    bRows.length ? bRows : [{ Name:'' }],
    { header: ['Name'] }
  ), 'Branches');

  var date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, 'receipt_vault_' + date + '.xlsx');
  rvToast('Excel exported ✓');
}

// ══════════════════════════════════════
// NOTE: rvInit() is NOT called here.
// It is called by showPage('receipts')
// in app.js so the DOM is always ready.
// ══════════════════════════════════════