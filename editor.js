/**
 * editor.js — a form-based editor for content.md that reads and writes
 * directly to GitHub via the REST API, called from this page in the
 * visitor's own browser. No backend, no server-side token: the GitHub
 * Personal Access Token lives only in this browser's localStorage and is
 * sent only to api.github.com.
 *
 * Parsing logic below is intentionally identical to content.js, so a
 * saved file always re-parses the same way the live site reads it.
 */

const OWNER = 'MontaniConnect';
const REPO = 'carlos-portfolio';
const BRANCH = 'main';
const FILE_PATH = 'content.md';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
const PAT_STORAGE_KEY = 'portfolio_editor_gh_pat';

const KNOWN_KEYS = new Set([
  'name', 'eyebrow', 'role', 'blurb', 'email', 'linkedin', 'footer',
  'dates', 'location', 'tags', 'tab', 'degree',
  'intro', 'view_all_url', 'view_all_label',
  'issuer', 'date', 'credential_id', 'url', 'cta_label'
]);

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

function splitEntries(bodyLines) {
  const { meta: sectionMeta, rest } = consumeLeadingMeta(bodyLines);
  const entries = [];
  let current = null;
  for (const line of rest) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      if (current) entries.push(current);
      current = { title: h3[1].trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) entries.push(current);
  return { sectionMeta, entries };
}

function parseContent(raw) {
  const { profile, rest } = parseFrontmatter(raw);
  const sections = splitSections(rest);
  const model = { profile, sections: {}, order: [] };

  sections.forEach(sec => {
    const key = sec.title;
    model.order.push(key);
    if (key === 'About' || key === 'Contact') {
      const parsed = parseEntryBody(sec.bodyLines);
      model.sections[key] = { type: 'prose', meta: parsed.meta, paragraphs: parsed.paragraphs };
    } else {
      const { sectionMeta, entries } = splitEntries(sec.bodyLines);
      const parsedEntries = entries.map(e => {
        const body = parseEntryBody(e.bodyLines);
        return { title: e.title, meta: body.meta, bullets: body.bullets, paragraphs: body.paragraphs };
      });
      model.sections[key] = { type: 'list', meta: sectionMeta, entries: parsedEntries };
    }
  });

  return model;
}

// ---------- Model <-> editable state ----------

function modelToState(model) {
  const p = model.profile;
  const sec = model.sections;
  const cert = sec['Certification'];
  const blog = sec['Blog'];
  const contact = sec['Contact'];

  return {
    profile: {
      name: p.name || '', eyebrow: p.eyebrow || '', role: p.role || '',
      blurb: p.blurb || '', email: p.email || '', linkedin: p.linkedin || '',
      footer: p.footer || ''
    },
    about: (sec['About'] && sec['About'].paragraphs.slice()) || [],
    experience: ((sec['Experience'] && sec['Experience'].entries) || []).map(e => ({
      title: e.title, tab: e.meta.tab || '', dates: e.meta.dates || '',
      location: e.meta.location || '', tags: e.meta.tags || '', bullets: e.bullets.slice()
    })),
    education: ((sec['Education'] && sec['Education'].entries) || []).map(e => ({
      title: e.title, degree: e.meta.degree || '', dates: e.meta.dates || '',
      paragraph: e.paragraphs[0] || ''
    })),
    certification: {
      intro: (cert && cert.meta.intro) || '',
      view_all_url: (cert && cert.meta.view_all_url) || '',
      view_all_label: (cert && cert.meta.view_all_label) || '',
      entries: ((cert && cert.entries) || []).map(e => ({
        title: e.title, issuer: e.meta.issuer || '', date: e.meta.date || '',
        credential_id: e.meta.credential_id || ''
      }))
    },
    blog: {
      intro: (blog && blog.meta.intro) || '',
      view_all_url: (blog && blog.meta.view_all_url) || '',
      view_all_label: (blog && blog.meta.view_all_label) || '',
      entries: ((blog && blog.entries) || []).map(e => ({
        title: e.title, date: e.meta.date || '', url: e.meta.url || ''
      }))
    },
    projects: ((sec['Projects'] && sec['Projects'].entries) || []).map(e => ({
      title: e.title, dates: e.meta.dates || '', tags: e.meta.tags || '',
      paragraph: e.paragraphs[0] || ''
    })),
    contact: {
      cta_label: (contact && contact.meta.cta_label) || '',
      paragraphs: (contact && contact.paragraphs.slice()) || []
    }
  };
}

function stateToMarkdown(s) {
  let out = '---\n';
  ['name', 'eyebrow', 'role', 'blurb', 'email', 'linkedin', 'footer'].forEach(k => {
    out += `${k}: ${s.profile[k] || ''}\n`;
  });
  out += '---\n\n';

  out += '## About\n\n';
  out += s.about.map(p => p.trim()).filter(Boolean).join('\n\n');
  out += '\n\n';

  out += '## Experience\n\n';
  s.experience.forEach(e => {
    out += `### ${e.title}\n\n`;
    if (e.tab) out += `tab: ${e.tab}\n`;
    if (e.dates) out += `dates: ${e.dates}\n`;
    out += `location: ${e.location || ''}\n`;
    if (e.tags) out += `tags: ${e.tags}\n`;
    out += '\n';
    if (e.bullets.length) {
      out += e.bullets.map(b => `- ${b.trim()}`).join('\n') + '\n\n';
    }
  });

  out += '## Education\n\n';
  s.education.forEach(e => {
    out += `### ${e.title}\n\n`;
    if (e.degree) out += `degree: ${e.degree}\n`;
    if (e.dates) out += `dates: ${e.dates}\n`;
    out += '\n';
    if (e.paragraph) out += `${e.paragraph.trim()}\n\n`;
  });

  out += '## Certification\n\n';
  if (s.certification.intro) out += `intro: ${s.certification.intro}\n`;
  if (s.certification.view_all_url) out += `view_all_url: ${s.certification.view_all_url}\n`;
  if (s.certification.view_all_label) out += `view_all_label: ${s.certification.view_all_label}\n`;
  out += '\n';
  s.certification.entries.forEach(e => {
    out += `### ${e.title}\n\n`;
    if (e.issuer) out += `issuer: ${e.issuer}\n`;
    if (e.date) out += `date: ${e.date}\n`;
    out += `credential_id: ${e.credential_id || ''}\n`;
    out += '\n';
  });

  out += '## Blog\n\n';
  if (s.blog.intro) out += `intro: ${s.blog.intro}\n`;
  if (s.blog.view_all_url) out += `view_all_url: ${s.blog.view_all_url}\n`;
  if (s.blog.view_all_label) out += `view_all_label: ${s.blog.view_all_label}\n`;
  out += '\n';
  s.blog.entries.forEach(e => {
    out += `### ${e.title}\n\n`;
    if (e.date) out += `date: ${e.date}\n`;
    if (e.url) out += `url: ${e.url}\n`;
    out += '\n';
  });

  out += '## Projects\n\n';
  s.projects.forEach(e => {
    out += `### ${e.title}\n\n`;
    if (e.dates) out += `dates: ${e.dates}\n`;
    if (e.tags) out += `tags: ${e.tags}\n`;
    out += '\n';
    if (e.paragraph) out += `${e.paragraph.trim()}\n\n`;
  });

  out += '## Contact\n\n';
  if (s.contact.cta_label) out += `cta_label: ${s.contact.cta_label}\n`;
  out += '\n';
  out += s.contact.paragraphs.map(p => p.trim()).filter(Boolean).join('\n\n');
  out += '\n';

  return out;
}

// ---------- base64 helpers (UTF-8 safe) ----------

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- GitHub API ----------

function getToken() {
  return localStorage.getItem(PAT_STORAGE_KEY) || '';
}

async function loadFromGitHub() {
  const headers = { Accept: 'application/vnd.github+json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}?ref=${BRANCH}`, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load content.md from GitHub (${res.status}).`);
  const json = await res.json();
  return { raw: base64ToUtf8(json.content), sha: json.sha };
}

async function saveToGitHub(newRaw, sha, message) {
  const token = getToken();
  if (!token) throw new Error('Connect a GitHub token first.');
  const res = await fetch(API_URL, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: message || 'Update portfolio content',
      content: utf8ToBase64(newRaw),
      sha,
      branch: BRANCH
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 409) {
      throw new Error('Someone/something else changed content.md since you loaded it. Reload the page and re-apply your edits.');
    }
    throw new Error(err.message || `GitHub rejected the update (${res.status}).`);
  }
  return res.json();
}

async function verifyToken(token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return false;
  const json = await res.json();
  return !!(json.permissions && json.permissions.push);
}

// ---------- state / path helpers ----------

let state = null;
let currentSha = null;

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

// ---------- rendering ----------

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

function renderForm() {
  const app = document.getElementById('app');
  const p = state.profile;

  let html = '';

  // Profile
  html += `<div class="section-block"><h2>Profile</h2>`;
  html += field('Name', 'profile.name', p.name);
  html += field('Eyebrow (e.g. "Hello, I\'m")', 'profile.eyebrow', p.eyebrow);
  html += field('Role / title', 'profile.role', p.role);
  html += field('Blurb', 'profile.blurb', p.blurb, { textarea: true });
  html += field('Email', 'profile.email', p.email);
  html += field('LinkedIn URL', 'profile.linkedin', p.linkedin);
  html += field('Footer text', 'profile.footer', p.footer);
  html += `</div>`;

  // About
  html += `<div class="section-block"><h2>About</h2>`;
  html += listEditor('about', state.about, 'A paragraph about you…', 'paragraph');
  html += `</div>`;

  // Experience
  html += `<div class="section-block"><h2>Experience</h2>`;
  state.experience.forEach((e, i) => {
    const header = `
      ${field('Title (e.g. "Role @ Company")', `experience.${i}.title`, e.title)}
      <div class="field-row">
        ${field('Tab label', `experience.${i}.tab`, e.tab)}
        ${field('Dates', `experience.${i}.dates`, e.dates)}
      </div>
      <div class="field-row">
        ${field('Location', `experience.${i}.location`, e.location)}
        ${field('Tags (comma separated)', `experience.${i}.tags`, e.tags)}
      </div>
    `;
    const body = `<label class="field-label">Bullets</label>${listEditor(`experience.${i}.bullets`, e.bullets, 'Describe what you did…', 'bullet')}`;
    html += entryCard(`experience.${i}`, i, state.experience.length, header, body);
  });
  html += `<div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-entry" data-section="experience">+ Add experience</button></div>`;
  html += `</div>`;

  // Education
  html += `<div class="section-block"><h2>Education</h2>`;
  state.education.forEach((e, i) => {
    const header = `
      ${field('Institution', `education.${i}.title`, e.title)}
      <div class="field-row">
        ${field('Degree', `education.${i}.degree`, e.degree)}
        ${field('Dates', `education.${i}.dates`, e.dates)}
      </div>
    `;
    const body = field('Description', `education.${i}.paragraph`, e.paragraph, { textarea: true });
    html += entryCard(`education.${i}`, i, state.education.length, header, body);
  });
  html += `<div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-entry" data-section="education">+ Add education</button></div>`;
  html += `</div>`;

  // Certification
  html += `<div class="section-block"><h2>Certification</h2>`;
  html += field('Intro line', 'certification.intro', state.certification.intro);
  html += `<div class="field-row">
      ${field('"View all" URL', 'certification.view_all_url', state.certification.view_all_url)}
      ${field('"View all" label', 'certification.view_all_label', state.certification.view_all_label)}
    </div>`;
  state.certification.entries.forEach((e, i) => {
    const header = `
      ${field('Certification title', `certification.entries.${i}.title`, e.title)}
      <div class="field-row">
        ${field('Issuer', `certification.entries.${i}.issuer`, e.issuer)}
        ${field('Date', `certification.entries.${i}.date`, e.date)}
      </div>
      ${field('Credential ID (optional)', `certification.entries.${i}.credential_id`, e.credential_id)}
    `;
    html += entryCard(`certification.entries.${i}`, i, state.certification.entries.length, header, '');
  });
  html += `<div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-entry" data-section="certification">+ Add certification</button></div>`;
  html += `</div>`;

  // Blog
  html += `<div class="section-block"><h2>Blog</h2>`;
  html += field('Intro line', 'blog.intro', state.blog.intro);
  html += `<div class="field-row">
      ${field('"View all" URL', 'blog.view_all_url', state.blog.view_all_url)}
      ${field('"View all" label', 'blog.view_all_label', state.blog.view_all_label)}
    </div>`;
  state.blog.entries.forEach((e, i) => {
    const header = `
      ${field('Post title', `blog.entries.${i}.title`, e.title)}
      <div class="field-row">
        ${field('Date', `blog.entries.${i}.date`, e.date)}
        ${field('URL', `blog.entries.${i}.url`, e.url)}
      </div>
    `;
    html += entryCard(`blog.entries.${i}`, i, state.blog.entries.length, header, '');
  });
  html += `<div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-entry" data-section="blog">+ Add blog post</button></div>`;
  html += `</div>`;

  // Projects
  html += `<div class="section-block"><h2>Projects</h2>`;
  state.projects.forEach((e, i) => {
    const header = `
      ${field('Project title', `projects.${i}.title`, e.title)}
      <div class="field-row">
        ${field('Dates', `projects.${i}.dates`, e.dates)}
        ${field('Tags (comma separated)', `projects.${i}.tags`, e.tags)}
      </div>
    `;
    const body = field('Description', `projects.${i}.paragraph`, e.paragraph, { textarea: true });
    html += entryCard(`projects.${i}`, i, state.projects.length, header, body);
  });
  html += `<div class="add-row"><button type="button" class="btn btn-ghost btn-small" data-action="add-entry" data-section="projects">+ Add project</button></div>`;
  html += `</div>`;

  // Contact
  html += `<div class="section-block"><h2>Contact</h2>`;
  html += field('Button label (e.g. "Say Hello")', 'contact.cta_label', state.contact.cta_label);
  html += listEditor('contact.paragraphs', state.contact.paragraphs, 'Contact section text…', 'paragraph');
  html += `</div>`;

  html += `
    <div class="savebar">
      <button id="btn-download" class="btn btn-ghost">Download content.md</button>
      <button id="btn-publish" class="btn btn-primary">Publish to GitHub</button>
    </div>
  `;

  app.innerHTML = html;
  attachFormListeners();
}

function newBlankEntry(section) {
  switch (section) {
    case 'experience': return { title: 'New Role @ Company', tab: '', dates: '', location: '', tags: '', bullets: [] };
    case 'education': return { title: 'New Institution', degree: '', dates: '', paragraph: '' };
    case 'certification': return { title: 'New Certification', issuer: '', date: '', credential_id: '' };
    case 'blog': return { title: 'New Post', date: '', url: '' };
    case 'projects': return { title: 'New Project', dates: '', tags: '', paragraph: '' };
    default: return {};
  }
}

function attachFormListeners() {
  const app = document.getElementById('app');

  app.addEventListener('input', e => {
    const el = e.target;
    const path = el.getAttribute('data-path');
    if (!path) return;
    setAt(state, path, el.value);
  });

  app.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const path = btn.getAttribute('data-path');

    if (action === 'add-item') {
      const arr = getAt(state, path);
      arr.push('');
      renderForm();
    } else if (action === 'remove-item') {
      const parts = path.split('.');
      const index = Number(parts.pop());
      const arr = getAt(state, parts.join('.'));
      arr.splice(index, 1);
      renderForm();
    } else if (action === 'add-entry') {
      const section = btn.getAttribute('data-section');
      if (section === 'certification') state.certification.entries.push(newBlankEntry('certification'));
      else if (section === 'blog') state.blog.entries.push(newBlankEntry('blog'));
      else state[section].push(newBlankEntry(section));
      renderForm();
    } else if (action === 'remove-entry') {
      removeEntryAtPath(path);
      renderForm();
    } else if (action === 'move-up' || action === 'move-down') {
      moveEntryAtPath(path, action === 'move-up' ? -1 : 1);
      renderForm();
    }
  });

  document.getElementById('btn-download').addEventListener('click', downloadMarkdown);
  document.getElementById('btn-publish').addEventListener('click', openPublishPanel);
}

function entryArrayForPath(path) {
  // path is like "experience.3" or "certification.entries.1"
  const parts = path.split('.');
  const index = Number(parts.pop());
  const arr = getAt(state, parts.join('.'));
  return { arr, index };
}

function removeEntryAtPath(path) {
  const { arr, index } = entryArrayForPath(path);
  arr.splice(index, 1);
}

function moveEntryAtPath(path, delta) {
  const { arr, index } = entryArrayForPath(path);
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= arr.length) return;
  const [item] = arr.splice(index, 1);
  arr.splice(newIndex, 0, item);
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

// ---------- publish flow ----------

function openPublishPanel() {
  const raw = stateToMarkdown(state);
  document.getElementById('preview-raw').value = raw;
  document.getElementById('publish-msg').textContent = '';
  document.getElementById('publish-msg').className = 'msg';
  const token = getToken();
  document.getElementById('btn-confirm-publish').disabled = !token;
  if (!token) {
    document.getElementById('publish-msg').textContent = 'Connect a GitHub token first (top right) before publishing.';
    document.getElementById('publish-msg').className = 'msg err';
  }
  document.getElementById('publish-panel').hidden = false;
}

function closePublishPanel() {
  document.getElementById('publish-panel').hidden = true;
}

async function confirmPublish() {
  const btn = document.getElementById('btn-confirm-publish');
  const msgEl = document.getElementById('publish-msg');
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  msgEl.textContent = '';
  msgEl.className = 'msg';
  try {
    const raw = stateToMarkdown(state);
    const message = document.getElementById('commit-message').value || 'Update portfolio content';
    const result = await saveToGitHub(raw, currentSha, message);
    currentSha = result.content.sha;
    msgEl.textContent = 'Published. The live site will update automatically within about a minute.';
    msgEl.className = 'msg ok';
    showToast('Published to GitHub ✓');
    setTimeout(closePublishPanel, 1600);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'msg err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Yes, publish now';
  }
}

// ---------- connect panel ----------

function updateConnStatus() {
  const token = getToken();
  const statusEl = document.getElementById('conn-status');
  if (token) {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status status-connected';
  } else {
    statusEl.textContent = 'Not connected';
    statusEl.className = 'status status-disconnected';
  }
}

function openConnectPanel() {
  document.getElementById('connect-msg').textContent = '';
  document.getElementById('connect-msg').className = 'msg';
  document.getElementById('connect-panel').hidden = false;
}
function closeConnectPanel() {
  document.getElementById('connect-panel').hidden = true;
}

async function saveToken() {
  const input = document.getElementById('pat-input');
  const msgEl = document.getElementById('connect-msg');
  const token = input.value.trim();
  if (!token) { msgEl.textContent = 'Paste a token first.'; msgEl.className = 'msg err'; return; }
  msgEl.textContent = 'Verifying…';
  msgEl.className = 'msg';
  const ok = await verifyToken(token).catch(() => false);
  if (!ok) {
    msgEl.textContent = "Couldn't verify write access with that token. Check the repo scope and permissions.";
    msgEl.className = 'msg err';
    return;
  }
  localStorage.setItem(PAT_STORAGE_KEY, token);
  updateConnStatus();
  msgEl.textContent = 'Connected.';
  msgEl.className = 'msg ok';
  setTimeout(closeConnectPanel, 900);
}

function forgetToken() {
  localStorage.removeItem(PAT_STORAGE_KEY);
  document.getElementById('pat-input').value = '';
  updateConnStatus();
  document.getElementById('connect-msg').textContent = 'Token removed from this browser.';
  document.getElementById('connect-msg').className = 'msg ok';
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

async function boot() {
  updateConnStatus();

  document.getElementById('btn-connect').addEventListener('click', openConnectPanel);
  document.getElementById('btn-close-connect').addEventListener('click', closeConnectPanel);
  document.getElementById('btn-save-pat').addEventListener('click', saveToken);
  document.getElementById('btn-forget-pat').addEventListener('click', forgetToken);
  document.getElementById('btn-toggle-pat').addEventListener('click', () => {
    const input = document.getElementById('pat-input');
    const btn = document.getElementById('btn-toggle-pat');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
  });
  document.getElementById('btn-cancel-publish').addEventListener('click', closePublishPanel);
  document.getElementById('btn-confirm-publish').addEventListener('click', confirmPublish);

  try {
    const { raw, sha } = await loadFromGitHub();
    currentSha = sha;
    const model = parseContent(raw);
    state = modelToState(model);
    renderForm();
  } catch (err) {
    document.getElementById('app').innerHTML = `<p class="loading">Couldn't load content.md: ${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', boot);
