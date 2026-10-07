// 行研底稿助手 - 内容脚本
// 职责：取选区矩形坐标与文本；识别页面来源；弹出项目选择浮层（Shadow DOM 隔离样式）

// ---------- 已知平台规则库 ----------
// name 为函数以便在匹配时现场从 DOM 提取（如公众号名）
// dom(d)：精确匹配或子域匹配，避免 endsWith 误配（如 xcls.cn 命中 cls.cn）
const dom = (d) => (h) => h === d || h.endsWith('.' + d);
const SOURCE_RULES = [
  {
    test: dom('mp.weixin.qq.com'),
    name: () => {
      const el =
        document.querySelector('#js_name') ||
        document.querySelector('.profile_nickname') ||
        document.querySelector('meta[name="author"]');
      const n = el ? (el.textContent || el.content || '').trim() : '';
      return n ? `微信公众号：${n}` : '微信公众号';
    },
    type: '微信公众号',
  },
  { test: dom('cninfo.com.cn'), name: () => '巨潮资讯', type: '公告平台' },
  { test: dom('sse.com.cn'), name: () => '上海证券交易所', type: '交易所' },
  { test: dom('szse.cn'), name: () => '深圳证券交易所', type: '交易所' },
  { test: dom('bse.cn'), name: () => '北京证券交易所', type: '交易所' },
  { test: dom('stats.gov.cn'), name: () => '国家统计局', type: '政府网站' },
  { test: dom('pbc.gov.cn'), name: () => '中国人民银行', type: '政府网站' },
  { test: (h) => h === 'www.gov.cn' || h.endsWith('.gov.cn'), name: () => fromTitle() || '中国政府网', type: '政府网站' },
  { test: (h) => dom('eastmoney.com')(h) || dom('dfcfw.com')(h), name: () => '东方财富', type: '财经媒体' },
  { test: dom('hibor.com.cn'), name: () => '慧博投研', type: '研报平台' },
  { test: dom('fxbaogao.com'), name: () => '发现报告', type: '研报平台' },
  { test: dom('199it.com'), name: () => '199IT', type: '研报平台' },
  { test: dom('xueqiu.com'), name: () => '雪球', type: '财经社区' },
  { test: dom('10jqka.com.cn'), name: () => '同花顺', type: '财经媒体' },
  { test: dom('cls.cn'), name: () => '财联社', type: '财经媒体' },
  { test: dom('yicai.com'), name: () => '第一财经', type: '财经媒体' },
  { test: dom('gelonghui.com'), name: () => '格隆汇', type: '财经媒体' },
  { test: dom('wallstreetcn.com'), name: () => '华尔街见闻', type: '财经媒体' },
  { test: dom('caixin.com'), name: () => '财新', type: '财经媒体' },
  { test: dom('stcn.com'), name: () => '证券时报', type: '财经媒体' },
  { test: dom('cnstock.com'), name: () => '上海证券报', type: '财经媒体' },
  { test: dom('zqq.com.cn'), name: () => '证券日报', type: '财经媒体' },
  { test: dom('cs.com.cn'), name: () => '中国证券报', type: '财经媒体' },
  { test: dom('zhihu.com'), name: () => '知乎', type: '社区' },
];

function getMeta(selector) {
  const el = document.querySelector(selector);
  return el && el.content ? el.content.trim() : '';
}

// 从标题后缀提取站点名，如 "xxx新闻_腾讯网" / "xxx - 公司官网"
function fromTitle() {
  const t = (document.title || '').trim();
  if (!t) return '';
  const parts = t.split(/[_|｜—–\-·]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return '';
  // 站点名习惯放在标题末尾且很短（如"_新浪财经"）；从后往前找第一段"像站点名"的：
  // 长度 ≤ 12 字、不含标点、不是纯日期/数字，避免取到文章标题的半截或日期
  for (let i = parts.length - 1; i >= 1; i--) {
    const seg = parts[i];
    if (seg.length > 12) continue;
    if (/[，。：；、？！「」『』《》]/.test(seg)) continue;
    if (/^[\d\s年月日\-\.]+$/.test(seg)) continue;
    return seg;
  }
  return '';
}

// 来源识别主流程：用户修正记忆 → 规则库 → 页面元数据 → 域名兜底
async function detectSource() {
  const hostname = location.hostname.replace(/^www\./, '');

  const { sourceMap } = await chrome.storage.local.get('sourceMap');
  if (sourceMap && sourceMap[hostname]) {
    return { name: sourceMap[hostname], type: '自定义' };
  }

  for (const rule of SOURCE_RULES) {
    if (rule.test(location.hostname)) {
      return { name: rule.name(), type: rule.type };
    }
  }

  // 注意：meta[name=author] 通常指"文章作者/编辑"而非站点名，不作为站点来源使用
  const metaName =
    getMeta('meta[property="og:site_name"]') ||
    getMeta('meta[name="application-name"]') ||
    fromTitle();
  if (metaName) return { name: metaName, type: '网站' };

  return { name: hostname, type: '网站' };
}

// ---------- 选区信息 ----------

function getSelectionInfo() {
  const sel = window.getSelection();
  const rects = [];
  let text = '';
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    text = sel.toString();
    const range = sel.getRangeAt(0);
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0) {
        rects.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
    }
  }
  return { text, rects, dpr: window.devicePixelRatio || 1 };
}

// ---------- 项目选择浮层（Shadow DOM） ----------

const DIALOG_HOST_ID = '__research_clipper_dialog__';

const DIALOG_CSS = `
  :host { all: initial; }
  .wrap {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    width: 320px; background: #fff; border-radius: 10px;
    box-shadow: 0 8px 40px rgba(0,0,0,.35);
    font: 13px/1.5 "Microsoft YaHei", "PingFang SC", sans-serif; color: #222;
    padding: 14px; box-sizing: border-box;
    animation: rc-in .18s ease-out;
  }
  @keyframes rc-in { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }
  .status { font-size: 13px; font-weight: 600; color: #2e7d32; margin-bottom: 4px; }
  .label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .proj-input {
    width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px;
    border: 1px solid #cdd2d8; border-radius: 5px; outline: none;
  }
  .proj-input:focus { border-color: #1a73e8; }
  .proj-list {
    list-style: none; margin: 6px 0 0; padding: 0; max-height: 132px; overflow-y: auto;
    border: 1px solid #eee; border-radius: 5px;
  }
  .proj-list:empty { display: none; }
  .proj-list li { padding: 6px 8px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .proj-list li:hover { background: #eef3fb; }
  .proj-list li.active { color: #1a73e8; font-weight: 600; }
  .proj-list li input { margin: 0; cursor: pointer; }
  .sel-info { font-size: 11px; color: #1a73e8; margin-top: 6px; min-height: 15px; }
  .note {
    width: 100%; box-sizing: border-box; margin-top: 8px; padding: 6px 8px;
    font-size: 12px; border: 1px solid #e3e5e8; border-radius: 5px;
    font-family: inherit; resize: none; height: 44px; outline: none;
  }
  .note:focus { border-color: #1a73e8; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .btns button {
    padding: 5px 14px; font-size: 13px; border-radius: 5px; cursor: pointer;
    border: 1px solid #cdd2d8; background: #fff;
  }
  .btns .ok { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  .hint { font-size: 11px; color: #aaa; margin-top: 6px; text-align: right; }
`;

function showClipDialog(payload) {
  // 已有浮层先移除（避免连点右键出现多个）
  const old = document.getElementById(DIALOG_HOST_ID);
  if (old) old.remove();

  const host = document.createElement('div');
  host.id = DIALOG_HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const projects = payload.projects || [];
  const selectedSet = new Set([payload.currentProject || '默认']);

  shadow.innerHTML = `
    <style>${DIALOG_CSS}</style>
    <div class="wrap">
      <div class="status">${payload.hasImage ? '已截图并高亮 ✓' : '已读取选中文字 ✓（该页无法截图）'}</div>
      <div class="label">归入项目（✅ 可勾选多个，一条摘录可同时属于多个项目）：</div>
      <input class="proj-input" placeholder="输入新项目名，回车创建">
      <ul class="proj-list"></ul>
      <div class="sel-info"></div>
      <textarea class="note" placeholder="备注（可选，导出到 Excel 的备注列）"></textarea>
      <div class="btns">
        <button class="cancel">取消 (Esc)</button>
        <button class="ok">确认收录 (Enter)</button>
      </div>
      <div class="hint">默认勾选上次项目，直接回车即可</div>
    </div>
  `;

  const input = shadow.querySelector('.proj-input');
  const listEl = shadow.querySelector('.proj-list');
  const noteEl = shadow.querySelector('.note');
  const selInfo = shadow.querySelector('.sel-info');

  function renderSelInfo() {
    const arr = [...selectedSet];
    selInfo.textContent = arr.length ? `已选 ${arr.length} 个项目：${arr.join('、')}` : '未选择项目（确认时将归入「默认」）';
  }

  function renderList() {
    const q = input.value.trim().toLowerCase();
    const matched = projects.filter((p) => !q || p.toLowerCase().includes(q));
    listEl.innerHTML = '';
    for (const p of matched) {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedSet.has(p);
      const span = document.createElement('span');
      span.textContent = p;
      if (selectedSet.has(p)) li.classList.add('active');
      const toggle = () => {
        if (cb.checked) selectedSet.add(p);
        else selectedSet.delete(p);
        renderList();
        renderSelInfo();
      };
      cb.addEventListener('change', toggle);
      li.addEventListener('click', (e) => {
        if (e.target === cb) return;
        cb.checked = !cb.checked;
        toggle();
      });
      li.appendChild(cb);
      li.appendChild(span);
      listEl.appendChild(li);
    }
  }
  renderList();
  renderSelInfo();

  input.addEventListener('input', renderList);

  function cleanup() { host.remove(); }

  function confirm() {
    const arr = [...selectedSet];
    chrome.runtime.sendMessage({
      type: 'CLIP_DIALOG_RESULT',
      action: 'confirm',
      projects: arr.length ? arr : ['默认'],
      note: noteEl.value,
    });
    cleanup();
  }

  function cancel() {
    chrome.runtime.sendMessage({ type: 'CLIP_DIALOG_RESULT', action: 'cancel' });
    cleanup();
  }

  shadow.querySelector('.ok').addEventListener('click', confirm);
  shadow.querySelector('.cancel').addEventListener('click', cancel);

  // 键盘：输入框有内容时 Enter=创建新项目；输入框为空时 Enter=确认收录；Esc 取消
  host.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key !== 'Enter' || e.target === noteEl) return;
    e.preventDefault();
    const newName = input.value.trim();
    if (e.target === input && newName) {
      selectedSet.add(newName);
      input.value = '';
      renderList();
      renderSelInfo();
    } else {
      confirm();
    }
  });

  document.documentElement.appendChild(host);
  input.focus();
}

// ---------- 消息入口 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'GET_SELECTION_INFO') {
    (async () => {
      const info = getSelectionInfo();
      const source = await detectSource();
      sendResponse({
        ...info,
        sourceName: `来源：${source.name}`,
        sourceType: source.type,
      });
    })();
    return true; // 异步 sendResponse
  }

  if (msg.type === 'SHOW_CLIP_DIALOG') {
    try {
      showClipDialog(msg);
      sendResponse({ shown: true });
    } catch (e) {
      console.error('浮层弹出失败：', e);
      sendResponse({ shown: false });
    }
    return false;
  }
});
