/* ============================================================
   VolVoxPro — GitHub Upload Extension
   Подключается в index.html перед </body>:
     <script src="github-upload.js"></script>
   
   Позволяет ментору публиковать PDF прямо в репозиторий GitHub
   из интерфейса приложения. Токен хранится только в IndexedDB
   этого браузера и никогда не попадает в JSON-экспорт.
   ============================================================ */

(function(){
'use strict';

/* -------------------- Константы -------------------- */
const IDB_SETTINGS_STORE = 'settings';
const GH_CONFIG_ID = '__github_config__';
const GH_INDEX_FILE = 'materials.json';           // внутри папки docs
const GH_MAX_SIZE = 25 * 1024 * 1024;             // 25 МБ на файл

/* -------------------- IndexedDB для настроек -------------------- */
function idbOpenV2(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('volvoxpro_files', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('materials')){
        db.createObjectStore('materials', { keyPath:'id' });
      }
      if(!db.objectStoreNames.contains(IDB_SETTINGS_STORE)){
        db.createObjectStore(IDB_SETTINGS_STORE, { keyPath:'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getSetting(id){
  const db = await idbOpenV2();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_SETTINGS_STORE, 'readonly');
    const r = tx.objectStore(IDB_SETTINGS_STORE).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function setSetting(id, value){
  const db = await idbOpenV2();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_SETTINGS_STORE, 'readwrite');
    tx.objectStore(IDB_SETTINGS_STORE).put({ id, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function delSetting(id){
  const db = await idbOpenV2();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_SETTINGS_STORE, 'readwrite');
    tx.objectStore(IDB_SETTINGS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* -------------------- Конфиг GitHub -------------------- */
let ghConfig = null;

async function loadGitHubConfig(){
  try{
    const item = await getSetting(GH_CONFIG_ID);
    ghConfig = item && item.value ? item.value : null;
  }catch(e){
    console.warn('[GH] config load error', e);
    ghConfig = null;
  }
  return ghConfig;
}
async function saveGitHubConfig(cfg){
  ghConfig = cfg;
  if(cfg) await setSetting(GH_CONFIG_ID, cfg);
  else await delSetting(GH_CONFIG_ID);
}

/* -------------------- Удалённый индекс материалов -------------------- */
let remoteMaterials = [];

function normalizeRemote(item){
  return {
    id: 'remote_' + (item.id || Math.random().toString(36).slice(2,9)),
    _remoteId: item.id,
    title: item.title || 'Без названия',
    desc: item.desc || '',
    tag: item.tag || 'Свои',
    icon: item.icon || '📄',
    color: item.color || '#4f8cff',
    color2: item.color2 || '#7bb0ff',
    pages: item.pages || 0,
    file: item.file || ('docs/' + (item.filename || 'file.pdf')),
    isRemote: true
  };
}

async function loadRemoteIndex(){
  try{
    const res = await fetch('docs/' + GH_INDEX_FILE + '?t=' + Date.now(), { cache: 'no-store' });
    if(!res.ok){ remoteMaterials = []; return []; }
    const data = await res.json();
    remoteMaterials = Array.isArray(data) ? data.map(normalizeRemote) : [];
  }catch(e){
    console.warn('[GH] remote index not loaded:', e.message);
    remoteMaterials = [];
  }
  return remoteMaterials;
}

/* -------------------- Патч allMaterials -------------------- */
const _origAllMaterials = window.allMaterials;
window.allMaterials = function(){
  const base = _origAllMaterials ? _origAllMaterials() : [];
  const seen = new Set(base.map(m => m.file));
  const extra = remoteMaterials.filter(m => !seen.has(m.file));
  return [...base, ...extra];
};

/* -------------------- Утилиты -------------------- */
const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y',
  'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
  'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
};
function slugify(s){
  return String(s).toLowerCase()
    .split('').map(ch => TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch).join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'file';
}
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx+1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}
function b64EncodeUtf8(str){
  return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUtf8(b64){
  return decodeURIComponent(escape(atob(b64)));
}

/* -------------------- GitHub API -------------------- */
function ghHeaders(token){
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}
async function ghGetFile(config, path){
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`;
  const res = await fetch(url, { headers: ghHeaders(config.token) });
  if(res.status === 404) return null;
  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return await res.json();
}
async function ghPutFile(config, path, base64Content, message, sha){
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
  const body = {
    message: message || ('Update ' + path),
    content: base64Content,
    branch: config.branch
  };
  if(sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return await res.json();
}
async function ghDeleteFile(config, path, message){
  const info = await ghGetFile(config, path);
  if(!info) return null;
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || ('Delete ' + path), sha: info.sha, branch: config.branch })
  });
  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return await res.json();
}
async function ghTestConnection(config){
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}`;
  const res = await fetch(url, { headers: ghHeaders(config.token) });
  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return await res.json();
}

/* -------------------- UI: конфиг GitHub -------------------- */
function renderGitHubConfigBlock(){
  const c = ghConfig || {};
  const hasToken = !!c.token;
  return `
    <div class="card" id="ghConfigCard" style="border-color:${hasToken ? 'var(--accent2)' : 'var(--border)'}">
      <h3 style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span>🐙 GitHub-подключение</span>
        <span class="badge" style="background:${hasToken?'#123a26':'#3a1212'};color:${hasToken?'#5ee89a':'#ff9090'}">
          ${hasToken ? '✓ настроено' : 'не настроено'}
        </span>
      </h3>
      <p class="muted" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">
        Чтобы материал видели <b>все</b>, кто открывает ссылку на VolVoxPro, нужно один раз указать
        репозиторий и Personal Access Token. Токен хранится <b>только в этом браузере</b>
        и не попадает ни в JSON-экспорт, ни в интернет.
      </p>
      <div class="row c2">
        <div class="field"><label>Владелец (owner)</label>
          <input id="ghOwner" value="${esc(c.owner||'')}" placeholder="например: GoshaTSK"></div>
        <div class="field"><label>Репозиторий</label>
          <input id="ghRepo" value="${esc(c.repo||'')}" placeholder="например: VolVoxPro2"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Ветка</label>
          <input id="ghBranch" value="${esc(c.branch||'main')}" placeholder="main"></div>
        <div class="field"><label>Папка для PDF</label>
          <input id="ghFolder" value="${esc(c.folder||'docs')}" placeholder="docs"></div>
      </div>
      <div class="field">
        <label>Personal Access Token (fine-grained, Contents: Read and write)</label>
        <input id="ghToken" type="password" value="${esc(c.token||'')}" placeholder="github_pat_...">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="ghSave">💾 Сохранить</button>
        <button class="btn" id="ghTest">🔌 Проверить соединение</button>
        ${hasToken ? `<button class="btn danger" id="ghForget">🗑 Забыть токен</button>` : ''}
      </div>
      <div id="ghStatus" class="muted" style="font-size:12px;margin-top:10px"></div>
      <details style="margin-top:14px;font-size:12px;color:var(--muted)">
        <summary style="cursor:pointer;color:var(--accent);font-weight:600">Как получить токен (один раз, 2 минуты)</summary>
        <ol style="padding-left:22px;line-height:1.75;margin-top:8px">
          <li>Открой <b>github.com/settings/tokens?type=beta</b></li>
          <li><b>Generate new token</b></li>
          <li>Repository access → <b>Only select repositories</b> → выбери <b>${esc(c.repo||'свой репозиторий')}</b></li>
          <li>Permissions → Repository permissions → <b>Contents</b> → <b>Read and write</b></li>
          <li>Generate token и вставь его выше</li>
        </ol>
      </details>
    </div>
  `;
}

function bindGitHubConfigBlock(main){
  const statusEl = $('#ghStatus', main);
  const readCfg = () => ({
    owner: ($('#ghOwner', main).value || '').trim(),
    repo: ($('#ghRepo', main).value || '').trim(),
    branch: (($('#ghBranch', main).value || '').trim() || 'main'),
    folder: (($('#ghFolder', main).value || '').trim() || 'docs').replace(/\/+$/,''),
    token: ($('#ghToken', main).value || '').trim()
  });

  $('#ghSave', main).onclick = async () => {
    const cfg = readCfg();
    if(!cfg.owner || !cfg.repo || !cfg.token){
      return toast('Заполни owner, repo и токен', true);
    }
    await saveGitHubConfig(cfg);
    toast('Сохранено');
    renderMaterials(document.getElementById('main'));
  };

  $('#ghTest', main).onclick = async () => {
    const cfg = readCfg();
    if(!cfg.owner || !cfg.repo || !cfg.token) return toast('Заполни owner, repo и токен', true);
    statusEl.textContent = 'Проверяю…';
    try{
      const repo = await ghTestConnection(cfg);
      const canWrite = repo.permissions && (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain);
      statusEl.innerHTML = `✓ Соединение OK. Репозиторий: <b>${esc(repo.full_name)}</b>. Права на запись: <b>${canWrite ? 'да' : 'НЕТ — проверь токен'}</b>`;
    }catch(e){
      statusEl.textContent = '✗ Ошибка: ' + e.message;
    }
  };

  const forgetBtn = $('#ghForget', main);
  if(forgetBtn){
    forgetBtn.onclick = async () => {
      if(!confirm('Забыть токен? Придётся вводить заново.')) return;
      await saveGitHubConfig(null);
      toast('Токен удалён');
      renderMaterials(document.getElementById('main'));
    };
  }
}

/* -------------------- Публикация материала -------------------- */
async function publishMaterial(main){
  if(!ghConfig || !ghConfig.token){
    return toast('Сначала настрой GitHub-подключение выше', true);
  }
  const fileInput = $('#upFile', main);
  const file = fileInput.files && fileInput.files[0];
  if(!file) return toast('Сначала выбери PDF', true);
  if(file.size > GH_MAX_SIZE) return toast('Файл больше 25 МБ — GitHub через API не примет', true);

  const title = ($('#upTitle', main).value || '').trim();
  if(!title) return toast('Укажи название', true);
  const desc = ($('#upDesc', main).value || '').trim();
  const tag = (($('#upTag', main).value || '').trim()) || 'Свои';
  const icon = (($('#upIcon', main).value || '').trim()) || '📄';
  const colorPair = ($('#upColor', main).value || '#4f8cff,#7bb0ff').split(',');
  const statusEl = $('#upStatus', main);
  const folder = ghConfig.folder || 'docs';

  try{
    statusEl.textContent = 'Читаю файл…';
    const b64 = await fileToBase64(file);

    const slug = slugify(title);
    const filename = `${slug}-${Date.now().toString(36)}.pdf`;
    const filePath = `${folder}/${filename}`;

    statusEl.textContent = 'Загружаю PDF на GitHub…';
    await ghPutFile(ghConfig, filePath, b64, `Add material: ${title}`);

    statusEl.textContent = 'Обновляю индекс материалов…';
    const idxPath = `${folder}/${GH_INDEX_FILE}`;
    const idxInfo = await ghGetFile(ghConfig, idxPath);
    let arr = [];
    let sha = null;
    if(idxInfo && idxInfo.content){
      try{
        const decoded = b64DecodeUtf8(idxInfo.content.replace(/\s/g,''));
        const parsed = JSON.parse(decoded);
        if(Array.isArray(parsed)) arr = parsed;
      }catch(e){ console.warn('[GH] index parse error', e); }
      sha = idxInfo.sha;
    }

    const entry = {
      id: 'rm_' + Date.now().toString(36),
      title, desc, tag, icon,
      color: colorPair[0],
      color2: colorPair[1] || colorPair[0],
      file: filePath,
      pages: 0,
      addedAt: Date.now()
    };
    arr.push(entry);

    const newContent = b64EncodeUtf8(JSON.stringify(arr, null, 2));
    await ghPutFile(ghConfig, idxPath, newContent, `Index: add "${title}"`, sha);

    remoteMaterials.push(normalizeRemote(entry));

    statusEl.textContent = '✓ Опубликовано! Материал появится у всех через 1–2 минуты (кэш GitHub Pages).';
    toast('Опубликовано на GitHub');

    $('#upTitle', main).value = '';
    $('#upDesc', main).value = '';
    fileInput.value = '';

    setTimeout(() => {
      if(typeof window.renderMaterials === 'function'){
        window.renderMaterials(document.getElementById('main'));
      }
    }, 800);
  }catch(e){
    statusEl.textContent = '✗ Ошибка: ' + e.message;
    console.error('[GH]', e);
    toast('Ошибка: ' + e.message, true);
  }
}

/* -------------------- Удаление с GitHub -------------------- */
async function deleteRemoteMaterial(main, remoteId){
  if(!ghConfig || !ghConfig.token){
    return toast('Нужен GitHub-токен', true);
  }
  if(!confirm('Удалить материал из репозитория? Его увидят все, у кого открыт сайт.')) return;

  const statusEl = $('#upStatus', main);
  const folder = ghConfig.folder || 'docs';
  const idxPath = `${folder}/${GH_INDEX_FILE}`;

  try{
    statusEl.textContent = 'Удаляю…';
    const idxInfo = await ghGetFile(ghConfig, idxPath);
    if(!idxInfo) throw new Error('Индекс не найден');

    const decoded = b64DecodeUtf8(idxInfo.content.replace(/\s/g,''));
    const arr = JSON.parse(decoded);
    const entry = arr.find(x => x.id === remoteId);
    if(!entry) throw new Error('Материал не найден в индексе');

    const pdfPath = entry.file || `${folder}/${entry.filename}`;
    try{
      await ghDeleteFile(ghConfig, pdfPath, `Delete: ${entry.title}`);
    }catch(e){
      console.warn('[GH] PDF delete failed (orphaned file):', e);
    }

    const newArr = arr.filter(x => x.id !== remoteId);
    const newContent = b64EncodeUtf8(JSON.stringify(newArr, null, 2));
    await ghPutFile(ghConfig, idxPath, newContent, `Index: remove "${entry.title}"`, idxInfo.sha);

    remoteMaterials = remoteMaterials.filter(m => m._remoteId !== remoteId);

    statusEl.textContent = '✓ Удалено. Изменения применятся через 1–2 минуты.';
    toast('Удалено с GitHub');

    setTimeout(() => {
      if(typeof window.renderMaterials === 'function'){
        window.renderMaterials(document.getElementById('main'));
      }
    }, 400);
  }catch(e){
    statusEl.textContent = '✗ Ошибка удаления: ' + e.message;
    toast('Ошибка: ' + e.message, true);
  }
}

/* -------------------- Обёртка рендера -------------------- */
const _origRenderMentor = window.renderMentorUploadBlock;
window.renderMentorUploadBlock = function(){
  const base = _origRenderMentor.apply(this, arguments);
  return renderGitHubConfigBlock() + base;
};

/* -------------------- Обёртка биндинга -------------------- */
const _origBindMentor = window.bindMentorUploadBlock;
window.bindMentorUploadBlock = function(main){
  _origBindMentor.apply(this, arguments);

  bindGitHubConfigBlock(main);

  const zone = $('#upZone', main);
  const fileInput = $('#upFile', main);
  const localBtn = $('#upSubmit', main);
  if(!zone || !fileInput || !localBtn) return;

  // Копируем dropped file в fileInput.files, чтобы публикация его видела
  zone.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if(!f) return;
    try{
      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;
    }catch(err){ console.warn('[GH] DataTransfer недоступен:', err); }
  });

  // Меняем текст оригинальной кнопки и делаем её второстепенной
  localBtn.textContent = '📥 Сохранить только у меня';
  localBtn.classList.remove('primary');
  localBtn.classList.add('gh-local-btn');

  // Добавляем кнопку публикации сразу после неё
  if(!$('#upPublish', main)){
    const pubBtn = document.createElement('button');
    pubBtn.className = 'btn primary';
    pubBtn.id = 'upPublish';
    pubBtn.textContent = '📤 Опубликовать для всех';
    pubBtn.style.marginLeft = '6px';
    localBtn.parentNode.insertBefore(pubBtn, localBtn.nextSibling);
    pubBtn.onclick = () => publishMaterial(main);
  }

  // Удаление удалённых материалов
  document.querySelectorAll('[data-remdel]').forEach(el => {
    el.onclick = () => deleteRemoteMaterial(main, el.dataset.remdel);
  });
};

/* -------------------- Показать список удалённых материалов -------------------- */
const _origRenderMaterials = window.renderMaterials;
window.renderMaterials = function(main){
  _origRenderMaterials.apply(this, arguments);

  // После отрисовки добавляем блок удалённых материалов, если мы в менторском режиме
  if(!window.state || !state.mentorMode) return;

  const localCard = $('#mentorUploadCard', main);
  if(!localCard) return;
  if(!remoteMaterials.length) return;

  const block = document.createElement('div');
  block.style.marginTop = '22px';
  block.innerHTML = `
    <h3 style="font-size:14px;margin-bottom:10px">☁️ Опубликовано на GitHub (${remoteMaterials.length})</h3>
    ${remoteMaterials.map(m => `
      <div class="kv">
        <span>${m.icon} <b>${esc(m.title)}</b>
          <span class="muted" style="font-size:11.5px">· ${esc(m.tag)}</span></span>
        <button class="btn danger sm" data-remdel="${esc(m._remoteId)}">Удалить</button>
      </div>`).join('')}
  `;
  localCard.appendChild(block);

  document.querySelectorAll('[data-remdel]').forEach(el => {
    el.onclick = () => deleteRemoteMaterial(main, el.dataset.remdel);
  });
};
/* -------------------- Экспорт для использования из index.html -------------------- */
window.__ghDeleteRemote = function(remoteId, main){
  return deleteRemoteMaterial(main, remoteId);
};
window.__ghIsConfigured = function(){
  return !!(ghConfig && ghConfig.token);
};
window.__ghLoadRemoteIndex = loadRemoteIndex;
window.__ghGetRemoteMaterials = function(){ return remoteMaterials; };

/* -------------------- Автозагрузка индекса -------------------- */
(async function init(){
  await loadGitHubConfig();
  await loadRemoteIndex();
  // Перерисуем текущий экран, если уже открыт «Инфа сотка» или другая вкладка
  if(typeof window.renderMain === 'function'){
    try{ window.renderMain(); }catch(e){}
  }
})();

})();
