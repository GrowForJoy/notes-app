/* ==========================================================================
   学习笔记 · 逻辑
   笔记保存在你自己的 GitHub 私有仓库里，浏览器通过 Contents API 直接读写。
   ========================================================================== */

'use strict';

const API = 'https://api.github.com';
const CFG_KEY = 'gnote.config.v1';
const CACHE_KEY = 'gnote.cache.v1';
const DRAFT_KEY = 'gnote.draft.v1';
const THEME_KEY = 'gnote.theme';

const els = {};
let cfg = { owner: '', repo: '', token: '', branch: '' };
let cache = { owner: '', repo: '', files: {} };
let notes = [];
let activePath = null;
let query = '';
let editorMode = null;
let draftTimer = null;
let toastTimer = null;

/* ---------------------------------------------------------------- 小工具 */

function cacheDom() {
  [
    'menuBtn', 'sidebar', 'searchInput', 'statusChip', 'statusDot', 'statusText',
    'newNoteBtn', 'themeBtn', 'settingsBtn', 'noteCount', 'noteList', 'refreshBtn',
    'reader', 'noteTitle', 'noteMeta', 'markdownBody', 'editBtn', 'deleteBtn',
    'editor', 'editorPath', 'editorBody', 'cancelEditBtn', 'saveBtn',
    'toolbar', 'editorPanes', 'editorPreview', 'previewToggleBtn', 'editorStat', 'imageInput',
    'emptyState', 'emptySetupBtn', 'scrim', 'settingsModal', 'closeSettingsBtn',
    'cfgOwner', 'cfgRepo', 'cfgToken', 'cfgBranch', 'cfgError',
    'testConnBtn', 'clearCfgBtn', 'saveCfgBtn', 'toast', 'main',
    'hljsLight', 'hljsDark'
  ].forEach(id => { els[id] = document.getElementById(id); });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Uint8Array → base64；图片这类二进制内容也走这里 */
function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function textToB64(str) {
  return bytesToB64(new TextEncoder().encode(str));
}

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function deriveTitle(path, text) {
  const m = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(text || '');
  if (m) return m[1].trim();
  return path.split('/').pop().replace(/\.md$/i, '');
}

function messageFor(status, data) {
  const detail = data && data.message ? data.message : '';
  if (status === 401) return '令牌无效或已过期（401）';
  if (status === 403) return '权限不足或访问太频繁（403）';
  if (status === 404) return '看不到这个仓库（404）：核对用户名、仓库名，以及令牌是否勾选了这个仓库';
  if (status === 409) return '远端已经有了新的改动，请先刷新再改（409）';
  if (status === 422) return '提交被拒绝（422）';
  return '请求失败 ' + status + (detail ? '：' + detail : '');
}

function setStatus(state, text) {
  els.statusChip.dataset.state = state;
  els.statusText.textContent = text;
}

function toast(msg, ms = 2800) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

/* ------------------------------------------------------------ GitHub API */

async function gh(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'Bearer ' + cfg.token,
      ...(options.headers || {})
    }
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 直接取回 Markdown 原文（避免 base64 解码与大小限制） */
async function fetchRaw(path) {
  const url = API + `/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(path)}`
    + (cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '');
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      Authorization: 'Bearer ' + cfg.token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/** 远端某个路径当前的 sha；不存在返回 null */
async function remoteSha(path) {
  try {
    const url = `/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(path)}`
      + (cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '');
    const c = await gh(url);
    return c && c.sha ? c.sha : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function runLimited(items, limit, worker) {
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const cur = items[i++];
      await worker(cur);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------- 配置存储 */

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
  } catch (e) { /* 忽略损坏的配置 */ }
}

function persistConfig() {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

function hasConfig() {
  return !!(cfg.owner && cfg.repo && cfg.token);
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c.owner === cfg.owner && c.repo === cfg.repo) cache = c;
    }
  } catch (e) { /* 忽略 */ }
  if (!cache.files) cache.files = {};
}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) { /* 超出配额就放弃缓存，不影响使用 */ }
}

/* --------------------------------------------------------------- 读取笔记 */

async function loadNotes(opts = {}) {
  if (!hasConfig()) {
    setStatus('idle', '未连接');
    showEmpty();
    return;
  }
  if (!opts.silent) setStatus('busy', '读取中');

  try {
    const info = await gh(`/repos/${cfg.owner}/${cfg.repo}`);
    if (!cfg.branch) {
      cfg.branch = info.default_branch || 'main';
      persistConfig();
    }

    const tree = await gh(
      `/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`
    );
    const blobs = (tree.tree || []).filter(n =>
      n.type === 'blob' && /\.md$/i.test(n.path) && !/^\./.test(n.path)
    );

    cache.owner = cfg.owner;
    cache.repo = cfg.repo;

    const next = {};
    const pending = [];
    for (const b of blobs) {
      const hit = cache.files[b.path];
      if (hit && hit.sha === b.sha) next[b.path] = hit;
      else { next[b.path] = { sha: b.sha, text: '' }; pending.push(b); }
    }

    await runLimited(pending, 6, async b => {
      const text = await fetchRaw(b.path);
      next[b.path] = { sha: b.sha, text };
    });

    cache.files = next;
    persistCache();

    notes = Object.keys(next)
      .map(p => ({ path: p, sha: next[p].sha, text: next[p].text, title: deriveTitle(p, next[p].text) }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));

    renderList();

    if (activePath && notes.some(n => n.path === activePath)) selectNote(activePath);
    else if (notes.length) selectNote(notes[0].path);
    else { activePath = null; showEmpty(); }

    setStatus('ok', '已连接 ' + notes.length + ' 篇');
  } catch (err) {
    setStatus('error', err.message || '读取失败');
    toast(err.message || '读取失败，请检查设置');
    if (!notes.length) showEmpty();
  }
}

/* --------------------------------------------------------------- 列表渲染 */

function renderList() {
  const q = query.trim().toLowerCase();
  const matches = notes.filter(n =>
    !q || n.path.toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q)
  );

  els.noteCount.textContent = String(matches.length);
  els.noteList.innerHTML = '';

  if (!matches.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = notes.length
      ? '没有匹配的笔记。'
      : '仓库里还没有 .md 笔记，点右上角的 ＋ 新建一篇。';
    els.noteList.appendChild(p);
    return;
  }

  const groups = new Map();
  for (const n of matches) {
    const seg = n.path.includes('/') ? n.path.split('/')[0] : '';
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg).push(n);
  }

  let idx = 0;
  for (const [seg, items] of groups) {
    if (seg) {
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = seg;
      els.noteList.appendChild(h);
    }
    for (const n of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'note-item' + (n.path === activePath ? ' is-active' : '');
      btn.style.animationDelay = Math.min(idx++ * 14, 220) + 'ms';

      const name = document.createElement('span');
      name.className = 'name';
      name.innerHTML = q
        ? escapeHtml(n.title || n.path).replace(
            new RegExp('(' + escapeRegExp(escapeHtml(q)) + ')', 'gi'),
            '<mark>$1</mark>'
          )
        : escapeHtml(n.title || n.path);

      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = seg ? n.path.slice(seg.length + 1) : n.path;

      btn.append(name, path);
      btn.addEventListener('click', () => { selectNote(n.path); closeDrawer(); });
      els.noteList.appendChild(btn);
    }
  }
}

/* --------------------------------------------------------------- 阅读视图 */

/* 让 Markdown 支持 ==高亮== 语法 */
function setupMarked() {
  if (!window.marked) return;
  marked.use({
    extensions: [{
      name: 'mark',
      level: 'inline',
      start(src) { return src.indexOf('=='); },
      tokenizer(src) {
        const m = /^==(?!=)([\s\S]+?)==/.exec(src);
        if (!m) return undefined;
        const body = m[1].trim();
        return { type: 'mark', raw: m[0], text: body, tokens: this.lexer.inlineTokens(body) };
      },
      renderer(token) {
        return '<mark>' + this.parser.parseInline(token.tokens) + '</mark>';
      }
    }]
  });
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    marked.setOptions({ gfm: true, breaks: true });
    return DOMPurify.sanitize(marked.parse(text || ''));
  }
  return '<pre>' + escapeHtml(text || '') + '</pre>';
}

/* ------------------------------------------------------- 说明区 ⇄ 代码区联动 */
/* 笔记里用 ```terms 代码块写「关键字 = 说明」，渲染成术语卡片；
   代码块里出现的关键字会带徽章，悬停看说明、点击跳到对应条目。 */

const KW_SKIP = '.hljs-comment,.hljs-quote,.hljs-string,.hljs-regexp,.hljs-meta,.hljs-doctag,.terms-card,.kw,.code-copy';

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

/** 把 ```terms 块解析出来并换成术语卡片；返回「关键字 → 条目」的字典 */
function enhanceTerms(root) {
  const map = new Map();
  const dups = [];
  let seq = 0;

  root.querySelectorAll('pre > code.language-terms').forEach(code => {
    const pre = code.parentNode;
    const items = [];

    (code.textContent || '').split('\n').forEach(line => {
      const cut = line.indexOf('=');
      if (cut < 0) return;
      const key = line.slice(0, cut).trim();
      const def = line.slice(cut + 1).trim();
      if (key.length < 2 || !def) return;
      if (/^[^\w\u4e00-\u9fa5]+$/.test(key)) return;

      const item = { key, def, id: 'term-' + (++seq) };
      items.push(item);
      if (map.has(key)) dups.push(key);
      map.set(key, item);
    });

    if (!items.length) { code.className = 'language-plaintext'; return; }
    pre.parentNode.replaceChild(buildTermCard(items), pre);
  });

  if (dups.length) toast('说明区里「' + dups[0] + '」重复了，以后一条为准');
  return map;
}

/** 术语卡片：一条术语一个 li，挂在 data-term 上供跳转定位 */
function buildTermCard(items) {
  const card = document.createElement('div');
  card.className = 'terms-card';

  const head = document.createElement('p');
  head.className = 'terms-head';
  head.textContent = '术语说明';

  const list = document.createElement('ul');
  list.className = 'terms-list';

  items.forEach(it => {
    const li = document.createElement('li');
    li.className = 'term-item';
    li.id = it.id;
    li.dataset.term = it.key;

    const key = document.createElement('code');
    key.className = 'term-key';
    key.textContent = it.key;

    const def = document.createElement('span');
    def.className = 'term-def';
    def.textContent = it.def;

    li.append(key, def);
    list.appendChild(li);
  });

  card.append(head, list);
  return card;
}

/** 给代码里命中的关键字套上徽章。只在文本节点上切分，不动 hljs 生成的 <span> */
function enhanceKeywords(root, map) {
  if (!map || !map.size) return;

  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let re;
  try {
    re = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  } catch (e) {
    return;                       /* 解析失败就整体放弃，别连累整篇渲染 */
  }

  let budget = 300;               /* 超大代码块时封顶，避免边打字边卡 */

  root.querySelectorAll('code:not(.term-key)').forEach(code => {
    if (budget <= 0) return;

    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT, null);
    const texts = [];
    let node;
    while ((node = walker.nextNode())) texts.push(node);

    texts.forEach(textNode => {
      if (budget <= 0) return;
      const parent = textNode.parentElement;
      if (parent && parent.closest(KW_SKIP)) return;

      const data = textNode.data;
      const spots = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(data))) {
        const s = m.index;
        const e = s + m[0].length;
        if (isWordChar(data[s - 1]) || isWordChar(data[e])) continue;
        spots.push([s, e, m[0]]);
      }
      if (!spots.length) return;

      /* 从后往前切，拼成「文字段 / 徽章」交替的片段，最后整块换掉这个文本节点 */
      const parts = [];
      let tail = data.length;
      for (let i = spots.length - 1; i >= 0; i--) {
        if (spots[i][1] < tail) parts.push({ text: data.slice(spots[i][1], tail), key: null });
        parts.push({ text: data.slice(spots[i][0], spots[i][1]), key: spots[i][2] });
        tail = spots[i][0];
      }
      if (tail > 0) parts.push({ text: data.slice(0, tail), key: null });

      const frag = document.createDocumentFragment();
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (!p.key) { frag.appendChild(document.createTextNode(p.text)); continue; }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kw';
        btn.dataset.term = p.key;
        btn.title = p.key + '：' + map.get(p.key).def;
        btn.textContent = p.text;
        frag.appendChild(btn);
        budget--;
      }
      textNode.parentNode.replaceChild(frag, textNode);
    });
  });
}

/** 找到真正在滚动的祖先容器（阅读区是 els.main，编辑预览是预览面板本身） */
function scrollParentOf(el) {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

/** 点击徽章：滚到说明区里那一条并闪一下 */
function jumpToTerm(root, key) {
  let target = null;
  root.querySelectorAll('.term-item').forEach(el => {
    if (!target && el.dataset.term === key) target = el;
  });
  if (!target) return;

  target.classList.remove('is-flash');
  void target.offsetWidth;        /* 强制重排，让同一处连点也能重新播放动画 */
  target.classList.add('is-flash');
  clearTimeout(target.flashTimer);
  target.flashTimer = setTimeout(() => target.classList.remove('is-flash'), 1200);

  const box = scrollParentOf(target);
  if (!box) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }

  const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  box.scrollTo({
    top: Math.max(0, top - box.clientHeight / 2 + target.offsetHeight / 2),
    behavior: 'smooth'
  });
}

function enhanceCodeBlocks(root) {
  const scope = root || els.markdownBody;
  const termMap = enhanceTerms(scope);

  scope.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      try {
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1400);
      } catch (e) {
        toast('复制失败，请手动选中代码');
      }
    });
    pre.appendChild(btn);
  });

  if (window.hljs) {
    scope.querySelectorAll('pre code').forEach(el => {
      if (el.dataset.highlighted) return;   /* 已高亮过的块别重复处理，否则会抹掉徽章 */
      try { hljs.highlightElement(el); } catch (e) { /* 忽略单块失败 */ }
    });
  }

  enhanceKeywords(scope, termMap);
}

/* 私有仓库里的图片带不上 Authorization 头，必须先取回字节再换成临时地址 */
const imageUrls = new Map();

/** 把 Markdown 里的相对图片路径解析成仓库内路径；外链图片返回 null */
function resolveImagePath(src, notePath) {
  if (!src || /^(?:https?:|data:|blob:|\/\/)/i.test(src)) return null;

  const clean = src.split('#')[0].split('?')[0];
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch (e) { /* 解不开就按原样用 */ }

  const dir = notePath && notePath.includes('/')
    ? notePath.slice(0, notePath.lastIndexOf('/'))
    : '';
  const segments = (dir ? dir.split('/') : []).concat(decoded.split('/'));

  const out = [];
  for (const seg of segments) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

async function enhanceImages(root, notePath) {
  const list = root.querySelectorAll('img');
  await Promise.all([...list].map(async img => {
    const repoPath = resolveImagePath(img.getAttribute('src'), notePath);
    if (!repoPath) return;   /* 外链图片交给浏览器自己加载 */

    img.classList.add('is-loading');
    try {
      let url = imageUrls.get(repoPath);
      if (!url) {
        const res = await fetch(
          API + `/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(repoPath)}`
            + (cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : ''),
          {
            headers: {
              Accept: 'application/vnd.github.raw',
              Authorization: 'Bearer ' + cfg.token,
              'X-GitHub-Api-Version': '2022-11-28'
            }
          }
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        url = URL.createObjectURL(await res.blob());
        imageUrls.set(repoPath, url);
      }
      img.src = url;
    } catch (e) {
      img.removeAttribute('src');
      img.classList.add('is-broken');
      img.alt = '图片读不到：' + repoPath;
    } finally {
      img.classList.remove('is-loading');
    }
  }));
}

function selectNote(path) {
  const n = notes.find(x => x.path === path);
  if (!n) return;

  activePath = path;
  els.emptyState.hidden = true;
  els.editor.hidden = true;
  els.reader.hidden = false;

  els.noteTitle.textContent = n.title || n.path;
  els.noteMeta.textContent = n.path + ' · ' + (n.text || '').length + ' 字符';
  els.markdownBody.innerHTML = renderMarkdown(n.text);
  enhanceCodeBlocks();
  enhanceImages(els.markdownBody, n.path);
  els.main.scrollTop = 0;
  document.title = (n.title || n.path) + ' · 学习笔记';

  renderList();
}

function showEmpty() {
  const configured = hasConfig();
  const kicker = els.emptyState.querySelector('.empty-kicker');
  const title = els.emptyState.querySelector('h2');
  const sub = els.emptyState.querySelector('.empty-sub');

  kicker.textContent = configured ? '这个仓库还没有笔记' : '还没有连接笔记仓库';
  title.textContent = configured ? '写下你的第一篇笔记' : '把你的 C# 笔记，随身带着走';
  sub.textContent = configured
    ? '点右上角的 ＋ 新建一篇。用 Markdown 书写，代码块用三个反引号加 cs 包起来就会自动高亮。'
    : '点右上角 ⚙ 填入 GitHub 用户名、仓库名和一个访问令牌，之后在任何电脑打开这个网址，都能读到同一份笔记。';
  els.emptySetupBtn.textContent = configured ? '新建笔记' : '开始设置';
  els.emptySetupBtn.dataset.action = configured ? 'new' : 'setup';

  els.reader.hidden = true;
  els.editor.hidden = true;
  els.emptyState.hidden = false;
  document.title = '学习笔记';
}

/* ------------------------------------------------------------------ 编辑器 */

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
  catch (e) { return null; }
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (els.editor.hidden) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        mode: editorMode, path: els.editorPath.value, body: els.editorBody.value
      }));
    } catch (e) { /* 忽略 */ }
  }, 600);
}

function clearDraft() {
  clearTimeout(draftTimer);
  localStorage.removeItem(DRAFT_KEY);
}

/* --------------------------------------------------------- 编辑区工具条 */

/** 取当前选区覆盖到的整行 */
function selectedLines() {
  const ta = els.editorBody;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const from = value.lastIndexOf('\n', start - 1) + 1;
  let to = value.indexOf('\n', end);
  if (to === -1) to = value.length;

  const lines = value.slice(from, to).split('\n');
  const apply = nextLines => {
    const text = nextLines.join('\n');
    ta.value = value.slice(0, from) + text + value.slice(to);
    ta.setSelectionRange(from, from + text.length);
    ta.focus();
    onEditorChanged();
  };
  return { lines, apply };
}

/** 用标记包住选区；如果已经在标记里面，再点一次就取消包裹 */
function wrapSelection(before, after, placeholder) {
  const ta = els.editorBody;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  const outerBefore = value.slice(Math.max(0, start - before.length), start);
  const outerAfter = value.slice(end, end + after.length);

  if (outerBefore === before && outerAfter === after) {
    ta.value = value.slice(0, start - before.length) + value.slice(start, end) + value.slice(end + after.length);
    ta.focus();
    ta.setSelectionRange(start - before.length, end - before.length);
    onEditorChanged();
    return;
  }

  const picked = value.slice(start, end) || placeholder || '';
  ta.value = value.slice(0, start) + before + picked + after + value.slice(end);
  ta.focus();
  ta.setSelectionRange(start + before.length, start + before.length + picked.length);
  onEditorChanged();
}

function toggleHeading(level) {
  const prefix = '#'.repeat(level) + ' ';
  const { lines, apply } = selectedLines();
  const all = lines.every(l => l.trimStart().startsWith(prefix));
  apply(lines.map(l => {
    const bare = l.replace(/^\s*#{1,6}\s+/, '');
    return all ? bare : prefix + bare;
  }));
}

function toggleList(ordered) {
  const { lines, apply } = selectedLines();
  const re = /^\s*(?:[-*+]|\d+\.)\s+/;
  const all = lines.every(l => re.test(l));
  let n = 0;
  apply(lines.map(l => {
    const bare = l.replace(re, '');
    if (all) return bare;
    if (ordered) { n += 1; return n + '. ' + bare; }
    return '- ' + bare;
  }));
}

function toggleQuote() {
  const { lines, apply } = selectedLines();
  const re = /^\s*>\s?/;
  const all = lines.every(l => re.test(l));
  apply(lines.map(l => (all ? l.replace(re, '') : '> ' + l.replace(re, ''))));
}

/** 在光标处插入块级内容，必要时前后补换行 */
function insertBlock(text, selFrom, selTo) {
  const ta = els.editorBody;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const before = value.slice(0, start);
  const after = value.slice(end);

  const lead = (before && !before.endsWith('\n')) ? '\n' : '';
  const trail = (after && !after.startsWith('\n')) ? '\n' : '';

  ta.value = before + lead + text + trail + after;
  ta.focus();
  const base = start + lead.length;
  ta.setSelectionRange(base + (selFrom || 0), base + (selTo === undefined ? (selFrom || 0) : selTo));
  onEditorChanged();
}

/** 插入 C# 代码块；有选中内容就包起来 */
function insertCodeBlock() {
  const ta = els.editorBody;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const picked = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const head = '```cs\n';
  const tail = '\n```';
  const lead = (before && !before.endsWith('\n')) ? '\n' : '';
  const trail = (after && !after.startsWith('\n')) ? '\n' : '';

  ta.value = before + lead + head + picked + tail + trail + after;
  ta.focus();
  const bodyStart = start + lead.length + head.length;
  ta.setSelectionRange(bodyStart, bodyStart + picked.length);
  onEditorChanged();
}

/* -------------------------------------------------------------- 图片上传 */

const IMAGE_DIR = 'assets';

/** 生成不会撞名的图片文件名，同时保留原名字里能读的部分 */
function safeImageName(original) {
  const hit = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.exec(original || '');
  const ext = hit ? hit[0].toLowerCase() : '.png';
  const base = (original || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'image';

  const d = new Date();
  const two = n => String(n).padStart(2, '0');
  const stamp = '' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate())
    + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());

  return base + '-' + stamp + ext;
}

/** 按笔记所在的层级算出相对写法，这样在 GitHub 网页里也能正常显示 */
function imageMarkdown(repoPath, alt) {
  const notePath = (els.editorPath.value || '').trim();
  const depth = notePath.includes('/')
    ? notePath.slice(0, notePath.lastIndexOf('/')).split('/').length
    : 0;
  return '![' + (alt || '图片') + '](' + '../'.repeat(depth) + repoPath + ')';
}

async function saveImage(file) {
  if (!hasConfig()) { toast('先点右上角 ⚙ 填好设置，才能把图片存进仓库'); return; }
  if (!/^image\//i.test(file.type || '')) { toast('只能上传图片文件'); return; }
  if (file.size > 4 * 1024 * 1024) {
    toast('图片超过 4MB，先压缩一下再传（截图一般远小于这个值）');
    return;
  }

  const repoPath = IMAGE_DIR + '/' + safeImageName(file.name);
  const alt = (file.name || '').replace(/\.[^.]+$/, '') || '图片';

  setStatus('busy', '上传图片');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await gh(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(repoPath)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '新增图片：' + repoPath,
          content: bytesToB64(bytes),
          branch: cfg.branch || undefined
        })
      }
    );
    insertBlock(imageMarkdown(repoPath, alt));
    setStatus('ok', '图片已上传');
    toast('图片已存进仓库：' + repoPath);
  } catch (err) {
    setStatus('error', '上传失败');
    toast(err.message || '图片上传失败');
  }
}

function pickImage() {
  if (!hasConfig()) { toast('先点右上角 ⚙ 填好设置，才能把图片存进仓库'); return; }
  els.imageInput.value = '';
  els.imageInput.click();
}

const TABLE_SNIPPET = '| 概念 | 说明 |\n| --- | --- |\n| 示例 | 示例 |';

function applyToolAction(act) {
  switch (act) {
    case 'h1': toggleHeading(1); break;
    case 'h2': toggleHeading(2); break;
    case 'h3': toggleHeading(3); break;
    case 'bold': wrapSelection('**', '**', '粗体'); break;
    case 'italic': wrapSelection('*', '*', '斜体'); break;
    case 'mark': wrapSelection('==', '==', '高亮'); break;
    case 'strike': wrapSelection('~~', '~~', '删除线'); break;
    case 'ul': toggleList(false); break;
    case 'ol': toggleList(true); break;
    case 'quote': toggleQuote(); break;
    case 'code': wrapSelection('`', '`', '代码'); break;
    case 'codeblock': insertCodeBlock(); break;
    case 'link': wrapSelection('[', '](https://)', '链接文字'); break;
    case 'image': pickImage(); break;
    case 'table': insertBlock(TABLE_SNIPPET, 2, 4); break;
    case 'hr': insertBlock('---\n'); break;
  }
}

/** Tab 缩进，Shift + Tab 反缩进 */
function handleEditorTab(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();

  const ta = els.editorBody;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  if (start === end && !e.shiftKey) {
    ta.value = value.slice(0, start) + '  ' + value.slice(end);
    ta.setSelectionRange(start + 2, start + 2);
  } else {
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to === -1) to = value.length;
    const text = value.slice(from, to).split('\n')
      .map(l => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l))
      .join('\n');
    ta.value = value.slice(0, from) + text + value.slice(to);
    ta.setSelectionRange(from, from + text.length);
  }
  ta.focus();
  onEditorChanged();
}

/* 实时预览与字数统计 */
function paintEditorPreview() {
  if (!els.editorPanes.classList.contains('is-preview')) return;
  els.editorPreview.innerHTML = renderMarkdown(els.editorBody.value);
  enhanceCodeBlocks(els.editorPreview);
  enhanceImages(els.editorPreview, (els.editorPath.value || '').trim());
}

const paintEditorPreviewLater = debounce(paintEditorPreview, 180);

function updateEditorStat() {
  const text = els.editorBody.value;
  const lines = text ? text.split('\n').length : 0;
  els.editorStat.textContent = text.length + ' 字符 · ' + lines + ' 行';
}

function onEditorChanged() {
  scheduleDraft();
  updateEditorStat();
  paintEditorPreviewLater();
}

function togglePreview() {
  const on = els.editorPanes.classList.toggle('is-preview');
  els.previewToggleBtn.classList.toggle('is-on', on);
  els.previewToggleBtn.textContent = on ? '关闭预览' : '预览';
  if (on) paintEditorPreview();
}

function openNewNote() {
  if (!hasConfig()) { openSettings(); return; }

  const draft = readDraft();
  const restore = draft && draft.mode === 'new';

  editorMode = 'new';
  els.emptyState.hidden = true;
  els.reader.hidden = true;
  els.editor.hidden = false;
  els.editorPath.disabled = false;
  els.editorPath.value = restore ? (draft.path || '') : '';
  els.editorBody.value = restore ? (draft.body || '') : '';
  els.main.scrollTop = 0;
  (els.editorPath.value ? els.editorBody : els.editorPath).focus();
  if (restore) toast('已恢复上次没写完的草稿');
  updateEditorStat();
  paintEditorPreview();
}

function editCurrentNote() {
  const n = notes.find(x => x.path === activePath);
  if (!n) return;
  editorMode = 'edit';
  els.emptyState.hidden = true;
  els.reader.hidden = true;
  els.editor.hidden = false;
  els.editorPath.disabled = true;
  els.editorPath.value = n.path;
  els.editorBody.value = n.text || '';
  els.main.scrollTop = 0;
  els.editorBody.focus();
  updateEditorStat();
  paintEditorPreview();
}

function cancelEdit() {
  clearDraft();
  if (editorMode === 'edit' && activePath) selectNote(activePath);
  else showEmpty();
}

async function saveNote() {
  const path = els.editorPath.value.trim().replace(/^\/+/, '');
  const body = els.editorBody.value;

  if (!path) { toast('请先填写笔记路径，例如 CSharp/基础语法.md'); els.editorPath.focus(); return; }
  if (!/\.md$/i.test(path)) { toast('路径需要以 .md 结尾'); els.editorPath.focus(); return; }

  els.saveBtn.disabled = true;
  setStatus('busy', '保存中');

  try {
    const local = notes.find(n => n.path.toLowerCase() === path.toLowerCase());
    const sha = local ? local.sha : await remoteSha(path);

    const payload = {
      message: (sha ? '更新笔记：' : '新增笔记：') + path,
      content: textToB64(body),
      branch: cfg.branch || undefined
    };
    if (sha) payload.sha = sha;

    const res = await gh(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(path)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );

    const newSha = (res && res.content && res.content.sha) || sha || '';
    const entry = { path, sha: newSha, text: body, title: deriveTitle(path, body) };
    const i = notes.findIndex(n => n.path === path);
    if (i >= 0) notes[i] = entry; else notes.push(entry);
    notes.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));

    cache.files[path] = { sha: newSha, text: body };
    persistCache();
    clearDraft();

    selectNote(path);
    setStatus('ok', '已同步');
    toast(sha ? '笔记已更新' : '笔记已创建');

    loadNotes({ silent: true });
  } catch (err) {
    setStatus('error', '保存失败');
    toast(err.message || '保存失败');
  } finally {
    els.saveBtn.disabled = false;
  }
}

async function deleteCurrentNote() {
  const n = notes.find(x => x.path === activePath);
  if (!n) return;
  if (!confirm('确定删除「' + (n.title || n.path) + '」吗？\n删掉之后仍可以在 GitHub 的提交历史里找回。')) return;

  setStatus('busy', '删除中');
  try {
    await gh(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(n.path)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '删除笔记：' + n.path,
          sha: n.sha,
          branch: cfg.branch || undefined
        })
      }
    );
    notes = notes.filter(x => x.path !== n.path);
    delete cache.files[n.path];
    persistCache();
    activePath = null;
    setStatus('ok', '已同步');
    toast('已删除');
    if (notes.length) selectNote(notes[0].path); else showEmpty();
  } catch (err) {
    setStatus('error', '删除失败');
    toast(err.message || '删除失败');
  }
}

/* ------------------------------------------------------------------ 设置层 */

function showCfgMessage(msg, isError = true) {
  if (!msg) { els.cfgError.hidden = true; els.cfgError.textContent = ''; return; }
  els.cfgError.hidden = false;
  els.cfgError.textContent = msg;
  els.cfgError.classList.toggle('is-error', isError);
}

function openSettings() {
  els.cfgOwner.value = cfg.owner || '';
  els.cfgRepo.value = cfg.repo || '';
  els.cfgToken.value = cfg.token || '';
  els.cfgBranch.value = cfg.branch || '';
  showCfgMessage('');
  els.settingsModal.hidden = false;
  els.scrim.hidden = false;
  els.cfgOwner.focus();
}

function closeSettings() {
  els.settingsModal.hidden = true;
  if (!els.sidebar.classList.contains('is-open')) els.scrim.hidden = true;
}

function readSettingsForm() {
  return {
    owner: els.cfgOwner.value.trim(),
    repo: els.cfgRepo.value.trim(),
    token: els.cfgToken.value.trim(),
    branch: els.cfgBranch.value.trim()
  };
}

async function testConnection() {
  const input = readSettingsForm();
  if (!input.owner || !input.repo || !input.token) {
    showCfgMessage('用户名、仓库名、令牌都要填齐。');
    return;
  }

  const saved = cfg;
  els.testConnBtn.disabled = true;
  setStatus('busy', '测试中');
  try {
    cfg = input;

    let login = '';
    try {
      const me = await gh('/user');
      login = me && me.login ? me.login : '';
    } catch (e) {
      showCfgMessage('令牌无效或已过期。回到 GitHub 的 Personal access tokens 页面重新生成一枚。');
      setStatus('error', '令牌无效');
      return;
    }

    try {
      const info = await gh(`/repos/${cfg.owner}/${cfg.repo}`);
      showCfgMessage(
        '全部正常 ✓\n令牌属于账号：' + login
        + '\n仓库可读写：' + info.full_name
        + '（默认分支 ' + info.default_branch + '）',
        false
      );
      if (!input.branch) els.cfgBranch.value = info.default_branch;
      setStatus('ok', '连接正常');
    } catch (err) {
      showCfgMessage(await diagnoseRepo(err.status, login));
      setStatus('error', '连接失败');
    }
  } finally {
    cfg = saved;
    els.testConnBtn.disabled = false;
  }
}

/** 仓库打不开时，判断到底是哪一步配错了，并给出可执行的下一步 */
async function diagnoseRepo(status, login) {
  if (status === 401) {
    return '令牌无效或已过期（401）。请到 GitHub 重新生成一枚。';
  }
  if (status !== 404) {
    return '仓库访问失败：' + messageFor(status, null);
  }

  const lines = ['看不到这个仓库（404），按顺序核对：'];

  if (login && login.toLowerCase() !== cfg.owner.toLowerCase()) {
    lines.push('① 用户名写错了。这枚令牌实际属于账号「' + login + '」，用户名请改成它。');
  } else {
    lines.push('① 用户名「' + cfg.owner + '」与令牌所属账号一致，问题在后面两项。');
  }

  let names = [];
  try {
    const list = await gh('/user/repos?per_page=100&sort=updated');
    names = (list || []).map(r => r.full_name);
  } catch (e) { /* 列表取不到就跳过这一项 */ }

  const want = cfg.repo.toLowerCase();
  const guess = names.find(n => n.split('/')[1].toLowerCase() === want);

  if (guess) {
    lines.push('② 仓库名「' + cfg.repo + '」对不上，但你有一个名字几乎一样的仓库：' + guess + '（注意拼写和大小写）。');
  } else if (!names.length) {
    lines.push('② 这枚令牌能访问的仓库是空的。回到 GitHub 打开这枚令牌，Repository access 选 Only select repositories 并勾上你的笔记仓库，再把 Contents 权限设为 Read and write。');
  } else {
    lines.push('② 仓库名「' + cfg.repo + '」不在令牌可访问的列表里。当前能访问的有：'
      + names.slice(0, 8).join('、') + (names.length > 8 ? ' 等' : '')
      + '。如果笔记仓库不在其中，请回到 GitHub 给这枚令牌勾上它。');
  }

  return lines.join('\n');
}

function saveSettings() {
  const input = readSettingsForm();
  if (!input.owner || !input.repo || !input.token) {
    showCfgMessage('用户名、仓库名、令牌都要填齐。');
    return;
  }

  if (input.owner !== cfg.owner || input.repo !== cfg.repo) {
    cache = { owner: input.owner, repo: input.repo, files: {} };
    notes = [];
    activePath = null;
  }

  cfg = input;
  persistConfig();
  closeSettings();
  loadNotes();
}

function clearSettings() {
  if (!confirm('清空后需要重新填写才能读取笔记，确定吗？')) return;
  cfg = { owner: '', repo: '', token: '', branch: '' };
  cache = { owner: '', repo: '', files: {} };
  notes = [];
  activePath = null;
  localStorage.removeItem(CFG_KEY);
  localStorage.removeItem(CACHE_KEY);
  els.cfgOwner.value = '';
  els.cfgRepo.value = '';
  els.cfgToken.value = '';
  els.cfgBranch.value = '';
  showCfgMessage('');
  closeSettings();
  setStatus('idle', '未连接');
  renderList();
  showEmpty();
}

/* ------------------------------------------------------------------ 主题 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const dark = theme === 'dark';
  els.hljsDark.disabled = !dark;
  els.hljsLight.disabled = dark;
}

/* ------------------------------------------------------------- 窄屏抽屉 */

function openDrawer() {
  if (window.innerWidth > 820) return;
  els.sidebar.classList.add('is-open');
  els.scrim.hidden = false;
}

function closeDrawer() {
  if (!els.sidebar.classList.contains('is-open')) return;
  els.sidebar.classList.remove('is-open');
  if (els.settingsModal.hidden) els.scrim.hidden = true;
}

/* ------------------------------------------------------------------ 绑定 */

function bindEvents() {
  els.menuBtn.addEventListener('click', openDrawer);
  els.scrim.addEventListener('click', () => { closeSettings(); closeDrawer(); });

  els.settingsBtn.addEventListener('click', openSettings);
  els.closeSettingsBtn.addEventListener('click', closeSettings);
  els.saveCfgBtn.addEventListener('click', saveSettings);
  els.testConnBtn.addEventListener('click', testConnection);
  els.clearCfgBtn.addEventListener('click', clearSettings);

  els.newNoteBtn.addEventListener('click', openNewNote);
  els.emptySetupBtn.addEventListener('click', () => {
    if (els.emptySetupBtn.dataset.action === 'new') openNewNote();
    else openSettings();
  });

  els.editBtn.addEventListener('click', editCurrentNote);
  els.deleteBtn.addEventListener('click', deleteCurrentNote);
  els.cancelEditBtn.addEventListener('click', cancelEdit);
  els.saveBtn.addEventListener('click', saveNote);

  els.editorBody.addEventListener('input', onEditorChanged);
  els.editorPath.addEventListener('input', scheduleDraft);
  els.editorBody.addEventListener('keydown', handleEditorTab);

  els.toolbar.addEventListener('mousedown', e => {
    /* 阻止按钮抢走输入框焦点，否则选区会被清掉 */
    if (e.target.closest('.tool-btn')) e.preventDefault();
  });
  els.toolbar.addEventListener('click', e => {
    const btn = e.target.closest('.tool-btn');
    if (btn) applyToolAction(btn.dataset.act);
  });
  els.previewToggleBtn.addEventListener('click', togglePreview);

  /* 代码里的关键字徽章：点击跳到说明区对应的条目 */
  [els.markdownBody, els.editorPreview].forEach(box => {
    box.addEventListener('click', e => {
      const kw = e.target.closest('.kw');
      if (kw) jumpToTerm(box, kw.dataset.term);
    });
  });

  els.imageInput.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (file) saveImage(file);
  });

  /* 截图直接粘贴：Win + Shift + S 截完，回到编辑器 Ctrl + V */
  els.editorBody.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.indexOf('image/') === 0) {
        const file = item.getAsFile();
        if (file) { e.preventDefault(); saveImage(file); return; }
      }
    }
  });

  els.refreshBtn.addEventListener('click', () => loadNotes());
  els.searchInput.addEventListener('input', debounce(e => {
    query = e.target.value;
    renderList();
  }, 160));

  els.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  document.addEventListener('keydown', e => {
    const inEditor = !els.editor.hidden;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (inEditor && mod && key === 's') {
      e.preventDefault();
      saveNote();
    }

    if (inEditor && mod && !e.altKey) {
      if (e.shiftKey && key === 'h') { e.preventDefault(); wrapSelection('==', '==', '高亮'); }
      else if (!e.shiftKey && key === 'b') { e.preventDefault(); wrapSelection('**', '**', '粗体'); }
      else if (!e.shiftKey && key === 'i') { e.preventDefault(); wrapSelection('*', '*', '斜体'); }
      else if (!e.shiftKey && key === 'e') { e.preventDefault(); wrapSelection('`', '`', '代码'); }
      else if (!e.shiftKey && key === 'k') { e.preventDefault(); wrapSelection('[', '](https://)', '链接文字'); }
    }

    if (e.key === 'Escape') {
      if (!els.settingsModal.hidden) closeSettings();
      else closeDrawer();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) closeDrawer();
  });
}

/* ------------------------------------------------------------------ 启动 */

function init() {
  cacheDom();
  setupMarked();
  loadConfig();
  loadCache();

  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(savedTheme || (prefersDark ? 'dark' : 'light'));

  bindEvents();

  if (hasConfig()) loadNotes();
  else { setStatus('idle', '未连接'); showEmpty(); }
}

document.addEventListener('DOMContentLoaded', init);
