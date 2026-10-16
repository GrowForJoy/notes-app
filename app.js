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

function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
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

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    marked.setOptions({ gfm: true, breaks: true });
    return DOMPurify.sanitize(marked.parse(text || ''));
  }
  return '<pre>' + escapeHtml(text || '') + '</pre>';
}

function enhanceCodeBlocks() {
  els.markdownBody.querySelectorAll('pre').forEach(pre => {
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
    els.markdownBody.querySelectorAll('pre code').forEach(el => {
      try { hljs.highlightElement(el); } catch (e) { /* 忽略单块失败 */ }
    });
  }
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

  els.editorBody.addEventListener('input', scheduleDraft);
  els.editorPath.addEventListener('input', scheduleDraft);

  els.refreshBtn.addEventListener('click', () => loadNotes());
  els.searchInput.addEventListener('input', debounce(e => {
    query = e.target.value;
    renderList();
  }, 160));

  els.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !els.editor.hidden) {
      e.preventDefault();
      saveNote();
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
