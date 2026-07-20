'use strict';

// Hien loi JS ra man hinh (chan doan khi khong mo devtools)
function showFatal(msg){
  let b=document.getElementById('__errbar');
  if(!b){b=document.createElement('div');b.id='__errbar';
    b.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#7f1d1d;color:#fff;padding:8px 12px;font:12px/1.4 Segoe UI;white-space:pre-wrap;max-height:40vh;overflow:auto';
    (document.body||document.documentElement).appendChild(b);}
  b.textContent='⚠️ Lỗi: '+msg+'  (chụp dòng này gửi để sửa)';
}
window.addEventListener('error',e=>showFatal((e.error&&e.error.stack)||e.message||'unknown'));
window.addEventListener('unhandledrejection',e=>showFatal('Promise: '+((e.reason&&e.reason.message)||e.reason)));

const $=id=>document.getElementById(id);
const api=window.appBridge||new Proxy({},{get:()=>()=>new Promise(()=>{})});

if(!window.appBridge){
  const b=document.createElement('div');
  b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;padding:14px;font:14px Segoe UI;text-align:center';
  b.textContent='Đây là bản xem trước — hãy mở app thật (bản đã cài) để dùng.';
  document.body.appendChild(b);
}

function msg(el,text,ok){el.textContent=text;el.className='msg '+(ok?'ok':'err');}
function logLine(text,cls){
  const l=$('log');const d=document.createElement('div');
  if(cls)d.className=cls;d.textContent=text;l.appendChild(d);l.scrollTop=l.scrollHeight;
}

// ---------- DANG NHAP ----------
async function doLogin(){
  const u=$('loginUser').value.trim(),p=$('loginPass').value;
  if(!u||!p){msg($('loginMsg'),'Nhập tên đăng nhập và mật khẩu',false);return;}
  $('loginBtn').disabled=true;msg($('loginMsg'),'Đang đăng nhập...',true);
  const r=await api.login({username:u,password:p});
  $('loginBtn').disabled=false;
  if(r.ok){enterApp(r.user);}else{msg($('loginMsg'),r.error||'Sai tài khoản',false);}
}
$('loginBtn').onclick=doLogin;
$('loginPass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});

async function enterApp(user){
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('whoami').textContent=(user&&(user.displayName||user.username))||'';
  await loadNiches();
  await loadSettings();
  bindDna();
  await loadDna();
  await loadVersion();
}

$('logoutBtn').onclick=async()=>{await api.logout();location.reload();};

// ---------- CHUYEN VIEW ----------
document.querySelectorAll('.nav-item').forEach(a=>{
  a.onclick=()=>{
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
    a.classList.add('active');
    const v=a.dataset.view;
    document.querySelectorAll('.view').forEach(s=>s.classList.add('hidden'));
    $('view-'+v).classList.remove('hidden');
    if(v==='history')loadHistory();
    if(v==='logs')loadLogs();
    if(v==='accounts')loadUsers();
  };
});

// ---------- LOG ----------
function fmtWhen(iso){ try{ return new Date(iso).toLocaleString('vi-VN'); }catch(_){ return iso||'?'; } }

async function loadLogs(){
  const r=await api.getLogs();
  if(!r||!r.ok){ msg($('logMsg'),(r&&r.error)||'Không đọc được log',false); return; }
  $('logRaw').value=r.raw||'';
  $('logHistory').value=r.history||'';
  const m=r.meta;
  if(!m){ $('logMeta').textContent='Chưa có lần chạy nào được ghi log.'; return; }
  const parts=[];
  parts.push('Lúc: '+fmtWhen(m.at));
  parts.push('Ngách: '+(m.niche||'?'));
  parts.push('Lần thử: '+(m.attempt||'?'));
  parts.push('Kết quả: '+(m.ok?'✅ ĐỦ KHUÔN':'❌ THIẾU KHUÔN'));
  if(typeof m.rawLength==='number')parts.push('Độ dài Claude trả về: '+m.rawLength+' ký tự');
  if(m.missing&&m.missing.length)parts.push('THIẾU: '+m.missing.join(' | '));
  if(m.warnings&&m.warnings.length)parts.push('⚠️ CẢNH BÁO LỌT NHÃN: '+m.warnings.join(' | '));
  if(m.found&&m.found.length)parts.push('Tìm thấy các mảnh: '+m.found.join(', '));
  else parts.push('Tìm thấy các mảnh: KHÔNG có mảnh nào');
  if(m.error)parts.push('Lỗi: '+m.error);
  $('logMeta').innerHTML=parts.map(p=>'<div>'+p.replace(/</g,'&lt;')+'</div>').join('');
  msg($('logMsg'),'Đã tải log ('+(r.dir||'')+')',true);
}
$('reloadLogBtn').onclick=loadLogs;
$('openLogFolderBtn').onclick=async()=>{
  const r=await api.openLogsFolder();
  msg($('logMsg'),r.ok?('Đã mở: '+r.dir):(r.error||'Không mở được'),r.ok);
};
$('copyLogBtn').onclick=async()=>{
  const t=$('logRaw').value||'';
  if(!t){msg($('logMsg'),'Chưa có gì để copy',false);return;}
  try{ await navigator.clipboard.writeText(t); msg($('logMsg'),'Đã copy nguyên văn vào clipboard',true); }
  catch(_){ $('logRaw').select(); document.execCommand('copy'); msg($('logMsg'),'Đã copy',true); }
};

// ---------- TAI KHOAN ----------
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadUsers(){
  const box=$('usersList');
  box.innerHTML='<div class="hint">Đang tải...</div>';
  const r=await api.listUsers();
  if(!r||!r.ok){
    box.innerHTML='';
    msg($('usersMsg'),(r&&r.error)||'Không tải được danh sách (có thể tài khoản của bạn không phải admin)',false);
    return;
  }
  msg($('usersMsg'),'',true);
  const users=r.users||r.data||[];
  if(!users.length){ box.innerHTML='<div class="hint">Chưa có tài khoản nào.</div>'; return; }
  box.innerHTML=users.map(u=>{
    const id=esc(u.id||u.user_id||'');
    const name=esc(u.display_name||u.displayName||u.username||'');
    const uname=esc(u.username||'');
    const role=esc(u.role||'staff');
    const active=(u.active===undefined?true:!!u.active);
    return '<div class="hist-row">'
      +'<span><b>'+uname+'</b>'+(name&&name!==uname?(' — '+name):'')
      +' <span class="hint">['+role+(active?'':' · ĐANG KHOÁ')+']</span></span>'
      +'<span>'
      +'<button class="btn btn-ghost btn-sm act-pass" data-id="'+id+'" data-u="'+uname+'">Đổi MK</button> '
      +'<button class="btn btn-ghost btn-sm act-active" data-id="'+id+'" data-active="'+(active?'1':'0')+'">'+(active?'Khoá':'Mở khoá')+'</button> '
      +'<button class="btn btn-ghost btn-sm act-del" data-id="'+id+'" data-u="'+uname+'">Xoá</button>'
      +'</span></div>';
  }).join('');

  box.querySelectorAll('.act-pass').forEach(b=>{
    b.onclick=async()=>{
      const np=prompt('Mật khẩu MỚI cho tài khoản "'+b.dataset.u+'":');
      if(!np)return;
      const r2=await api.setPassword({userId:b.dataset.id,newPassword:np});
      msg($('usersMsg'),r2.ok?('Đã đổi mật khẩu cho '+b.dataset.u):(r2.error||'Lỗi'),r2.ok);
    };
  });
  box.querySelectorAll('.act-active').forEach(b=>{
    b.onclick=async()=>{
      const makeActive=b.dataset.active!=='1';
      const r2=await api.setActive({userId:b.dataset.id,active:makeActive});
      if(r2.ok)loadUsers(); else msg($('usersMsg'),r2.error||'Lỗi',false);
    };
  });
  box.querySelectorAll('.act-del').forEach(b=>{
    b.onclick=async()=>{
      if(!confirm('Xoá hẳn tài khoản "'+b.dataset.u+'"? Không khôi phục được.'))return;
      const r2=await api.deleteUser({userId:b.dataset.id});
      if(r2.ok)loadUsers(); else msg($('usersMsg'),r2.error||'Lỗi',false);
    };
  });
}
$('reloadUsersBtn').onclick=loadUsers;
$('createUserBtn').onclick=async()=>{
  const username=$('newUsername').value.trim();
  const password=$('newUserPass').value;
  const displayName=$('newUserDisplay').value.trim();
  const role=$('newUserRole').value;
  if(!username||!password){msg($('createUserMsg'),'Nhập tên đăng nhập và mật khẩu',false);return;}
  const r=await api.createUser({username,password,displayName,role});
  if(r.ok){
    msg($('createUserMsg'),'Đã tạo tài khoản '+username,true);
    $('newUsername').value='';$('newUserPass').value='';$('newUserDisplay').value='';
    loadUsers();
  } else msg($('createUserMsg'),r.error||'Lỗi tạo tài khoản',false);
};

// ---------- NGACH ----------
async function loadNiches(){
  const r=await api.getNiches();
  if(!r.ok)return;
  const sel=$('nicheSel');sel.innerHTML='';
  r.niches.forEach(n=>{
    const o=document.createElement('option');o.value=n.code;o.textContent=n.code+' — '+n.label;sel.appendChild(o);
  });
}

// ---------- VIET BAI ----------
let running=false;
$('writeBtn').onclick=async()=>{
  if(running)return;
  const niche=$('nicheSel').value;
  const count=parseInt($('countInput').value,10)||1;
  running=true;$('writeBtn').disabled=true;$('progBadge').classList.remove('hidden');
  $('log').innerHTML='';
  logLine('Bắt đầu viết '+count+' bài, ngách '+niche+'...');
  const off=api.onProgress(p=>{if(p&&p.message)logLine(p.message, /✓/.test(p.message)?'ok':null);});
  const r=await api.write({niche,count});
  off&&off();
  running=false;$('writeBtn').disabled=false;$('progBadge').classList.add('hidden');
  if(r.ok){
    logLine('✅ Xong! Đã ghi '+r.written+' bài lên Google Sheet.'+(r.failed&&r.failed.length?' ('+r.failed.length+' bài lỗi bỏ qua)':''),'ok');
  }else{
    logLine('❌ '+ (r.error||'Lỗi không rõ'),'err');
  }
};

// ---------- CAI DAT ----------
async function loadSettings(){
  const r=await api.getSettings();
  if(!r.ok)return;
  $('sheetUrl').value=r.sheets.webhookUrl||'';
  // ngach -> text
  $('nichesText').value=(r.story.niches||[]).map(n=>n.code+' | '+n.label).join('\n');
  $('skillCmd').value=r.story.skillCommand||'';
  // Anh & Luu tru
  const im=r.image||{};
  $('cfAccountId').value=im.cfAccountId||'';
  $('cfApiToken').value=im.cfApiToken||'';
  $('r2AccessKeyId').value=im.r2AccessKeyId||'';
  $('r2SecretAccessKey').value=im.r2SecretAccessKey||'';
  $('r2Endpoint').value=im.r2Endpoint||'';
  $('r2Bucket').value=im.r2Bucket||'story-factory';
  $('r2PublicDomain').value=im.r2PublicDomain||'https://cdn-story.jovaaqua.com';
}

// ---------- STORY DNA ----------
let dnaAxes=[];
async function loadDna(){
  const r=await api.dnaGet();
  if(!r||!r.ok)return;
  dnaAxes=r.axes||[];
  // dropdown nuoc dang chay + nuoc sua
  const opts=(r.countries||['US']).map(c=>'<option value="'+c+'">'+c+'</option>').join('');
  $('dnaRunning').innerHTML=opts;
  $('dnaEditCountry').innerHTML=opts;
  $('dnaRunning').value=r.running||'US';
  $('dnaEditCountry').value=r.running||'US';
  // render 12 textarea theo truc
  $('dnaAxes').innerHTML=dnaAxes.map(a=>
    '<label class="lbl">'+esc(a.label)+'</label>'
    +'<textarea class="in area mono dna-axis" data-key="'+esc(a.key)+'" rows="4" placeholder="mỗi dòng 1 mục"></textarea>'
  ).join('');
  await loadDnaPool($('dnaEditCountry').value);
}
async function loadDnaPool(country){
  const r=await api.dnaGetPool({country});
  if(!r||!r.ok)return;
  const pool=r.pool||{};
  document.querySelectorAll('.dna-axis').forEach(ta=>{
    const arr=pool[ta.dataset.key]||[];
    ta.value=Array.isArray(arr)?arr.join('\n'):'';
  });
}
function bindDna(){
  const es=$('dnaEditCountry'); if(es)es.onchange=()=>loadDnaPool(es.value);
  const sr=$('dnaSaveRunningBtn'); if(sr)sr.onclick=async()=>{
    const r=await api.dnaSetRunning({country:$('dnaRunning').value});
    msg($('dnaRunMsg'),r.ok?('Nước đang chạy: '+r.running):(r.error||'Lỗi'),r.ok);
  };
  const sp=$('dnaSavePoolBtn'); if(sp)sp.onclick=async()=>{
    const country=$('dnaEditCountry').value;
    const pool={};
    document.querySelectorAll('.dna-axis').forEach(ta=>{
      pool[ta.dataset.key]=ta.value.split(/\n/).map(s=>s.trim()).filter(Boolean);
    });
    const r=await api.dnaSavePool({country,pool});
    if(r.ok){msg($('dnaPoolMsg'),'Đã lưu pool cho '+country,true);await loadDna();}
    else msg($('dnaPoolMsg'),r.error||'Lỗi',false);
  };
}

$('saveImageBtn').onclick=async()=>{
  msg($('imageMsg'),'Đang lưu...',true);
  const r=await api.saveImage({
    cfAccountId:$('cfAccountId').value.trim(),
    cfApiToken:$('cfApiToken').value.trim(),
    r2AccessKeyId:$('r2AccessKeyId').value.trim(),
    r2SecretAccessKey:$('r2SecretAccessKey').value.trim(),
    r2Endpoint:$('r2Endpoint').value.trim(),
    r2Bucket:$('r2Bucket').value.trim(),
    r2PublicDomain:$('r2PublicDomain').value.trim(),
  });
  msg($('imageMsg'),r.ok?'Đã lưu key ảnh & R2':(r.error||'Lỗi'),r.ok);
};

$('saveSheetBtn').onclick=async()=>{
  const r=await api.saveSheets({webhookUrl:$('sheetUrl').value.trim()});
  msg($('sheetMsg'),r.ok?'Đã lưu URL Google Sheets':(r.error||'Lỗi'),r.ok);
};
$('testSheetBtn').onclick=async()=>{
  msg($('sheetMsg'),'Đang ghi thử...',true);
  const r=await api.sheetsTest();
  msg($('sheetMsg'),r.ok?'✓ Đã ghi 1 dòng test — mở Sheet kiểm tra':(r.error||'Lỗi'),r.ok);
};

$('saveStoryBtn').onclick=async()=>{
  // parse ngach tu text
  const niches=$('nichesText').value.split(/\n/).map(l=>{
    const m=l.split('|');if(m.length<2)return null;
    return {code:m[0].trim(),label:m.slice(1).join('|').trim()};
  }).filter(Boolean);
  const skillCommand=$('skillCmd').value;
  const r=await api.saveStory({niches,skillCommand});
  if(r.ok){msg($('storyMsg'),'Đã lưu ngách & câu lệnh',true);await loadNiches();}
  else msg($('storyMsg'),r.error||'Lỗi',false);
};

$('claudeLoginBtn').onclick=async()=>{
  msg($('aiMsg'),'Đang mở cửa sổ Claude... đăng nhập xong hãy đóng cửa sổ.',true);
  const r=await api.aiLogin({provider:'claude'});
  msg($('aiMsg'),r.ok?(r.message||'Đã lưu phiên Claude'):(r.error||'Lỗi'),r.ok);
};
$('claudeLogoutBtn').onclick=async()=>{
  const r=await api.aiLogout({provider:'claude'});
  msg($('aiMsg'),r.ok?(r.message||'Đã đăng xuất Claude'):(r.error||'Lỗi'),r.ok);
};

$('changePassBtn').onclick=async()=>{
  const o=$('oldPass').value,n=$('newPass').value;
  if(!o||!n){msg($('passMsg'),'Nhập cả 2 ô',false);return;}
  const r=await api.changePassword({oldPassword:o,newPassword:n});
  msg($('passMsg'),r.ok?'Đã đổi mật khẩu':(r.error||'Lỗi'),r.ok);
  if(r.ok){$('oldPass').value='';$('newPass').value='';}
};

// ---------- LICH SU ----------
async function loadHistory(){
  const r=await api.listJobs();
  const box=$('historyList');
  if(!r.ok||!r.jobs||!r.jobs.length){box.innerHTML='<div class="hint">Chưa có lượt viết nào.</div>';return;}
  box.innerHTML=r.jobs.map(j=>{
    const t=new Date(j.at).toLocaleString('vi-VN');
    return '<div class="hist-row"><span>'+t+' — ngách '+(j.niche||'?')+'</span><span>'+(j.count||0)+' bài'+(j.failed?(' · '+j.failed+' lỗi'):'')+'</span></div>';
  }).join('');
}

// ---------- VERSION ----------
async function loadVersion(){
  const r=await api.updateInfo();
  if(r&&r.ok)$('verText').textContent='Phiên bản '+r.version;
}
$('checkUpdateBtn').onclick=async()=>{
  msg($('updMsg'),'Đang kiểm tra...',true);
  const r=await api.checkUpdate();
  if(!r||!r.ok){msg($('updMsg'),(r&&r.error)||'Lỗi kiểm tra',false);}
};
api.onUpdateEvent(d=>{
  if(!d)return;
  if(d.type==='available')msg($('updMsg'),'Có bản mới '+d.version+', đang tải...',true);
  else if(d.type==='none')msg($('updMsg'),'Đang dùng bản mới nhất',true);
  else if(d.type==='downloaded')msg($('updMsg'),'Đã tải bản '+d.version+' — khởi động lại để cài',true);
  else if(d.type==='error')msg($('updMsg'),'Lỗi cập nhật: '+d.error,false);
});

// tu dong vao app neu con phien
(async()=>{const r=await api.me();if(r&&r.ok&&r.user)enterApp(r.user);})();
