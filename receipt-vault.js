
/* ── Logo injection ── */
if(typeof LOGO_BASE64 !== 'undefined'){
  document.getElementById('logo-auth').src    = LOGO_BASE64;
  document.getElementById('logo-sidebar').src = LOGO_BASE64;
}

/* ══════════════════════════════════════
   SIDEBAR TOGGLE
══════════════════════════════════════ */
function toggleSidebar(){
  var sb  = document.getElementById('sidebar');
  var ov  = document.getElementById('sidebar-overlay');
  var isOpen = sb.classList.toggle('open');
  ov.classList.toggle('show', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
  document.body.style.overflow = '';
}
document.querySelectorAll('.nav-item').forEach(function(item){
  item.addEventListener('click', function(){ if(window.innerWidth <= 768) closeSidebar(); });
});
window.addEventListener('resize', function(){ if(window.innerWidth > 768) closeSidebar(); });

/* ── Service Worker ── */
// Unregister all service workers to fix stuck cache
if ('serviceWorker' in navigator) {
  // Register — never unregister
  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('SW registered', reg.scope);

    // When a new SW takes over, reload once so all files are consistent
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'SW_UPDATED') {
        // Only auto-reload if the user isn't mid-form
        const hasUnsaved = document.querySelector('.modal-overlay.active') ||
                           document.querySelector('#case-modal[style*="flex"]');
        if (!hasUnsaved) {
          window.location.reload();
        }
      }
    });
  }).catch(err => console.warn('SW failed:', err));

  // Fix mobile "dead buttons" after coming back from background:
  // If the page was restored from bfcache (back-forward cache),
  // event listeners may be stale — force a clean reload
  window.addEventListener('pageshow', e => {
    if (e.persisted) {
      window.location.reload();
    }
  });

  // Detect going offline then online — re-validate the page isn't stale
  window.addEventListener('online', () => {
    navigator.serviceWorker.ready.then(reg => reg.update());
  });
}

/* ══════════════════════════════════════
   RECEIPT VAULT — all logic inline
══════════════════════════════════════ */
var rvReceipts=[],rvCompanies=[],rvCategories=[],rvBranches=[];
var rvEditId=null,rvNextId=1,rvFileHandle=null,rvAutoSaveTimer=null;

var RV_PALETTE=[
  {bg:'#fef3c7',fg:'#92400e'},{bg:'#d1fae5',fg:'#065f46'},
  {bg:'#dbeafe',fg:'#1e40af'},{bg:'#ede9fe',fg:'#5b21b6'},
  {bg:'#fce7f3',fg:'#9d174d'},{bg:'#e0f2fe',fg:'#0369a1'},
  {bg:'#fee2e2',fg:'#991b1b'},{bg:'#fff7ed',fg:'#c2410c'},
  {bg:'#f0fdf4',fg:'#166534'},{bg:'#fdf4ff',fg:'#7e22ce'}
];
var RV_BAR_COLORS=['#c8923a','#5b8dee','#34c98a','#e05c5c','#a78bfa','#f97316','#14b8a6','#ec4899','#84cc16','#6b7280'];
var RV_FSAPI=!!window.showOpenFilePicker;

/* show compat notice when receipts page first shown */
function rvInit(){
  if(!RV_FSAPI) document.getElementById('rv-compat-notice').style.display='block';
}

async function rvOpenExistingFile(){
  if(!RV_FSAPI){document.getElementById('rv-file-input').click();return;}
  try{
    var[handle]=await window.showOpenFilePicker({types:[{description:'Excel',accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}],multiple:false});
    rvFileHandle=handle;
    var file=await handle.getFile();
    await rvParseWorkbook(file);
    rvSetLinked(file.name);
    rvToast('Linked to '+file.name+' ✅');
  }catch(e){if(e.name!=='AbortError')rvToast('Could not open file.','err');}
}

async function rvCreateNewFile(){
  if(!RV_FSAPI){
    rvReceipts=[];rvCompanies=[];rvCategories=[];rvBranches=[];rvNextId=1;rvFileHandle=null;
    rvPopulateDropdowns();rvRenderManage();rvRenderTable();
    rvSetDotState('error','No auto-save (use Chrome/Edge)');
    document.getElementById('rv-setup-banner').style.display='none';
    rvToast('Started fresh — in-memory only.','err');return;
  }
  try{
    var handle=await window.showSaveFilePicker({suggestedName:'receipts.xlsx',types:[{description:'Excel',accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]});
    rvFileHandle=handle;
    rvReceipts=[];rvCompanies=[];rvCategories=[];rvBranches=[];rvNextId=1;
    rvPopulateDropdowns();rvRenderManage();rvRenderTable();
    rvSetLinked(handle.name);
    await rvWriteToDisk();
    rvToast('Created '+handle.name+' ✅');
  }catch(e){if(e.name!=='AbortError')rvToast('Could not create file.','err');}
}

function rvLegacyLoad(e){
  var file=e.target.files[0];if(!file)return;
  rvParseWorkbook(file).then(function(){
    document.getElementById('rv-setup-banner').style.display='none';
    rvSetDotState('linked','Loaded (manual — no auto-save)');
    rvToast('Loaded '+file.name);
  });
  e.target.value='';
}

function rvParseWorkbook(file){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(ev){
      try{
        var wb=XLSX.read(ev.target.result,{type:'array'});
        rvReceipts=[];
        if(wb.Sheets['Receipts']){
          XLSX.utils.sheet_to_json(wb.Sheets['Receipts'],{defval:''}).forEach(function(r){
            if(!r['Date']&&!r['Amount'])return;
            rvReceipts.push({id:rvNextId++,date:String(r['Date']||''),amount:parseFloat(r['Amount'])||0,from:String(r['From']||''),purpose:String(r['Purpose']||''),branch:String(r['Branch']||''),notes:String(r['Notes']||'')});
          });
        }
        rvCompanies=[];
        if(wb.Sheets['Companies']){
          XLSX.utils.sheet_to_json(wb.Sheets['Companies'],{defval:''}).forEach(function(r,i){
            if(r['Name'])rvCompanies.push({name:String(r['Name']),color:{bg:String(r['ColorBg']||RV_PALETTE[i%RV_PALETTE.length].bg),fg:String(r['ColorFg']||RV_PALETTE[i%RV_PALETTE.length].fg)}});
          });
        }
        rvCategories=[];
        if(wb.Sheets['Categories']){
          XLSX.utils.sheet_to_json(wb.Sheets['Categories'],{defval:''}).forEach(function(r,i){
            if(r['Name'])rvCategories.push({name:String(r['Name']),color:{bg:String(r['ColorBg']||RV_PALETTE[i%RV_PALETTE.length].bg),fg:String(r['ColorFg']||RV_PALETTE[i%RV_PALETTE.length].fg)}});
          });
        }
        rvBranches=[];
        if(wb.Sheets['Branches']){
          XLSX.utils.sheet_to_json(wb.Sheets['Branches'],{defval:''}).forEach(function(r){
            if(r['Name'])rvBranches.push({name:String(r['Name'])});
          });
        }
        rvPopulateDropdowns();rvRenderManage();rvRenderTable();resolve();
      }catch(err){rvToast('Could not read file.','err');reject(err);}
    };
    reader.readAsArrayBuffer(file);
  });
}

function rvBuildWorkbook(){
  var wb=XLSX.utils.book_new();
  var rRows=rvReceipts.map(function(r){return{Date:r.date,Amount:r.amount,From:r.from,Purpose:r.purpose,Branch:r.branch||'',Notes:r.notes||''};});
  var wsR=XLSX.utils.json_to_sheet(rRows.length?rRows:[{Date:'',Amount:'',From:'',Purpose:'',Branch:'',Notes:''}],{header:['Date','Amount','From','Purpose','Branch','Notes']});
  wsR['!cols']=[{wch:14},{wch:12},{wch:24},{wch:18},{wch:18},{wch:32}];
  XLSX.utils.book_append_sheet(wb,wsR,'Receipts');
  var cRows=rvCompanies.map(function(c){return{Name:c.name,ColorBg:c.color.bg,ColorFg:c.color.fg};});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(cRows.length?cRows:[{Name:'',ColorBg:'',ColorFg:''}],{header:['Name','ColorBg','ColorFg']}),'Companies');
  var kRows=rvCategories.map(function(c){return{Name:c.name,ColorBg:c.color.bg,ColorFg:c.color.fg};});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(kRows.length?kRows:[{Name:'',ColorBg:'',ColorFg:''}],{header:['Name','ColorBg','ColorFg']}),'Categories');
  var bRows=rvBranches.map(function(b){return{Name:b.name};});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(bRows.length?bRows:[{Name:''}],{header:['Name']}),'Branches');
  return XLSX.write(wb,{bookType:'xlsx',type:'array'});
}

async function rvWriteToDisk(){
  if(!rvFileHandle)return;
  rvSetDotState('saving','Saving…');
  try{
    var writable=await rvFileHandle.createWritable();
    var data=rvBuildWorkbook();
    await writable.write(new Blob([data],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    await writable.close();
    var name=rvFileHandle.name;
    rvSetDotState('saved','✅ Saved · '+name);
    setTimeout(function(){if(rvFileHandle)rvSetDotState('linked','Linked: '+name);},1800);
  }catch(e){
    rvSetDotState('error','⚠️ Save failed');
    rvToast('Auto-save failed: '+e.message,'err');
  }
}

function rvScheduleAutoSave(){
  rvRenderTable();
  if(!rvFileHandle)return;
  if(rvAutoSaveTimer)clearTimeout(rvAutoSaveTimer);
  rvSetDotState('saving','Saving…');
  rvAutoSaveTimer=setTimeout(function(){rvWriteToDisk();},900);
}

function rvSetLinked(name){
  document.getElementById('rv-setup-banner').style.display='none';
  rvSetDotState('linked','Linked: '+name);
}
function rvSetDotState(state,txt){
  document.getElementById('rv-dot').className='rv-dot '+state;
  document.getElementById('rv-save-txt').textContent=txt;
}

function rvFmt(n){return'BWP '+parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function rvEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function rvToast(msg,type){
  /* re-use the host app's toast if available, else use inline approach */
  if(typeof showToast === 'function'){showToast(msg);return;}
  var t=document.createElement('div');
  t.textContent=msg;
  t.style.cssText='position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;color:#fff;font-weight:600;font-size:13px;z-index:9999;background:'+(type==='err'?'#8a1a1a':'#1a7a4a');
  document.body.appendChild(t);
  setTimeout(function(){t.remove();},3000);
}
function rvNextColor(arr){return RV_PALETTE[arr.length%RV_PALETTE.length];}

function rvSwitchTab(name,btn){
  document.querySelectorAll('.rv-panel').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.rv-tab').forEach(function(b){b.classList.remove('active');});
  document.getElementById('rv-panel-'+name).classList.add('active');
  btn.classList.add('active');
  if(name==='summary')rvRenderSummary();
}

function rvBadgeForCat(name){
  for(var i=0;i<rvCategories.length;i++){
    if(rvCategories[i].name===name){
      var c=rvCategories[i].color||{bg:'#f3f4f6',fg:'#374151'};
      return'<span class="badge" style="background:'+c.bg+';color:'+c.fg+'">'+rvEsc(name)+'</span>';
    }
  }
  return'<span class="badge" style="background:var(--border-light);color:var(--text-muted)">'+rvEsc(name||'—')+'</span>';
}

function rvPopulateDropdowns(){
  ['rv-f-from','rv-fc-company'].forEach(function(id,i){
    var sel=document.getElementById(id),cur=sel.value;
    sel.innerHTML='<option value="">'+(i===0?'— Select company —':'All companies')+'</option>';
    rvCompanies.forEach(function(item){var o=document.createElement('option');o.value=item.name;o.textContent=item.name;sel.appendChild(o);});
    if(cur)sel.value=cur;
  });
  ['rv-f-purpose','rv-fc-purpose'].forEach(function(id,i){
    var sel=document.getElementById(id),cur=sel.value;
    sel.innerHTML='<option value="">'+(i===0?'— Select category —':'All categories')+'</option>';
    rvCategories.forEach(function(item){var o=document.createElement('option');o.value=item.name;o.textContent=item.name;sel.appendChild(o);});
    if(cur)sel.value=cur;
  });
  ['rv-f-branch','rv-fc-branch','rv-sum-branch'].forEach(function(id,i){
    var sel=document.getElementById(id),cur=sel.value;
    sel.innerHTML='<option value="">'+(i===0?'— Select branch —':'All branches')+'</option>';
    rvBranches.forEach(function(item){var o=document.createElement('option');o.value=item.name;o.textContent=item.name;sel.appendChild(o);});
    if(cur)sel.value=cur;
  });
}

function rvRenderManage(){
  rvRenderList('rv-company-list',rvCompanies,'rvDelCompany');
  rvRenderList('rv-category-list',rvCategories,'rvDelCategory');
  rvRenderBranchList();
}
function rvRenderList(id,arr,fnName){
  var el=document.getElementById(id);
  if(!arr.length){el.innerHTML='<div class="rv-list-empty">Nothing added yet.</div>';return;}
  el.innerHTML=arr.map(function(item,i){
    var c=item.color||{bg:'#f3f4f6',fg:'#374151'};
    return'<div class="rv-list-item"><span class="badge" style="background:'+c.bg+';color:'+c.fg+';margin-right:4px">'+rvEsc(item.name)+'</span><span class="lname">'+rvEsc(item.name)+'</span><button class="rv-list-item-del" onclick="'+fnName+'('+i+')">✕</button></div>';
  }).join('');
}
function rvRenderBranchList(){
  var el=document.getElementById('rv-branch-list');
  if(!rvBranches.length){el.innerHTML='<div class="rv-list-empty">Nothing added yet.</div>';return;}
  el.innerHTML=rvBranches.map(function(item,i){
    return'<div class="rv-list-item"><span class="rv-branch-badge" style="margin-right:4px">📍 '+rvEsc(item.name)+'</span><span class="lname">'+rvEsc(item.name)+'</span><button class="rv-list-item-del" onclick="rvDelBranch('+i+')">✕</button></div>';
  }).join('');
}

function rvAddCompany(){
  var val=document.getElementById('rv-new-company').value.trim();
  if(!val)return rvToast('Enter a company name.','err');
  for(var i=0;i<rvCompanies.length;i++)if(rvCompanies[i].name.toLowerCase()===val.toLowerCase())return rvToast('"'+val+'" already exists.','err');
  rvCompanies.push({name:val,color:rvNextColor(rvCompanies)});
  document.getElementById('rv-new-company').value='';
  rvRenderManage();rvPopulateDropdowns();rvScheduleAutoSave();rvToast('"'+val+'" added.');
}
function rvDelCompany(i){
  var name=rvCompanies[i].name;
  if(!confirm('Delete "'+name+'"?'))return;
  rvCompanies.splice(i,1);rvRenderManage();rvPopulateDropdowns();rvScheduleAutoSave();rvToast('"'+name+'" removed.');
}

function rvAddCategory(){
  var val=document.getElementById('rv-new-category').value.trim();
  if(!val)return rvToast('Enter a category name.','err');
  for(var i=0;i<rvCategories.length;i++)if(rvCategories[i].name.toLowerCase()===val.toLowerCase())return rvToast('"'+val+'" already exists.','err');
  rvCategories.push({name:val,color:rvNextColor(rvCategories)});
  document.getElementById('rv-new-category').value='';
  rvRenderManage();rvPopulateDropdowns();rvScheduleAutoSave();rvToast('"'+val+'" added.');
}
function rvDelCategory(i){
  var name=rvCategories[i].name;
  if(!confirm('Delete "'+name+'"?'))return;
  rvCategories.splice(i,1);rvRenderManage();rvPopulateDropdowns();rvScheduleAutoSave();rvToast('"'+name+'" removed.');
}

function rvAddBranch(){
  var val=document.getElementById('rv-new-branch').value.trim();
  if(!val)return rvToast('Enter a branch name.','err');
  for(var i=0;i<rvBranches.length;i++)if(rvBranches[i].name.toLowerCase()===val.toLowerCase())return rvToast('"'+val+'" already exists.','err');
  rvBranches.push({name:val});
  document.getElementById('rv-new-branch').value='';
  rvRenderManage();rvPopulateDropdowns();rvScheduleAutoSave();rvToast('"'+val+'" added.');
}
function rvDelBranch(i){
  var name=rvBranches[i].name;
  if(!confirm('Delete "'+name+'"?'))return;
  rvBranches.splice(i,1);rvRenderManage();rvPopulateDropdowns();rvScheduleAutoSave();rvToast('"'+name+'" removed.');
}

function rvFilteredReceipts(){
  var fc=document.getElementById('rv-fc-company').value;
  var fp=document.getElementById('rv-fc-purpose').value;
  var fb=document.getElementById('rv-fc-branch').value;
  return rvReceipts.filter(function(r){return(!fc||r.from===fc)&&(!fp||r.purpose===fp)&&(!fb||r.branch===fb);});
}
function rvClearFilters(){
  document.getElementById('rv-fc-company').value='';
  document.getElementById('rv-fc-purpose').value='';
  document.getElementById('rv-fc-branch').value='';
  rvRenderTable();
}

function rvRenderTable(){
  var list=rvFilteredReceipts();
  var tbody=document.getElementById('rv-tbody'),tfoot=document.getElementById('rv-tfoot'),empty=document.getElementById('rv-empty-msg');
  document.getElementById('rv-header-total').textContent=rvFmt(rvReceipts.reduce(function(s,r){return s+r.amount;},0));
  document.getElementById('rv-table-title').textContent='Receipts ('+list.length+')';
  document.getElementById('rv-table-count').textContent=list.length+' records';
  if(!list.length){tbody.innerHTML='';tfoot.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  var total=list.reduce(function(s,r){return s+r.amount;},0);
  tbody.innerHTML=list.map(function(r){
    return'<tr>'+
      '<td>'+rvEsc(r.date)+'</td>'+
      '<td class="rv-td-from">'+rvEsc(r.from)+'</td>'+
      '<td><span class="rv-branch-badge">📍 '+rvEsc(r.branch||'—')+'</span></td>'+
      '<td>'+rvBadgeForCat(r.purpose)+'</td>'+
      '<td class="rv-td-notes">'+(r.notes?rvEsc(r.notes):'—')+'</td>'+
      '<td class="rv-td-amt">'+rvFmt(r.amount)+'</td>'+
      '<td><div class="actions">'+
        '<button class="icon-btn" onclick="rvStartEdit('+r.id+')" title="Edit">✏️</button>'+
        '<button class="icon-btn" onclick="rvDelReceipt('+r.id+')" title="Delete">🗑️</button>'+
      '</div></td></tr>';
  }).join('');
  var fc=document.getElementById('rv-fc-company').value,fp=document.getElementById('rv-fc-purpose').value,fb=document.getElementById('rv-fc-branch').value;
  var parts=[];if(fc)parts.push(fc);if(fp)parts.push(fp);if(fb)parts.push('Branch: '+fb);
  var label=parts.length?'Total — '+parts.join(' + '):'Grand Total';
  tfoot.innerHTML='<tr><td colspan="5" style="font-weight:700">'+rvEsc(label)+'</td><td class="rv-td-amt" style="font-size:15px">'+rvFmt(total)+'</td><td></td></tr>';
}

function rvRenderSummary(){
  var body=document.getElementById('rv-summary-body');
  var sel=document.getElementById('rv-sum-branch').value;
  var src=sel?rvReceipts.filter(function(r){return r.branch===sel;}):rvReceipts;
  if(!src.length){body.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div><p>No receipts'+(sel?' for branch "'+rvEsc(sel)+'"':'')+' to summarise.</p></div>';return;}
  var total=src.reduce(function(s,r){return s+r.amount;},0);
  function group(key){var m={};src.forEach(function(r){var k=r[key]||'Unknown';m[k]=(m[k]||0)+r.amount;});return Object.keys(m).map(function(k){return[k,m[k]];}).sort(function(a,b){return b[1]-a[1];});}
  function rows(entries,useBadge){
    return entries.map(function(e,i){
      var pct=total?(e[1]/total*100):0;
      var nameHtml=useBadge?'<div style="margin-bottom:5px">'+rvBadgeForCat(e[0])+'</div>':'<span class="rv-sum-name">'+rvEsc(e[0])+'</span>';
      return'<div class="rv-sum-row">'+
        '<div class="rv-sum-left">'+nameHtml+
          '<div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct.toFixed(1)+'%;background:'+RV_BAR_COLORS[i%RV_BAR_COLORS.length]+'"></div></div></div>'+
        '<div class="rv-sum-right"><span class="rv-s-amt">'+rvFmt(e[1])+'</span><span class="rv-s-pct">'+pct.toFixed(1)+'%</span></div></div>';
    }).join('');
  }
  var branchSection=!sel?'<div class="rv-sum-section"><div class="rv-sum-heading">By Branch</div>'+rows(group('branch'),false)+'</div>':'';
  body.innerHTML=
    '<div class="rv-sum-section"><div class="rv-sum-heading">By Category</div>'+rows(group('purpose'),true)+'</div>'+
    '<div class="rv-sum-section"><div class="rv-sum-heading">By Company</div>'+rows(group('from'),false)+'</div>'+
    branchSection+
    '<div class="rv-grand-row"><span>Grand Total'+(sel?' — '+rvEsc(sel)+' Branch':'')+'</span><span>'+rvFmt(total)+'</span></div>';
}

function rvExportPDF(){rvRenderSummary();window.print();}

function rvSubmitForm(){
  var date=document.getElementById('rv-f-date').value.trim();
  var amount=parseFloat(document.getElementById('rv-f-amount').value);
  var from=document.getElementById('rv-f-from').value;
  var purpose=document.getElementById('rv-f-purpose').value;
  var branch=document.getElementById('rv-f-branch').value;
  var notes=document.getElementById('rv-f-notes').value.trim();
  if(!date||!from)return rvToast('Date and Company are required.','err');
  if(!purpose)return rvToast('Please select a category.','err');
  if(!branch)return rvToast('Please select a branch.','err');
  if(isNaN(amount)||amount<=0)return rvToast('Enter a valid positive amount.','err');
  if(rvEditId!==null){
    rvReceipts=rvReceipts.map(function(r){return r.id===rvEditId?{id:r.id,date:date,amount:amount,from:from,purpose:purpose,branch:branch,notes:notes}:r;});
    rvCancelEdit();rvToast('Receipt updated.');
  }else{
    rvReceipts.push({id:rvNextId++,date:date,amount:amount,from:from,purpose:purpose,branch:branch,notes:notes});
    rvClearForm();rvToast('Receipt added.');
  }
  rvScheduleAutoSave();
}
function rvClearForm(){['rv-f-date','rv-f-amount','rv-f-from','rv-f-purpose','rv-f-branch','rv-f-notes'].forEach(function(id){document.getElementById(id).value='';});}
function rvStartEdit(id){
  var r=rvReceipts.find(function(x){return x.id===id;});if(!r)return;
  rvEditId=id;
  document.getElementById('rv-f-date').value=r.date;
  document.getElementById('rv-f-amount').value=r.amount;
  document.getElementById('rv-f-from').value=r.from;
  document.getElementById('rv-f-purpose').value=r.purpose;
  document.getElementById('rv-f-branch').value=r.branch||'';
  document.getElementById('rv-f-notes').value=r.notes||'';
  document.getElementById('rv-form-title').textContent='✏️ Edit Receipt';
  document.getElementById('rv-submit-btn').textContent='Update Receipt';
  document.getElementById('rv-cancel-btn').style.display='inline-flex';
  /* switch to receipts tab */
  document.querySelectorAll('.rv-tab')[0].click();
  var page=document.getElementById('page-receipts');
  if(page)page.scrollTop=0;
}
function rvCancelEdit(){
  rvEditId=null;rvClearForm();
  document.getElementById('rv-form-title').textContent='➕ Add Receipt';
  document.getElementById('rv-submit-btn').textContent='Add Receipt';
  document.getElementById('rv-cancel-btn').style.display='none';
}
function rvDelReceipt(id){
  if(!confirm('Delete this receipt?'))return;
  rvReceipts=rvReceipts.filter(function(r){return r.id!==id;});
  rvScheduleAutoSave();rvToast('Receipt deleted.');
}
// Sync footer version with SW version
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' });
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'VERSION') {
      const footer = document.getElementById('app-version-footer');
      if (footer) footer.textContent = e.data.version + ' · Ditshwanelo Case Register';
    }
  });
}
function openCaseGuidance(){
  if(!window.currentViewCaseId){ alert('Open a case first.'); return; }
  window.open('case-guidance.html?case=' + window.currentViewCaseId, '_blank');
}
/* initialise on page load */
rvInit();
rvRenderTable();


