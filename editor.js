/**
 * editor.js — a section-based editor for content.md. Reading content.md is
 * a plain, unauthenticated GitHub API call (the repo is public).
 *
 * Publishing is manual and token-free by design: GitHub's write APIs always
 * require a credential, and this editor deliberately holds none. Instead,
 * "Publish" copies the generated content.md to your clipboard and opens
 * GitHub's own file editor for you to paste into and commit — using your
 * own logged-in GitHub session, not a stored secret. (A server-side option
 * — api/publish.js, a Vercel function — exists in this repo for a one-click
 * publish later, but isn't used by this flow.)
 *
 * The login screen below is a plain UI gate — it just keeps a casual
 * visitor from opening the editor. There's no server to check it against
 * (there's no credential anywhere in this flow to protect), so it's a
 * client-side-only check against EDITOR_USERNAME/EDITOR_PASSWORD.
 *
 * The content model is an ORDERED LIST of sections, mirroring content.js:
 * state.sections is an array in document order, each tagged with a
 * `layout` (about/experience/education/certification/blog/projects/
 * projects/contact/custom). The sidebar lets you select one section at a
 * time, drag (or use the up/down buttons) to reorder them, rename them,
 * add new ones, or delete them. Parsing/serialization here is intentionally
 * identical in spirit to content.js, so a saved file always re-parses the
 * same way the live site reads it.
 */

const OWNER = 'MontaniConnect';
const REPO = 'carlos-portfolio';
const BRANCH = 'main';
const FILE_PATH = 'content.md';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
const GITHUB_EDIT_URL = `https://github.com/${OWNER}/${REPO}/edit/${BRANCH}/${FILE_PATH}`;

// Client-side-only UI gate. Change these to whatever you like — nothing
// server-side depends on them.
const EDITOR_USERNAME = 'admin';
const EDITOR_PASSWORD = 'admin';
const LOGIN_SESSION_KEY = 'portfolio_editor_logged_in';

const KNOWN_KEYS = new Set([
  'name', 'eyebrow', 'role', 'blurb', 'email', 'linkedin', 'footer',
  'dates', 'location', 'tags', 'tab', 'degree', 'layout',
  'intro', 'view_all_url', 'view_all_label',
  'issuer', 'date', 'credential_id', 'url', 'cta_label'
]);

const DEFAULT_LAYOUT_FOR_TITLE = {
  About: 'about', Experience: 'experience', Education: 'education',
  Certification: 'certification', Blog: 'blog', Projects: 'projects', Contact: 'contact'
};
const PROSE_LAYOUTS = new Set(['about', 'contact']);
const LAYOUT_LABELS = {
  about: 'About', experience: 'Experience', education: 'Education',
  certification: 'Certification', blog: 'Blog', projects: 'Projects',
  contact: 'Contact', custom: 'Custom'
};

function inferDefaultLayout(title) {
  return DEFAULT_LAYOUT_FOR_TITLE[title] || 'custom';
}

// ---------- Parsing (mirrors content.js) ----------

function parseFrontmatter(text) {
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const block = text.slice(3, end).trim();
      const rest = text.slice(end + 4).replace(/^\s*\n/, '');
      const profile = {};
      block.split('\n').forEach(line => {
        const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
        if (m) profile[m[1]] = m[2].trim();
      });
      return { profile, rest };
    }
  }
  return { profile: {}, rest: text };
}

function splitSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      if (current) sections.push(current);
      current = { title: h2[1].trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function consumeLeadingMeta(lines) {
  const meta = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m && KNOWN_KEYS.has(m[1])) {
      meta[m[1]] = m[2].trim();
      i++;
    } else if (line.trim() === '') {
      i++;
    } else {
      break;
    }
  }
  return { meta, rest: lines.slice(i) };
}

function parseEntryBody(bodyLines) {
  const { meta, rest } = consumeLeadingMeta(bodyLines);
  const text = rest.join('\n').trim();
  const bullets = [];
  const paragraphs = [];
  if (text) {
    text.split(/\n\s*\n/).forEach(block => {
      const blockLines = block.split('\n').map(l => l.trim()).filter(Boolean);
      const isBulletBlock = blockLines.length > 0 && blockLines.every(l => l.startsWith('- '));
      if (isBulletBlock) {
        blockLines.forEach(l => bullets.push(l.slice(2).trim()));
      } else if (block.trim()) {
        paragraphs.push(block.trim());
      }
    });
  }
  return { meta, bullets, paragraphs };
}

function extractEntries(lines) {
  const entries = [];
  let current = null;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      if (current) entries.push(current);
      current = { title: h3[1].trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function parseContent(raw) {
  const { profile, rest } = parseFrontmatter(raw);
  const rawSections = splitSections(rest);

  const sections = rawSections.map(rawSec => {
    const { meta, rest: bodyRest } = consumeLeadingMeta(rawSec.bodyLines);
    const layout = meta.layout || inferDefaultLayout(rawSec.title);

    if (PROSE_LAYOUTS.has(layout)) {
      const body = parseEntryBody(bodyRest);
      return { title: rawSec.title, layout, kind: 'prose', meta, paragraphs: body.paragraphs };
    }

    const entries = extractEntries(bodyRest).map(e => {
      const body = parseEntryBody(e.bodyLines);
      return { title: e.title, meta: body.meta, bullets: body.bullets, paragraphs: body.paragraphs };
    });
    return { title: rawSec.title, layout, kind: 'list', meta, entries };
  });

  return { profile, sections };
}

// ---------- Model <-> editable state ----------

let nextId = 1;
function newId() { return 'sec-' + (nextId++); }

function sectionToStateEntry(sec) {
  const base = { id: newId(), title: sec.title, layout: sec.layout };
  switch (sec.layout) {
    case 'about':
      return { ...base, paragraphs: sec.paragraphs.slice() };
    case 'contact':
      return { ...base, cta_label: sec.meta.cta_label || '', paragraphs: sec.paragraphs.slice() };
    case 'experience':
      return {
        ...base, entries: sec.entries.map(e => ({
          title: e.title, tab: e.meta.tab || '', dates: e.meta.dates || '',
          location: e.meta.location || '', tags: e.meta.tags || '', bullets: e.bullets.slice()
        }))
      };
    case 'education':
      return {
        ...base, entries: sec.entries.map(e => ({
          title: e.title, degree: e.meta.degree || '', dates: e.meta.dates || '',
          paragraph: e.paragraphs[0] || ''
        }))
      };
    case 'certification':
      return {
        ...base,
        intro: sec.meta.intro || '', view_all_url: sec.meta.view_all_url || '', view_all_label: sec.meta.view_all_label || '',
        entries: sec.entries.map(e => ({ title: e.title, issuer: e.meta.issuer || '', date: e.meta.date || '', credential_id: e.meta.credential_id || '' }))
      };
    case 'blog':
      return {
        ...base,
        intro: sec.meta.intro || '', view_all_url: sec.meta.view_all_url || '', view_all_label: sec.meta.view_all_label || '',
        entries: sec.entries.map(e => ({ title: e.title, date: e.meta.date || '', url: e.meta.url || '' }))
      };
    case 'projects':
      return {
        ...base, entries: sec.entries.map(e => ({ title: e.title, dates: e.meta.dates || '', tags: e.meta.tags || '', paragraph: e.paragraphs[0] || '' }))
      };
    default:
      return {
        ...base, layout: 'custom', intro: sec.meta.intro || '',
        entries: sec.entries.map(e => ({
          title: e.title, dates: e.meta.dates || '', tags: e.meta.tags || '',
          paragraph: e.paragraphs[0] || '', bullets: e.bullets.slice()
        }))
      };
  }
}

function modelToState(model) {
  const p = model.profile;
  return {
    profile: {
      name: p.name || '', eyebrow: p.eyebrow || '', role: p.role || '',
      blurb: p.blurb || '', email: p.email || '', linkedin: p.linkedin || '',
      footer: p.footer || ''
    },
    sections: model.sections.map(sectionToStateEntry)
  };
}

function serializeSection(sec) {
  let out = `## ${sec.title}\n`;
  if (sec.layout !== inferDefaultLayout(sec.title)) out += `layout: ${sec.layout}\n`;
  out += '\n';

  switch (sec.layout) {
    case 'about':
      out += sec.paragraphs.map(p => p.trim()).filter(Boolean).join('\n\n') + '\n\n';
      break;
    case 'contact':
      if (sec.cta_label) out += `cta_label: ${sec.cta_label}\n\n`;
      out += sec.paragraphs.map(p => p.trim()).filter(Boolean).join('\n\n') + '\n';
      break;
    case 'experience':
      sec.entries.forEach(e => {
        out += `### ${e.title}\n\n`;
        if (e.tab) out += `tab: ${e.tab}\n`;
        if (e.dates) out += `dates: ${e.dates}\n`;
        out += `location: ${e.location || ''}\n`;
        if (e.tags) out += `tags: ${e.tags}\n`;
        out += '\n';
        if (e.bullets.length) out += e.bullets.map(b => `- ${b.trim()}`).join('\n') + '\n\n';
      });
      break;
    case 'education':
      sec.entries.forEach(e => {
        out += `### ${e.title}\n\n`;
        if (e.degree) out += `degree: ${e.degree}\n`;
        if (e.dates) out += `dates: ${e.dates}\n`;
        out += '\n';
        if (e.paragraph) out += `${e.paragraph.trim()}\n\n`;
      });
      break;
    case 'certification':
      if (sec.intro) out += `intro: ${sec.intro}\n`;
      if (sec.view_all_url) out += `view_all_url: ${sec.view_all_url}\n`;
      if (sec.view_all_label) out += `view_all_label: ${sec.view_all_label}\n`;
      out += '\n';
      sec.entries.forEach(e => {
        out += `### ${e.title}\n\n`;
        if (e.issuer) out += `issuer: ${e.issuer}\n`;
        if (e.date) out += `date: ${e.date}\n`;
        out += `credential_id: ${e.credential_id || ''}\n\n`;
      });
      break;
    case 'blog':
      if (sec.intro) out += `intro: ${sec.intro}\n`;
      if (sec.view_all_url) out += `view_all_url: ${sec.view_all_url}\n`;
      if (sec.view_all_label) out += `view_all_label: ${sec.view_all_label}\n`;
      out += '\n';
      sec.entries.forEach(e => {
        out += `### ${e.title}\n\n`;
        if (e.date) out += `date: ${e.date}\n`;
        if (e.url) out += `url: ${e.url}\n`;
        out += '\n';
      });
      break;
    case 'projects':
      sec.entries.forEach(e => {
        out += `### ${e.title}\n\n`;
        if (e.dates) out += `dates: ${e.dates}\n`;
        if (e.tags) out += `tags: ${e.tags}\n`;
        out += '\n';
        if (e.paragraph) out += `${e.paragraph.trim()}\n\n`;
      });
      break;
    default:
      if (sec.intro) out += `intro: ${sec.intro}\n\n`;
      sec.entries.forEach(e => {
        out += `### ${e.title}\n\n`;
        if (e.dates) out += `dates: ${e.dates}\n`;
        if (e.tags) out += `tags: ${e.tags}\n`;
        out += '\n';
        if (e.paragraph) out += `${e.paragraph.trim()}\n\n`;
        if (e.bullets.length) out += e.bullets.map(b => `- ${b.trim()}`).join('\n') + '\n\n';
      });
      break;
  }
  return out;
}

function stateToMarkdown(s) {
  let out = '---\n';
  ['name', 'eyebrow', 'role', 'blurb', 'email', 'linkedin', 'footer'].forEach(k => {
    out += `${k}: ${s.profile[k] || ''}\n`;
  });
  out += '---\n\n';
  out += s.sections.map(serializeSection).join('');
  return out;
}

// ---------- base64 helpers (UTF-8 safe) ----------

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- GitHub reads (public repo, no auth needed) ----------

async function loadFromGitHub() {
  const res = await fetch(`${API_URL}?ref=${BRANCH}`, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`Couldn't load content.md from GitHub (${res.status}).`);
  const json = await res.json();
  return { raw: base64ToUtf8(json.content), sha: json.sha };
}

// ---------- state ----------

let state = null;
let currentSha = null;
let activeId = 'profile';

function activeTarget() {
  return activeId === 'profile' ? state.profile : state.sections.find(s => s.id === activeId);
}

function keysOf(path) { return path.split('.').map(k => /^\d+$/.test(k) ? Number(k) : k); }
function getAt(obj, path) { return keysOf(path).reduce((o, k) => (o == null ? o : o[k]), obj); }
function setAt(obj, path, val) {
  const keys = keysOf(path);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = val;
}

function escapeAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- field / list / entry helpers ----------

function field(label, path, value, opts) {
  opts = opts || {};
  const tag = opts.textarea ? 'textarea' : 'input';
  const attrs = opts.textarea
    ? `data-path="${path}"`
    : `type="text" data-path="${path}" value="${escapeAttr(value)}"`;
  const inner = opts.textarea ? escapeHtml(value) : '';
  return `
    <div class="field">
      <label class="field-label">${escapeHtml(label)}</label>
      <${tag} ${attrs}>${inner}</${tag}>
    </div>
  `;
}

function listEditor(basePath, items, placeholder, kind) {
  const rows = items.map((val, i) => `
    <div class="${kind}-row" data-list-row>
      ${kind === 'bullet'
        ? `<input type="text" data-path="${basePath}.${i}" value="${escapeAttr(val)}" placeholder="${escapeAttr(placeholder)}" />`
        : `<textarea data-path="${basePath}.${i}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(val)}</textarea>`
      }
      <button type="button" class="icon-btn" data-action="remove-item" data-path="${basePath}.${i}" title="Remove">✕</button>
    </div>
  `).join('');
  return `
    <div class="${kind}s-list" data-list-container data-base-path="${basePath}">${rows}</div>
    <div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-item" data-path="${basePath}">+ Add ${kind === 'bullet' ? 'bullet' : 'paragraph'}</button></div>
  `;
}

function entryCard(path, index, total, headerFields, bodyHtml) {
  return `
    <div class="card" data-entry-card>
      <div class="card-head">
        <span class="entry-label">#${index + 1}</span>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="move-up" data-path="${path}" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button type="button" class="icon-btn" data-action="move-down" data-path="${path}" ${index === total - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button type="button" class="icon-btn" data-action="remove-entry" data-path="${path}" title="Remove">✕</button>
        </div>
      </div>
      ${headerFields}
      ${bodyHtml}
    </div>
  `;
}

function addEntryRow(label) {
  return `<div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-entry">+ Add ${label}</button></div>`;
}

function blankEntryFor(layout) {
  switch (layout) {
    case 'experience': return { title: 'New Role @ Company', tab: '', dates: '', location: '', tags: '', bullets: [] };
    case 'education': return { title: 'New Institution', degree: '', dates: '', paragraph: '' };
    case 'certification': return { title: 'New Certification', issuer: '', date: '', credential_id: '' };
    case 'blog': return { title: 'New Post', date: '', url: '' };
    case 'projects': return { title: 'New Project', dates: '', tags: '', paragraph: '' };
    default: return { title: 'New Entry', dates: '', tags: '', paragraph: '', bullets: [] };
  }
}

// ---------- rendering: sidebar ----------

function renderSidebarNav() {
  const profileBtn = document.querySelector('[data-nav-id="profile"]');
  if (profileBtn) profileBtn.classList.toggle('active', activeId === 'profile');

  const list = document.getElementById('section-list');
  list.innerHTML = state.sections.map((sec, i) => `
    <li class="section-row${sec.id === activeId ? ' active' : ''}" draggable="true" data-section-id="${sec.id}" data-nav-id="${sec.id}">
      <span class="row-main">
        <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
        <span class="label">${escapeHtml(sec.title || 'Untitled')}</span>
      </span>
      <span class="reorder-btns">
        <button type="button" class="icon-btn icon-btn-tiny" data-action="move-section-up" data-id="${sec.id}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="icon-btn icon-btn-tiny" data-action="move-section-down" data-id="${sec.id}" ${i === state.sections.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </span>
    </li>
  `).join('');
}

function moveSection(id, delta) {
  const idx = state.sections.findIndex(s => s.id === id);
  const newIdx = idx + delta;
  if (idx === -1 || newIdx < 0 || newIdx >= state.sections.length) return;
  const [item] = state.sections.splice(idx, 1);
  state.sections.splice(newIdx, 0, item);
  renderSidebarNav();
}

function reorderSection(dragId, targetId) {
  if (dragId === targetId) return;
  const fromIdx = state.sections.findIndex(s => s.id === dragId);
  const toIdx = state.sections.findIndex(s => s.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [item] = state.sections.splice(fromIdx, 1);
  state.sections.splice(toIdx, 0, item);
  renderSidebarNav();
}

function deleteSection(id) {
  const sec = state.sections.find(s => s.id === id);
  if (!sec) return;
  const ok = confirm(`Delete the "${sec.title || 'Untitled'}" section? This can't be undone once you publish.`);
  if (!ok) return;
  state.sections = state.sections.filter(s => s.id !== id);
  activeId = 'profile';
  renderSidebarNav();
  renderActivePanel();
  showToast('Section deleted — publish to make it permanent');
}

// ---------- rendering: main panel ----------

function sectionHeaderHtml(sec) {
  return `
    <div class="section-detail-head">
      ${field('Section title', 'title', sec.title)}
      <span class="layout-badge">${escapeHtml(LAYOUT_LABELS[sec.layout] || sec.layout)}</span>
      <button type="button" class="btn btn-ghost btn-small btn-danger-text" data-action="delete-section" data-id="${sec.id}">Delete section</button>
    </div>
  `;
}

function renderProfilePanel() {
  const p = state.profile;
  let html = '<div class="section-block"><h2>Profile</h2>';
  html += field('Name', 'name', p.name);
  html += field('Eyebrow (e.g. "Hello, I\'m")', 'eyebrow', p.eyebrow);
  html += field('Role / title', 'role', p.role);
  html += field('Blurb', 'blurb', p.blurb, { textarea: true });
  html += field('Email', 'email', p.email);
  html += field('LinkedIn URL', 'linkedin', p.linkedin);
  html += field('Footer text', 'footer', p.footer);
  html += '</div>';
  return html;
}

function renderSectionPanel(sec) {
  let html = sectionHeaderHtml(sec);

  switch (sec.layout) {
    case 'about':
      html += listEditor('paragraphs', sec.paragraphs, 'A paragraph about you…', 'paragraph');
      break;

    case 'contact':
      html += field('Button label (e.g. "Say Hello")', 'cta_label', sec.cta_label);
      html += listEditor('paragraphs', sec.paragraphs, 'Contact section text…', 'paragraph');
      break;

    case 'experience':
      sec.entries.forEach((e, i) => {
        const header = `
          ${field('Title (e.g. "Role @ Company")', `entries.${i}.title`, e.title)}
          <div class="field-row">
            ${field('Tab label', `entries.${i}.tab`, e.tab)}
            ${field('Dates', `entries.${i}.dates`, e.dates)}
          </div>
          <div class="field-row">
            ${field('Location', `entries.${i}.location`, e.location)}
            ${field('Tags (comma separated)', `entries.${i}.tags`, e.tags)}
          </div>
        `;
        const body = `<label class="field-label">Bullets</label>${listEditor(`entries.${i}.bullets`, e.bullets, 'Describe what you did…', 'bullet')}`;
        html += entryCard(`entries.${i}`, i, sec.entries.length, header, body);
      });
      html += addEntryRow('experience');
      break;

    case 'education':
      sec.entries.forEach((e, i) => {
        const header = `
          ${field('Institution', `entries.${i}.title`, e.title)}
          <div class="field-row">
            ${field('Degree', `entries.${i}.degree`, e.degree)}
            ${field('Dates', `entries.${i}.dates`, e.dates)}
          </div>
        `;
        const body = field('Description', `entries.${i}.paragraph`, e.paragraph, { textarea: true });
        html += entryCard(`entries.${i}`, i, sec.entries.length, header, body);
      });
      html += addEntryRow('education entry');
      break;

    case 'certification':
      html += field('Intro line', 'intro', sec.intro);
      html += `<div class="field-row">
          ${field('"View all" URL', 'view_all_url', sec.view_all_url)}
          ${field('"View all" label', 'view_all_label', sec.view_all_label)}
        </div>`;
      sec.entries.forEach((e, i) => {
        const header = `
          ${field('Certification title', `entries.${i}.title`, e.title)}
          <div class="field-row">
            ${field('Issuer', `entries.${i}.issuer`, e.issuer)}
            ${field('Date', `entries.${i}.date`, e.date)}
          </div>
          ${field('Credential ID (optional)', `entries.${i}.credential_id`, e.credential_id)}
        `;
        html += entryCard(`entries.${i}`, i, sec.entries.length, header, '');
      });
      html += addEntryRow('certification');
      break;

    case 'blog':
      html += field('Intro line', 'intro', sec.intro);
      html += `<div class="field-row">
          ${field('"View all" URL', 'view_all_url', sec.view_all_url)}
          ${field('"View all" label', 'view_all_label', sec.view_all_label)}
        </div>`;
      sec.entries.forEach((e, i) => {
        const header = `
          ${field('Post title', `entries.${i}.title`, e.title)}
          <div class="field-row">
            ${field('Date', `entries.${i}.date`, e.date)}
            ${field('URL', `entries.${i}.url`, e.url)}
          </div>
        `;
        html += entryCard(`entries.${i}`, i, sec.entries.length, header, '');
      });
      html += addEntryRow('blog post');
      break;

    case 'projects':
      sec.entries.forEach((e, i) => {
        const header = `
          ${field('Project title', `entries.${i}.title`, e.title)}
          <div class="field-row">
            ${field('Dates', `entries.${i}.dates`, e.dates)}
            ${field('Tags (comma separated)', `entries.${i}.tags`, e.tags)}
          </div>
        `;
        const body = field('Description', `entries.${i}.paragraph`, e.paragraph, { textarea: true });
        html += entryCard(`entries.${i}`, i, sec.entries.length, header, body);
      });
      html += addEntryRow('project');
      break;

    default:
      html += field('Intro line (optional)', 'intro', sec.intro);
      sec.entries.forEach((e, i) => {
        const header = `
          ${field('Entry title', `entries.${i}.title`, e.title)}
          <div class="field-row">
            ${field('Dates (optional)', `entries.${i}.dates`, e.dates)}
            ${field('Tags (comma separated, optional)', `entries.${i}.tags`, e.tags)}
          </div>
        `;
        const body = `
          ${field('Description', `entries.${i}.paragraph`, e.paragraph, { textarea: true })}
          <label class="field-label">Bullets</label>${listEditor(`entries.${i}.bullets`, e.bullets, 'A detail…', 'bullet')}
        `;
        html += entryCard(`entries.${i}`, i, sec.entries.length, header, body);
      });
      html += addEntryRow('entry');
      break;
  }

  return html;
}

function renderActivePanel() {
  const el = document.getElementById('editor-main');
  if (activeId === 'profile') {
    el.innerHTML = renderProfilePanel();
    return;
  }
  const sec = state.sections.find(s => s.id === activeId);
  if (!sec) {
    activeId = 'profile';
    el.innerHTML = renderProfilePanel();
    renderSidebarNav();
    return;
  }
  el.innerHTML = renderSectionPanel(sec);
}

// ---------- event wiring ----------

function attachSidebarListeners() {
  const nav = document.getElementById('editor-sidebar');
  let dragId = null;

  nav.addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.getAttribute('data-action');
      const id = actionBtn.getAttribute('data-id');
      if (action === 'move-section-up') moveSection(id, -1);
      else if (action === 'move-section-down') moveSection(id, 1);
      return;
    }
    const row = e.target.closest('[data-nav-id]');
    if (row) {
      activeId = row.getAttribute('data-nav-id');
      renderSidebarNav();
      renderActivePanel();
    }
  });

  nav.addEventListener('dragstart', e => {
    const row = e.target.closest('[data-section-id]');
    if (!row) return;
    dragId = row.getAttribute('data-section-id');
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  nav.addEventListener('dragend', e => {
    const row = e.target.closest('[data-section-id]');
    if (row) row.classList.remove('dragging');
    document.querySelectorAll('.section-row.drop-target').forEach(el => el.classList.remove('drop-target'));
    dragId = null;
  });
  nav.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    const row = e.target.closest('[data-section-id]');
    document.querySelectorAll('.section-row.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (row && row.getAttribute('data-section-id') !== dragId) row.classList.add('drop-target');
  });
  nav.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('[data-section-id]');
    document.querySelectorAll('.section-row.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (row && dragId) reorderSection(dragId, row.getAttribute('data-section-id'));
    dragId = null;
  });

  document.getElementById('btn-add-section').addEventListener('click', openAddSectionPanel);
}

function attachMainListeners() {
  const main = document.getElementById('editor-main');

  main.addEventListener('input', e => {
    const el = e.target;
    const path = el.getAttribute('data-path');
    if (!path) return;
    const target = activeTarget();
    if (!target) return;
    setAt(target, path, el.value);
    if (path === 'title') {
      const label = document.querySelector(`[data-nav-id="${activeId}"] .label`);
      if (label) label.textContent = el.value || 'Untitled';
    }
  });

  main.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const path = btn.getAttribute('data-path');

    if (action === 'delete-section') {
      deleteSection(btn.getAttribute('data-id'));
      return;
    }

    const target = activeTarget();
    if (!target) return;

    if (action === 'add-item') {
      const arr = getAt(target, path);
      arr.push('');
      renderActivePanel();
    } else if (action === 'remove-item') {
      const parts = path.split('.');
      const index = Number(parts.pop());
      const arr = getAt(target, parts.join('.'));
      arr.splice(index, 1);
      renderActivePanel();
    } else if (action === 'add-entry') {
      target.entries.push(blankEntryFor(target.layout));
      renderActivePanel();
    } else if (action === 'remove-entry') {
      const { arr, index } = entryArrayForPath(target, path);
      arr.splice(index, 1);
      renderActivePanel();
    } else if (action === 'move-up' || action === 'move-down') {
      moveEntryAtPath(target, path, action === 'move-up' ? -1 : 1);
      renderActivePanel();
    }
  });
}

function entryArrayForPath(target, path) {
  const parts = path.split('.');
  const index = Number(parts.pop());
  const arr = getAt(target, parts.join('.'));
  return { arr, index };
}

function moveEntryAtPath(target, path, delta) {
  const { arr, index } = entryArrayForPath(target, path);
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= arr.length) return;
  const [item] = arr.splice(index, 1);
  arr.splice(newIndex, 0, item);
}

// ---------- add section ----------

function openAddSectionPanel() {
  document.getElementById('new-section-name').value = '';
  document.getElementById('add-section-panel').hidden = false;
  document.getElementById('new-section-name').focus();
}
function closeAddSectionPanel() {
  document.getElementById('add-section-panel').hidden = true;
}
function confirmAddSection() {
  const input = document.getElementById('new-section-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const sec = { id: newId(), title: name, layout: 'custom', intro: '', entries: [] };
  state.sections.push(sec);
  activeId = sec.id;
  closeAddSectionPanel();
  renderSidebarNav();
  renderActivePanel();
  showToast('Section added — publish to make it live');
}

// ---------- download fallback ----------

function downloadMarkdown() {
  const raw = stateToMarkdown(state);
  const blob = new Blob([raw], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'content.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Downloaded content.md');
}

// ---------- publish flow (copy to clipboard + open GitHub's own editor) ----------

function openPublishPanel() {
  const raw = stateToMarkdown(state);
  document.getElementById('preview-raw').value = raw;
  document.getElementById('publish-msg').textContent = '';
  document.getElementById('publish-msg').className = 'msg';
  document.getElementById('btn-confirm-publish').disabled = false;
  document.getElementById('publish-panel').hidden = false;
}

function closePublishPanel() {
  document.getElementById('publish-panel').hidden = true;
}

async function confirmPublish() {
  const msgEl = document.getElementById('publish-msg');
  const raw = stateToMarkdown(state);

  try {
    await navigator.clipboard.writeText(raw);
    msgEl.textContent = 'Copied. Paste it into the GitHub editor that just opened (select all first), then commit there.';
    msgEl.className = 'msg ok';
    showToast('Copied content.md to clipboard');
  } catch (err) {
    msgEl.textContent = "Couldn't copy automatically — select all the text in the preview above and copy it manually, then paste it into the GitHub editor that just opened.";
    msgEl.className = 'msg err';
  }

  window.open(GITHUB_EDIT_URL, '_blank', 'noopener,noreferrer');
}

// ---------- login screen (client-side UI gate only) ----------

function isLoggedIn() {
  return sessionStorage.getItem(LOGIN_SESSION_KEY) === 'true';
}

function showLoginScreen() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('editor-shell').hidden = true;
  document.querySelector('.savebar').hidden = true;
  document.getElementById('btn-logout').hidden = true;
  document.getElementById('login-username').focus();
}

function showEditorShell() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('editor-shell').hidden = false;
  document.querySelector('.savebar').hidden = false;
  document.getElementById('btn-logout').hidden = false;
}

function attemptLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const msgEl = document.getElementById('login-msg');
  if (username !== EDITOR_USERNAME || password !== EDITOR_PASSWORD) {
    msgEl.textContent = 'Invalid username or password.';
    msgEl.className = 'msg err';
    return;
  }
  sessionStorage.setItem(LOGIN_SESSION_KEY, 'true');
  msgEl.textContent = '';
  msgEl.className = 'msg';
  document.getElementById('login-password').value = '';
  showEditorShell();
  loadAndRenderEditor();
}

function logOut() {
  sessionStorage.removeItem(LOGIN_SESSION_KEY);
  showLoginScreen();
}

// ---------- toast ----------

let toastTimer = null;
function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

// ---------- boot ----------

async function loadAndRenderEditor() {
  try {
    const { raw, sha } = await loadFromGitHub();
    currentSha = sha;
    const model = parseContent(raw);
    state = modelToState(model);
    activeId = state.sections.length ? state.sections[0].id : 'profile';
    renderSidebarNav();
    renderActivePanel();
  } catch (err) {
    document.getElementById('editor-main').innerHTML = `<p class="loading">Couldn't load content.md: ${escapeHtml(err.message)}</p>`;
  }
}

async function boot() {
  document.getElementById('btn-login').addEventListener('click', attemptLogin);
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); attemptLogin(); }
  });
  document.getElementById('btn-logout').addEventListener('click', logOut);

  document.getElementById('btn-cancel-publish').addEventListener('click', closePublishPanel);
  document.getElementById('btn-confirm-publish').addEventListener('click', confirmPublish);
  document.getElementById('btn-cancel-add-section').addEventListener('click', closeAddSectionPanel);
  document.getElementById('btn-confirm-add-section').addEventListener('click', confirmAddSection);
  document.getElementById('new-section-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmAddSection(); }
  });
  document.getElementById('btn-download').addEventListener('click', downloadMarkdown);
  document.getElementById('btn-publish').addEventListener('click', openPublishPanel);

  attachSidebarListeners();
  attachMainListeners();

  if (isLoggedIn()) {
    showEditorShell();
    await loadAndRenderEditor();
  } else {
    showLoginScreen();
  }
}

document.addEventListener('DOMContentLoaded', boot);
