// 区域截图摘录 - 裁剪页逻辑
// 适用于 PDF 阅读器、受限页面及普通页面的图表/表格区域框选

const DB_NAME = 'research-clips';
const STORE = 'clips';

let shotData = null;   // { image, url, title, projects, currentProject }
let crop = null;       // 框选区域（图像像素坐标）

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

async function addClip(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- URL 侧来源识别（无 DOM 可用，走域名规则 + 文件名） ----------

const d = (s) => new RegExp(`(^|\\.)${s.replace(/\./g, '\\.')}$`);
const URL_RULES = [
  [d('cninfo.com.cn'), '巨潮资讯', '公告平台'],
  [d('sse.com.cn'), '上海证券交易所', '交易所'],
  [d('szse.cn'), '深圳证券交易所', '交易所'],
  [d('bse.cn'), '北京证券交易所', '交易所'],
  [d('stats.gov.cn'), '国家统计局', '政府网站'],
  [d('pbc.gov.cn'), '中国人民银行', '政府网站'],
  [d('gov.cn'), '政府网站', '政府网站'],
  [d('eastmoney.com'), '东方财富', '财经媒体'],
  [d('dfcfw.com'), '东方财富', '财经媒体'],
  [d('hibor.com.cn'), '慧博投研', '研报平台'],
  [d('fxbaogao.com'), '发现报告', '研报平台'],
  [d('xueqiu.com'), '雪球', '财经社区'],
  [d('10jqka.com.cn'), '同花顺', '财经媒体'],
  [d('cls.cn'), '财联社', '财经媒体'],
  [d('yicai.com'), '第一财经', '财经媒体'],
  [d('gelonghui.com'), '格隆汇', '财经媒体'],
  [d('wallstreetcn.com'), '华尔街见闻', '财经媒体'],
  [d('caixin.com'), '财新', '财经媒体'],
];

function detectSourceByUrl(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
  for (const [re, name, type] of URL_RULES) {
    if (re.test(host)) return { source: `来源：${name}`, sourceType: type };
  }
  // PDF 场景：标题通常是文件名，比域名更有信息量
  const fileName = (shotData.title || '').replace(/\.pdf$/i, '').trim();
  if (/\.pdf($|[?#])/i.test(rawUrl) && fileName) {
    return { source: `来源：${fileName}${host ? `（${host}）` : ''}`, sourceType: 'PDF文档' };
  }
  return { source: `来源：${host || '未知'}`, sourceType: host ? '网站' : '' };
}

// ---------- 框选交互 ----------

const stage = document.getElementById('stage');
const img = document.getElementById('shot');
const rectEl = document.getElementById('rect');
const btnSave = document.getElementById('btnSave');

let dragging = false;
let startX = 0;
let startY = 0;

function toImageCoords(clientX, clientY) {
  const r = img.getBoundingClientRect();
  const scaleX = img.naturalWidth / r.width;
  const scaleY = img.naturalHeight / r.height;
  return {
    x: Math.min(Math.max(clientX - r.left, 0), r.width) * scaleX,
    y: Math.min(Math.max(clientY - r.top, 0), r.height) * scaleY,
  };
}

function paintRect() {
  if (!crop) { rectEl.hidden = true; return; }
  const r = img.getBoundingClientRect();
  const scaleX = r.width / img.naturalWidth;
  const scaleY = r.height / img.naturalHeight;
  rectEl.hidden = false;
  rectEl.style.left = `${crop.x * scaleX}px`;
  rectEl.style.top = `${crop.y * scaleY}px`;
  rectEl.style.width = `${crop.w * scaleX}px`;
  rectEl.style.height = `${crop.h * scaleY}px`;
}

stage.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragging = true;
  const p = toImageCoords(e.clientX, e.clientY);
  startX = p.x;
  startY = p.y;
  crop = { x: p.x, y: p.y, w: 0, h: 0 };
  paintRect();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const p = toImageCoords(e.clientX, e.clientY);
  crop = {
    x: Math.min(startX, p.x),
    y: Math.min(startY, p.y),
    w: Math.abs(p.x - startX),
    h: Math.abs(p.y - startY),
  };
  paintRect();
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (crop && (crop.w < 8 || crop.h < 8)) crop = null; // 误触
  btnSave.disabled = !crop;
  paintRect();
});

async function cropImage() {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.w);
  canvas.height = Math.round(crop.h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// ---------- 初始化与保存 ----------

async function init() {
  const data = await chrome.storage.session.get('regionShot');
  shotData = data.regionShot;
  if (!shotData || !shotData.image) {
    document.getElementById('metaInfo').textContent = '未找到截图数据，请回到 PDF 页面重新点击扩展图标。';
    return;
  }
  img.src = shotData.image;
  img.addEventListener('load', paintRect);

  document.getElementById('project').value =
    shotData.currentProject === '默认' ? '' : shotData.currentProject;
  document.getElementById('projectList').innerHTML = (shotData.projects || [])
    .map((p) => `<option value="${p}">`)
    .join('');

  const { source, sourceType } = detectSourceByUrl(shotData.url);
  document.getElementById('metaInfo').textContent =
    `${source}${sourceType ? `（${sourceType}）` : ''} ｜ ${shotData.url}`;
}

btnSave.addEventListener('click', async () => {
  if (!crop || !shotData) return;
  btnSave.disabled = true;
  try {
    const dataUrl = await cropImage();
    const project = document.getElementById('project').value.trim() || '默认';
    const { source, sourceType } = detectSourceByUrl(shotData.url);
    await addClip({
      text: document.getElementById('text').value.trim(),
      source,
      sourceType,
      url: shotData.url,
      title: shotData.title,
      time: Date.now(),
      project,
      projects: [project],
      note: document.getElementById('note').value.trim(),
      image: dataUrl,
      imgWidth: Math.round(crop.w),
      imgHeight: Math.round(crop.h),
      seq: Date.now(),
    });
    await chrome.storage.local.set({ currentProject: project });
    await chrome.storage.session.remove('regionShot');
    document.getElementById('status').textContent = '已收录 ✓ 可关闭本页，或继续框选下一张（需重新点图标截图）';
    rectEl.hidden = true;
  } catch (e) {
    console.error(e);
    document.getElementById('status').textContent = '保存失败：' + e.message;
    btnSave.disabled = false;
  }
});

document.getElementById('btnDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

document.getElementById('btnCancel').addEventListener('click', () => {
  window.close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && crop && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    btnSave.click();
  }
});

init();
