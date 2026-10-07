// 行研底稿助手 - 底稿面板逻辑（Tab 结构：摘录列表 / 项目知识库 / 设置）

const DB_NAME = 'research-clips';
const STORE = 'clips';

let items = [];        // 全部记录（seq 升序）
let checked = new Set();
let filterProject = '';
let searchText = '';
let dragId = null;
let currentKbProject = null; // 知识库视图当前选中的项目

// ---------- IndexedDB ----------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('seq', 'seq', { unique: false });
      store.createIndex('project', 'project', { unique: false });
      store.createIndex('time', 'time', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(ids) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- 工具 ----------

function formatTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// 一条摘录可属于多个项目；兼容旧数据（仅有 project 单值字段）
function clipProjects(it) {
  if (Array.isArray(it.projects) && it.projects.length) return it.projects;
  return [it.project || '默认'];
}

function allProjectNames() {
  const set = new Set();
  for (const i of items) for (const p of clipProjects(i)) set.add(p);
  return [...set];
}

function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Tab 切换 ----------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
    const view = document.getElementById(`view-${btn.dataset.view}`);
    view.hidden = false;
    if (btn.dataset.view === 'kb') renderKbProjectList();
    if (btn.dataset.view === 'settings') renderSourceMap();
  });
});

// ---------- 摘录列表视图 ----------

function visibleItems() {
  let list = items;
  if (filterProject) list = list.filter((i) => clipProjects(i).includes(filterProject));
  if (searchText) {
    const q = searchText.toLowerCase();
    list = list.filter((i) =>
      (i.text || '').toLowerCase().includes(q) ||
      (i.source || '').toLowerCase().includes(q) ||
      (i.url || '').toLowerCase().includes(q) ||
      (i.title || '').toLowerCase().includes(q)
    );
  }
  return list.slice().reverse(); // 最新在最上
}

function render() {
  const listEl = document.getElementById('list');
  const visible = visibleItems();
  document.getElementById('empty').hidden = items.length > 0;
  document.getElementById('stats').textContent =
    `共 ${items.length} 条，当前显示 ${visible.length} 条，已勾选 ${checked.size} 条` +
    (filterProject || searchText ? '（筛选状态下不可拖拽排序）' : '');

  const canDrag = !filterProject && !searchText;
  listEl.innerHTML = '';

  for (const it of visible) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = it.id;

    const imgHtml = it.image
      ? `<img src="${it.image}" alt="截图">`
      : `<div class="no-img">无截图（该页禁止截屏）</div>`;

    card.innerHTML = `
      <input type="checkbox" class="check" ${checked.has(it.id) ? 'checked' : ''}>
      <span class="drag-handle" title="拖拽排序" ${canDrag ? 'draggable="true"' : 'style="opacity:.3"'}>☰</span>
      <div class="thumb">${imgHtml}</div>
      <div class="body">
        <div class="text">${escapeHtml(it.text)}</div>
        <div class="meta">
          <input class="source-edit" value="${escapeHtml(it.source || '')}" title="点击可修正来源；修正后同域名自动套用">
          ${it.sourceType ? `<span class="badge">${escapeHtml(it.sourceType)}</span>` : ''}
          ${clipProjects(it).map((p) => `<span class="project-tag">${escapeHtml(p)}</span>`).join('')}
          <a href="${escapeHtml(it.url)}" target="_blank">${escapeHtml(it.url)}</a>
          <span>${formatTime(it.time)}</span>
        </div>
        <textarea class="note" placeholder="备注（导出到 Excel 的备注列）">${escapeHtml(it.note || '')}</textarea>
      </div>
    `;

    // 勾选
    card.querySelector('.check').addEventListener('change', (e) => {
      e.target.checked ? checked.add(it.id) : checked.delete(it.id);
      render();
    });

    // 备注保存
    card.querySelector('.note').addEventListener('change', async (e) => {
      it.note = e.target.value;
      await dbPut(it);
    });

    // 来源修正 + 记忆域名映射；随后提示同域名旧记录批量统一
    card.querySelector('.source-edit').addEventListener('change', async (e) => {
      const v = e.target.value.trim();
      if (!v || v === it.source) return;
      it.source = v.startsWith('来源：') ? v : `来源：${v}`;
      e.target.value = it.source;
      await dbPut(it);
      const host = hostOf(it.url);
      if (host) {
        const { sourceMap } = await chrome.storage.local.get('sourceMap');
        const map = sourceMap || {};
        map[host] = it.source.replace(/^来源：/, '');
        await chrome.storage.local.set({ sourceMap: map });

        // 同域名旧记录批量统一
        const siblings = items.filter((x) => x.id !== it.id && hostOf(x.url) === host && x.source !== it.source);
        if (siblings.length && confirm(`将 ${host} 域名下的另外 ${siblings.length} 条记录来源统一为「${it.source}」？`)) {
          for (const x of siblings) { x.source = it.source; await dbPut(x); }
        }
        render();
      }
    });

    // 缩略图放大
    const thumb = card.querySelector('.thumb');
    if (it.image) {
      thumb.addEventListener('click', () => {
        document.getElementById('lightboxImg').src = it.image;
        document.getElementById('lightbox').hidden = false;
      });
    }

    // 拖拽排序
    const handle = card.querySelector('.drag-handle');
    if (canDrag) {
      handle.addEventListener('dragstart', () => {
        dragId = it.id;
        card.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        dragId = null;
      });
      card.addEventListener('dragover', (e) => e.preventDefault());
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (dragId == null || dragId === it.id) return;
        const from = items.findIndex((x) => x.id === dragId);
        const to = items.findIndex((x) => x.id === it.id);
        if (from < 0 || to < 0) return;
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        // 重排 seq 并落库
        for (let i = 0; i < items.length; i++) items[i].seq = i;
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const x of items) store.put(x);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        render();
      });
    }

    listEl.appendChild(card);
  }
}

function refreshProjectControls() {
  const projects = allProjectNames();
  const filter = document.getElementById('filterProject');
  const cur = filter.value;
  filter.innerHTML = '<option value="">全部项目</option>' +
    projects.map((p) => `<option ${p === cur ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
  document.getElementById('projectList').innerHTML =
    projects.map((p) => `<option value="${escapeHtml(p)}">`).join('');
}

// ---------- 导出 Excel ----------

function selectedItems() {
  return items.filter((i) => checked.has(i.id)); // items 为 seq 升序，导出顺序与之相同
}

async function exportXlsx(list) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('底稿');
  ws.columns = [
    { header: '截图', key: 'img', width: 82 },
    { header: '摘录内容', key: 'text', width: 50 },
    { header: '来源', key: 'source', width: 24 },
    { header: '网址', key: 'url', width: 42 },
    { header: '时间', key: 'time', width: 20 },
    { header: '备注', key: 'note', width: 24 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const MAX_IMG_W = 560; // 截图列宽约 574px，留边距

  for (const it of list) {
    const row = ws.addRow({
      img: '',
      text: it.text,
      source: it.source,
      url: { text: it.url, hyperlink: it.url },
      time: formatTime(it.time),
      note: it.note || '',
    });
    for (const key of ['text', 'source', 'url', 'time', 'note']) {
      row.getCell(key).alignment = { wrapText: true, vertical: 'top' };
    }

    if (it.image) {
      let w = it.imgWidth || MAX_IMG_W;
      let h = it.imgHeight || 315;
      if (w > MAX_IMG_W) { h = (h * MAX_IMG_W) / w; w = MAX_IMG_W; }
      const imgId = wb.addImage({
        base64: it.image.replace(/^data:image\/\w+;base64,/, ''),
        extension: it.image.startsWith('data:image/png') ? 'png' : 'jpeg', // 新旧数据混存
      });
      ws.addImage(imgId, {
        tl: { col: 0, row: row.number - 1 },
        ext: { width: w, height: h },
      });
      row.height = h * 0.75 + 8; // px → pt，外加留白
    } else {
      row.height = 60;
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const a = document.createElement('a');
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const proj = filterProject || '全部';
  a.href = URL.createObjectURL(blob);
  a.download = `底稿_${proj}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 摘录列表事件 ----------

async function reload() {
  items = await dbGetAll();
  items.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  checked = new Set([...checked].filter((id) => items.some((i) => i.id === id)));
  refreshProjectControls();
  render();
}

document.addEventListener('DOMContentLoaded', async () => {
  const { currentProject } = await chrome.storage.local.get('currentProject');
  document.getElementById('currentProject').value = currentProject || '';
  await reload();
});

document.getElementById('currentProject').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ currentProject: e.target.value.trim() || '默认' });
});

document.getElementById('filterProject').addEventListener('change', (e) => {
  filterProject = e.target.value;
  render();
});

document.getElementById('search').addEventListener('input', (e) => {
  searchText = e.target.value.trim();
  render();
});

document.getElementById('selectAll').addEventListener('change', (e) => {
  if (e.target.checked) visibleItems().forEach((i) => checked.add(i.id));
  else checked.clear();
  render();
});

document.getElementById('btnExport').addEventListener('click', async () => {
  const list = selectedItems();
  if (!list.length) { alert('请先勾选要导出的条目'); return; }
  try {
    await exportXlsx(list);
  } catch (e) {
    console.error(e);
    alert('导出失败：' + e.message);
  }
});

document.getElementById('btnDelete').addEventListener('click', async () => {
  const list = selectedItems();
  if (!list.length) { alert('请先勾选要删除的条目'); return; }
  if (!confirm(`确定删除选中的 ${list.length} 条？此操作不可恢复。`)) return;
  await dbDelete([...checked]);
  checked.clear();
  await reload();
});

document.getElementById('btnAssign').addEventListener('click', async () => {
  const list = selectedItems();
  if (!list.length) { alert('请先勾选条目'); return; }
  const name = prompt('将选中条目归入项目：', filterProject || '');
  if (name == null) return;
  const project = name.trim() || '默认';
  for (const it of list) { it.project = project; it.projects = [project]; await dbPut(it); }
  refreshProjectControls();
  render();
});

document.getElementById('lightbox').addEventListener('click', () => {
  document.getElementById('lightbox').hidden = true;
});

// ---------- 项目知识库视图 ----------

async function getOutlines() {
  const { outlines } = await chrome.storage.local.get('outlines');
  return outlines || {};
}

async function saveOutline(project, text) {
  const outlines = await getOutlines();
  if (text.trim()) outlines[project] = text;
  else delete outlines[project];
  await chrome.storage.local.set({ outlines });
}

function kbProjectClips() {
  if (!currentKbProject) return [];
  return items.filter((i) => clipProjects(i).includes(currentKbProject)); // seq 升序
}

function renderKbProjectList() {
  const ul = document.getElementById('kbProjectList');
  const projects = allProjectNames();
  if (!currentKbProject || !projects.includes(currentKbProject)) {
    currentKbProject = projects[0] || null;
  }
  ul.innerHTML = '';
  if (!projects.length) {
    ul.innerHTML = '<li class="kb-empty">还没有项目</li>';
  }
  for (const p of projects) {
    const count = items.filter((i) => clipProjects(i).includes(p)).length;
    const li = document.createElement('li');
    li.className = p === currentKbProject ? 'active' : '';
    li.innerHTML = `<span class="kb-name">${escapeHtml(p)}</span><span class="kb-num">${count}</span>`;
    li.addEventListener('click', () => {
      currentKbProject = p;
      renderKbProjectList();
      loadKbOutline();
    });
    ul.appendChild(li);
  }
  loadKbOutline();
  document.getElementById('kbClipCount').textContent =
    currentKbProject ? `「${currentKbProject}」共 ${kbProjectClips().length} 条摘录` : '';
}

async function loadKbOutline() {
  const ta = document.getElementById('kbOutline');
  if (!currentKbProject) { ta.value = ''; return; }
  const outlines = await getOutlines();
  ta.value = outlines[currentKbProject] || '';
}

let kbSaveTimer = null;
document.getElementById('kbOutline').addEventListener('input', (e) => {
  if (!currentKbProject) return;
  clearTimeout(kbSaveTimer);
  const project = currentKbProject;
  const text = e.target.value;
  kbSaveTimer = setTimeout(() => saveOutline(project, text), 500);
});

async function exportKbMarkdown() {
  if (!currentKbProject) { alert('请先选择项目'); return; }
  const clips = kbProjectClips();
  if (!clips.length) { alert('该项目下没有摘录'); return; }
  const outline = document.getElementById('kbOutline').value.trim();

  const lines = [];
  lines.push(`# ${currentKbProject} · 项目知识库`);
  lines.push('');
  lines.push(`> 由「行研底稿助手」导出，共 ${clips.length} 条人工精选素材。导出时间：${formatTime(Date.now())}`);
  lines.push('');
  lines.push('## 作者核心观点与报告大纲');
  lines.push('');
  lines.push(outline || '（未填写）');
  lines.push('');
  lines.push('## 精选素材');
  lines.push('');
  clips.forEach((it, idx) => {
    lines.push(`### ${idx + 1}. ${it.title || '未命名页面'}`);
    lines.push('');
    lines.push(`- 来源：${it.source || '未知'}${it.sourceType ? `（${it.sourceType}）` : ''}`);
    lines.push(`- 网址：${it.url}`);
    lines.push(`- 摘录时间：${formatTime(it.time)}`);
    if (it.note) lines.push(`- 作者批注：${it.note}`);
    lines.push('');
    lines.push('> ' + (it.text || '').split('\n').join('\n> '));
    lines.push('');
  });

  downloadText(`知识库_${currentKbProject}_${Date.now()}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
}

async function exportKbJson() {
  if (!currentKbProject) { alert('请先选择项目'); return; }
  const clips = kbProjectClips();
  if (!clips.length) { alert('该项目下没有摘录'); return; }
  const outline = document.getElementById('kbOutline').value.trim();

  const data = {
    project: currentKbProject,
    outline,
    exportedAt: new Date().toISOString(),
    clipCount: clips.length,
    clips: clips.map((it) => ({
      id: it.id,
      text: it.text,
      note: it.note || '',
      source: it.source || '',
      sourceType: it.sourceType || '',
      url: it.url,
      pageTitle: it.title || '',
      clippedAt: formatTime(it.time),
      hasScreenshot: !!it.image, // 截图本体留在面板中，导出文件不含图片
    })),
  };
  downloadText(
    `知识库_${currentKbProject}_${Date.now()}.json`,
    JSON.stringify(data, null, 2),
    'application/json;charset=utf-8'
  );
}

document.getElementById('btnKbMd').addEventListener('click', exportKbMarkdown);
document.getElementById('btnKbJson').addEventListener('click', exportKbJson);

// ---------- 设置视图：来源记忆管理 ----------

async function renderSourceMap() {
  const { sourceMap } = await chrome.storage.local.get('sourceMap');
  const map = sourceMap || {};
  const body = document.getElementById('smBody');
  const hosts = Object.keys(map).sort();
  body.innerHTML = '';
  if (!hosts.length) {
    body.innerHTML = '<tr><td colspan="3" class="sm-empty">还没有记忆。在卡片上手动修改来源后会自动记住。</td></tr>';
    return;
  }
  for (const host of hosts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(host)}</td><td>${escapeHtml(map[host])}</td><td><button class="del">删除</button></td>`;
    tr.querySelector('.del').addEventListener('click', async () => {
      const data = await chrome.storage.local.get('sourceMap');
      const m = data.sourceMap || {};
      delete m[host];
      await chrome.storage.local.set({ sourceMap: m });
      renderSourceMap();
    });
    body.appendChild(tr);
  }
}


// ---------- 数据备份与恢复 ----------

const BACKUP_TAG = 'research-clipper-backup';

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

document.getElementById('btnBackup').addEventListener('click', async () => {
  const status = document.getElementById('backupStatus');
  try {
    const clips = await dbGetAll();
    const settings = await chrome.storage.local.get(['sourceMap', 'outlines', 'currentProject']);
    const data = {
      app: BACKUP_TAG,
      version: 1,
      exportedAt: new Date().toISOString(),
      clipCount: clips.length,
      clips,
      settings,
    };
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
    downloadText(`行研底稿备份_${stamp}.json`, JSON.stringify(data), 'application/json;charset=utf-8');
    status.textContent = `已导出备份：${clips.length} 条摘录 + 来源记忆 + 项目大纲`;
  } catch (e) {
    console.error(e);
    status.textContent = '备份失败：' + e.message;
  }
});

let restoreMode = 'merge';
const restoreFileInput = document.getElementById('restoreFile');

document.getElementById('btnRestoreMerge').addEventListener('click', () => {
  restoreMode = 'merge';
  restoreFileInput.value = '';
  restoreFileInput.click();
});

document.getElementById('btnRestoreReplace').addEventListener('click', () => {
  restoreMode = 'replace';
  restoreFileInput.value = '';
  restoreFileInput.click();
});

restoreFileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const status = document.getElementById('backupStatus');

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    status.textContent = '恢复失败：文件不是有效的 JSON';
    return;
  }
  if (!data || data.app !== BACKUP_TAG || !Array.isArray(data.clips)) {
    status.textContent = '恢复失败：不是本插件的备份文件';
    return;
  }

  const when = data.exportedAt ? formatTime(new Date(data.exportedAt).getTime()) : '未知时间';
  const modeText = restoreMode === 'replace'
    ? '将【清空现有全部数据】后恢复到备份时点'
    : '将与现有数据【合并】，重复的条目会被跳过';
  if (!confirm(`备份包含 ${data.clips.length} 条摘录（导出于 ${when}）。\n${modeText}，是否继续？`)) return;

  try {
    if (restoreMode === 'replace') {
      await dbClear();
      for (const clip of data.clips) await dbPut(clip);
      // 设置整体覆盖
      if (data.settings) {
        await chrome.storage.local.set({
          sourceMap: data.settings.sourceMap || {},
          outlines: data.settings.outlines || {},
          currentProject: data.settings.currentProject || '默认',
        });
      }
      status.textContent = `已清空重建：恢复 ${data.clips.length} 条摘录`;
    } else {
      const existingIds = new Set(items.map((i) => i.id));
      let added = 0;
      for (const clip of data.clips) {
        if (existingIds.has(clip.id)) continue;
        await dbPut(clip);
        added++;
      }
      // 设置：以现有为准，补充备份里多出来的键
      if (data.settings) {
        const cur = await chrome.storage.local.get(['sourceMap', 'outlines']);
        await chrome.storage.local.set({
          sourceMap: Object.assign({}, data.settings.sourceMap, cur.sourceMap),
          outlines: Object.assign({}, data.settings.outlines, cur.outlines),
        });
      }
      status.textContent = `合并完成：新增 ${added} 条，跳过重复 ${data.clips.length - added} 条`;
    }
    await reload();
  } catch (err) {
    console.error(err);
    status.textContent = '恢复失败：' + err.message;
  }
});


// ---------- 清空全部摘录 ----------

document.getElementById('btnWipe').addEventListener('click', async () => {
  if (!items.length) { alert('当前没有数据'); return; }
  if (!confirm(`确定清空全部 ${items.length} 条摘录（含截图）？\n此操作不可恢复，建议先点「备份全部数据」。`)) return;
  if (!confirm('再次确认：删除后无法找回。仍要清空？')) return;
  try {
    await dbClear();
    checked.clear();
    await reload();
    document.getElementById('backupStatus').textContent = '已清空全部摘录数据';
  } catch (e) {
    console.error(e);
    document.getElementById('backupStatus').textContent = '清空失败：' + e.message;
  }
});
