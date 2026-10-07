// 行研底稿助手 - Service Worker
// 职责：右键菜单 → 截屏+高亮合成 → 通知页面弹出项目选择浮层 → 确认后写 IndexedDB

const MENU_ID = 'clip-to-draft';
const REGION_MENU_ID = 'clip-region';
const DB_NAME = 'research-clips';
const STORE = 'clips';

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

async function listProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => {
      const set = new Set();
      for (const r of req.result || []) {
        if (Array.isArray(r.projects) && r.projects.length) r.projects.forEach((p) => set.add(p));
        else set.add(r.project || '默认');
      }
      resolve([...set]);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------- 图片合成 ----------

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// 在可视页面截图上叠加选区高亮（半透明黄色荧光笔效果）
// rects 为 CSS 像素坐标，需乘 devicePixelRatio 映射到截图像素
async function composeImage(dataUrl, rects, dpr) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  ctx.fillStyle = 'rgba(255, 213, 0, 0.35)';
  for (const r of rects) {
    ctx.fillRect(r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
  }
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return {
    dataUrl: await blobToDataUrl(out),
    width: bmp.width / dpr,   // 转回 CSS 像素，供 Excel 导出时计算尺寸
    height: bmp.height / dpr,
  };
}

async function measureImage(dataUrl, dpr) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  return { width: bmp.width / dpr, height: bmp.height / dpr };
}

// ---------- 角标反馈 ----------

async function flashBadge(tabId, text, color, ms) {
  await chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }, ms);
}

// ---------- 右键菜单主流程 ----------

// 探测页面里的内容脚本是否存活；不在则现场注入再试
// （扩展安装/重载前已打开的标签页没有注入脚本，这是"不弹浮层直接入库"的主因）
async function ensureContentScript(tabId) {
  const alive = await chrome.tabs
    .sendMessage(tabId, { type: 'PING' })
    .then(() => true)
    .catch(() => false);
  if (alive) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs
      .sendMessage(tabId, { type: 'PING' })
      .then(() => true)
      .catch(() => false);
  } catch (e) {
    return false; // 真正禁止注入的页面（Chrome 商店、PDF 阅读器等）
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '加入数据底稿',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: REGION_MENU_ID,
    title: '区域截图摘录（框选页面区域入库）',
    contexts: ['page', 'image'],
  });
});

// 点图标分流：
// 1) URL 以 .pdf 结尾 → 一律区域截图摘录（不靠注入探测，PDF 阅读器的注入行为各版本不一致）
// 2) 普通网页 → 打开面板（脚本缺失时自动补注入）
// 3) 其他禁注入页面（chrome://、Chrome 商店）→ 区域截图摘录
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  if (/\.pdf($|[?#])/i.test(tab.url || '')) {
    await startRegionClip(tab);
    return;
  }
  const reachable = await ensureContentScript(tab.id);
  if (reachable) {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  } else {
    await startRegionClip(tab);
  }
});

async function startRegionClip(tab) {
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    const projects = await listProjects().catch(() => []);
    const { currentProject } = await chrome.storage.local.get('currentProject');
    await chrome.storage.session.set({
      regionShot: {
        image: shot,
        url: tab.url || '',
        title: tab.title || '',
        projects,
        currentProject: currentProject || '默认',
      },
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL('cropper.html') });
  } catch (e) {
    console.error('区域截图失败：', e);
    await flashBadge(tab.id, '!', '#c62828', 2000);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === REGION_MENU_ID && tab && tab.id) {
    await startRegionClip(tab);
    return;
  }
  if (info.menuItemId !== MENU_ID || !tab || !tab.id) return;
  const tabId = tab.id;
  try {
    // 1. 确保内容脚本在线（老标签页自动补注入），再取选区坐标、选中文本、来源识别结果
    const scriptReady = await ensureContentScript(tabId);
    const selInfo = scriptReady
      ? await chrome.tabs.sendMessage(tabId, { type: 'GET_SELECTION_INFO' }).catch(() => null)
      : null;

    // 2. 先截屏并合成高亮（必须在浮层弹出之前完成，否则浮层会被截进图里）
    let image = null;
    let imgWidth = 0;
    let imgHeight = 0;
    try {
      const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
      const dpr = (selInfo && selInfo.dpr) || 1;
      if (selInfo && selInfo.rects && selInfo.rects.length > 0) {
        const composed = await composeImage(shot, selInfo.rects, dpr);
        image = composed.dataUrl;
        imgWidth = composed.width;
        imgHeight = composed.height;
      } else {
        const dims = await measureImage(shot, dpr);
        image = shot;
        imgWidth = dims.width;
        imgHeight = dims.height;
      }
    } catch (e) {
      console.warn('截图失败，仅保存文字：', e);
    }

    const pending = {
      text: ((selInfo && selInfo.text) || info.selectionText || '').trim(),
      source: (selInfo && selInfo.sourceName) || '',
      sourceType: (selInfo && selInfo.sourceType) || '',
      url: tab.url || info.pageUrl || '',
      title: tab.title || '',
      time: Date.now(),
      image,
      imgWidth,
      imgHeight,
      seq: Date.now(),
    };

    // 3. 暂存待写数据（storage.session 在 Service Worker 休眠后仍保留），再通知页面弹浮层
    const { currentProject } = await chrome.storage.local.get('currentProject');
    const projects = await listProjects().catch(() => []);
    await chrome.storage.session.set({ [`pending_${tabId}`]: pending });

    const dialogShown = scriptReady
      ? await chrome.tabs
          .sendMessage(tabId, {
            type: 'SHOW_CLIP_DIALOG',
            text: pending.text,
            hasImage: !!image,
            projects,
            currentProject: currentProject || '默认',
          })
          .then((res) => !!(res && res.shown))
          .catch(() => false)
      : false;

    // 4. 真正无法弹浮层的页面（禁止注入）：直接按当前项目写库
    if (!dialogShown) {
      const proj = currentProject || '默认';
      await chrome.storage.session.remove(`pending_${tabId}`);
      await addClip({ ...pending, project: proj, projects: [proj], note: '' });
      await flashBadge(tabId, '✓', '#2e7d32', 1500);
    }
  } catch (e) {
    console.error('摘录失败：', e);
    await flashBadge(tabId, '!', '#c62828', 2000);
  }
});

// ---------- 浮层结果回传 ----------

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'CLIP_DIALOG_RESULT') return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;

  (async () => {
    const key = `pending_${tabId}`;
    const data = await chrome.storage.session.get(key);
    const pending = data[key];
    await chrome.storage.session.remove(key);
    if (!pending) return;

    if (msg.action === 'confirm') {
      const projects = Array.isArray(msg.projects) && msg.projects.length
        ? msg.projects.map((p) => String(p).trim()).filter(Boolean)
        : ['默认'];
      // project 字段保留首个项目以兼容旧数据读取；projects 数组承载多项目
      await addClip({ ...pending, project: projects[0], projects, note: (msg.note || '').trim() });
      await chrome.storage.local.set({ currentProject: projects[0] }); // 记住上次项目
      await flashBadge(tabId, '✓', '#2e7d32', 1500);
    }
    // action === 'cancel'：丢弃 pending，不写库
  })().catch((e) => console.error('写入失败：', e));
});
