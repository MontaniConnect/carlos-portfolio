/**
 * content.js — parses content.md into a model and renders the portfolio DOM.
 * content.md is the single source of truth: edit it, and (re)loading the
 * page re-fetches and re-renders from it. No HTML edits required.
 *
 * The model is an ORDERED LIST of sections (array, not a dictionary), so the
 * section order in content.md drives both the sidebar nav and the main
 * content order. Each section carries a `layout` — either inferred from its
 * heading text (About/Experience/Education/Certification/Blog/Projects/
 * Contact) or set explicitly via a `layout:` meta line, which lets a section
 * be renamed without losing its specialized rendering. Any section whose
 * layout doesn't match a known one renders with a generic card layout.
 */

const CONTENT_URL = 'content.md';
const POLL_INTERVAL_MS = 4000;

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
const DEFAULT_HEADING_TEXT = {
  about: 'About Me', experience: "Where I've Worked", certification: 'Certification',
  blog: 'Blog', projects: 'Projects', contact: "What's Next?"
};

function inferDefaultLayout(title) {
  return DEFAULT_LAYOUT_FOR_TITLE[title] || 'custom';
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMd(str) {
  let s = escapeHtml(str || '');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

// ---------- Parsing ----------

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

// ---------- Rendering ----------

function displayHeadingFor(section) {
  const plainDefault = { about: 'About', experience: 'Experience', certification: 'Certification', blog: 'Blog', projects: 'Projects', contact: 'Contact' }[section.layout];
  if (plainDefault && section.title === plainDefault) return DEFAULT_HEADING_TEXT[section.layout];
  return section.title;
}

function visibleSections(model) {
  return model.sections.filter(s => s.layout !== 'education');
}

function renderSidebar(model) {
  const p = model.profile;
  const navItems = visibleSections(model)
    .map((s, i) => `
      <li><a href="#${slug(s.title)}"><span class="nav-num">${String(i + 1).padStart(2, '0')}.</span> ${escapeHtml(s.title)}</a></li>
    `).join('');

  const blogSection = model.sections.find(s => s.layout === 'blog');
  const blogUrl = (blogSection && blogSection.meta.view_all_url) || '#';

  document.getElementById('sidebar-root').innerHTML = `
    <div class="sidebar-top">
      <p class="eyebrow">${escapeHtml(p.eyebrow || '')}</p>
      <h1 class="name">${escapeHtml(p.name || '')}</h1>
      <h2 class="role">${escapeHtml(p.role || '')}</h2>
      <p class="blurb">${escapeHtml(p.blurb || '')}</p>
    </div>
    <nav class="sidebar-nav" aria-label="In-page">
      <ol>${navItems}</ol>
    </nav>
    <ul class="social-row" aria-label="Social links">
      <li><a href="${escapeHtml(p.linkedin || '#')}" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.38-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45z"/></svg>
      </a></li>
      <li><a href="${escapeHtml(blogUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Blog">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 4h16v2H4V4zm0 14h10v2H4v-2zm0-7h16v2H4v-2z"/></svg>
      </a></li>
      <li><a href="mailto:${escapeHtml(p.email || '')}" aria-label="Email">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>
      </a></li>
    </ul>
  `;
}

function heading(numStr, text) {
  return `<h3 class="section-heading"><span class="num">${numStr}.</span> ${escapeHtml(text)} <span class="rule"></span></h3>`;
}

function renderAbout(section, numStr) {
  const body = section.paragraphs.map(p => `<p>${inlineMd(p)}</p>`).join('');
  return `<section id="${slug(section.title)}" class="section">${heading(numStr, displayHeadingFor(section))}<div class="section-body">${body}</div></section>`;
}

function renderExperience(expSection, eduSection, numStr) {
  const entries = expSection.entries;
  const tabs = entries.map((e, i) => `
    <button class="tab-btn${i === 0 ? ' active' : ''}" role="tab" aria-selected="${i === 0}" data-tab="exp-${i}">${escapeHtml(e.meta.tab || e.title)}</button>
  `).join('');

  const panels = entries.map((e, i) => {
    const [roleTitle, atCompany] = splitAt(e.title);
    const dates = e.meta.dates || '';
    const location = e.meta.location || '';
    const dateLine = [dates, location].filter(Boolean).join(' · ');
    const bullets = e.bullets.length
      ? `<ul>${e.bullets.map(b => `<li>${inlineMd(b)}</li>`).join('')}</ul>` : '';
    const tags = e.meta.tags
      ? `<ul class="tech-tags">${e.meta.tags.split(',').map(t => `<li>${escapeHtml(t.trim())}</li>`).join('')}</ul>` : '';
    return `
      <article class="tab-panel${i === 0 ? ' active' : ''}" id="panel-exp-${i}" role="tabpanel" ${i === 0 ? '' : 'hidden'}>
        <h4>${inlineMd(roleTitle)}${atCompany ? ` <span class="at">@ ${inlineMd(atCompany)}</span>` : ''}</h4>
        ${dateLine ? `<p class="dates">${escapeHtml(dateLine)}</p>` : ''}
        ${bullets}
        ${tags}
      </article>
    `;
  }).join('');

  const eduItems = (eduSection ? eduSection.entries : []).map(e => `
    <div class="edu-item">
      <h5>${escapeHtml(e.title)}</h5>
      <p class="dates">${escapeHtml([e.meta.degree, e.meta.dates].filter(Boolean).join(' · '))}</p>
      ${e.paragraphs.map(p => `<p>${inlineMd(p)}</p>`).join('')}
    </div>
  `).join('');

  return `
    <section id="${slug(expSection.title)}" class="section">
      ${heading(numStr, displayHeadingFor(expSection))}
      <div class="section-body">
        <div class="tabs" id="exp-tabs">
          <div class="tab-list" role="tablist" aria-label="Job tabs">${tabs}</div>
          <div class="tab-panels">${panels}</div>
        </div>
        ${eduItems ? `<div class="education"><h4 class="sub-heading">Education</h4>${eduItems}</div>` : ''}
      </div>
    </section>
  `;
}

function splitAt(title) {
  const idx = title.indexOf(' @ ');
  if (idx === -1) return [title, ''];
  return [title.slice(0, idx), title.slice(idx + 3)];
}

function renderCertification(section, numStr) {
  const intro = section.meta.intro ? `<p class="section-intro">${inlineMd(section.meta.intro)}</p>` : '';
  const cards = section.entries.map(e => `
    <div class="cert-card">
      <div class="cert-head">
        <span class="cert-issuer">${escapeHtml(e.meta.issuer || '')}</span>
        <span class="cert-date">${escapeHtml(e.meta.date || '')}</span>
      </div>
      <h5>${escapeHtml(e.title)}</h5>
      ${e.meta.credential_id ? `<p class="cert-id">Credential ID ${escapeHtml(e.meta.credential_id)}</p>` : ''}
    </div>
  `).join('');
  const viewAll = section.meta.view_all_url
    ? `<a class="view-all" href="${escapeHtml(section.meta.view_all_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(section.meta.view_all_label || 'View all')} &nearr;</a>`
    : '';
  return `
    <section id="${slug(section.title)}" class="section">
      ${heading(numStr, displayHeadingFor(section))}
      <div class="section-body">
        ${intro}
        <div class="cert-grid">${cards}</div>
        ${viewAll}
      </div>
    </section>
  `;
}

function renderBlog(section, numStr) {
  const intro = section.meta.intro ? `<p class="section-intro">${inlineMd(section.meta.intro)}</p>` : '';
  const items = section.entries.map(e => `
    <li><a href="${escapeHtml(e.meta.url || '#')}" target="_blank" rel="noopener noreferrer">
      <span class="blog-date">${escapeHtml(e.meta.date || '')}</span>
      <span class="blog-title">${escapeHtml(e.title)}</span>
      <span class="blog-arrow">&nearr;</span>
    </a></li>
  `).join('');
  const viewAll = section.meta.view_all_url
    ? `<a class="view-all" href="${escapeHtml(section.meta.view_all_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(section.meta.view_all_label || 'View all')} &nearr;</a>`
    : '';
  return `
    <section id="${slug(section.title)}" class="section">
      ${heading(numStr, displayHeadingFor(section))}
      <div class="section-body">
        ${intro}
        <ul class="blog-list">${items}</ul>
        ${viewAll}
      </div>
    </section>
  `;
}

function renderProjects(section, numStr) {
  const folderIcon = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
  const cards = section.entries.map(e => `
    <div class="project-card">
      <div class="project-card-top">${folderIcon}</div>
      <h5>${escapeHtml(e.title)}</h5>
      ${e.meta.dates ? `<p class="dates">${escapeHtml(e.meta.dates)}</p>` : ''}
      ${e.paragraphs.map(p => `<p>${inlineMd(p)}</p>`).join('')}
      ${e.meta.tags ? `<ul class="tech-tags">${e.meta.tags.split(',').map(t => `<li>${escapeHtml(t.trim())}</li>`).join('')}</ul>` : ''}
    </div>
  `).join('');
  return `
    <section id="${slug(section.title)}" class="section">
      ${heading(numStr, displayHeadingFor(section))}
      <div class="section-body"><div class="project-grid">${cards}</div></div>
    </section>
  `;
}

function renderContact(section, numStr, profile) {
  const body = section.paragraphs.map(p => `<p>${inlineMd(p)}</p>`).join('');
  return `
    <section id="${slug(section.title)}" class="section contact-section">
      ${heading(numStr, displayHeadingFor(section))}
      <div class="section-body contact-body">
        ${body}
        <a class="big-email" href="mailto:${escapeHtml(profile.email || '')}">${escapeHtml(section.meta.cta_label || 'Say Hello')}</a>
      </div>
    </section>
  `;
}

function renderCustomSection(section, numStr) {
  const intro = section.meta.intro ? `<p class="section-intro">${inlineMd(section.meta.intro)}</p>` : '';
  const cards = section.entries.map(e => {
    const dates = e.meta.dates ? `<p class="dates">${escapeHtml(e.meta.dates)}</p>` : '';
    const paragraphs = e.paragraphs.map(p => `<p>${inlineMd(p)}</p>`).join('');
    const bullets = e.bullets.length ? `<ul>${e.bullets.map(b => `<li>${inlineMd(b)}</li>`).join('')}</ul>` : '';
    const tags = e.meta.tags
      ? `<ul class="tech-tags">${e.meta.tags.split(',').map(t => `<li>${escapeHtml(t.trim())}</li>`).join('')}</ul>` : '';
    return `
      <div class="custom-card">
        <h5>${escapeHtml(e.title)}</h5>
        ${dates}
        ${paragraphs}
        ${bullets}
        ${tags}
      </div>
    `;
  }).join('');
  return `
    <section id="${slug(section.title)}" class="section">
      ${heading(numStr, section.title)}
      <div class="section-body">
        ${intro}
        <div class="custom-grid">${cards}</div>
      </div>
    </section>
  `;
}

function renderMain(model) {
  const eduSection = model.sections.find(s => s.layout === 'education');
  let html = '';
  let num = 1;

  visibleSections(model).forEach(sec => {
    const numStr = String(num++).padStart(2, '0');
    switch (sec.layout) {
      case 'about': html += renderAbout(sec, numStr); break;
      case 'experience': html += renderExperience(sec, eduSection, numStr); break;
      case 'certification': html += renderCertification(sec, numStr); break;
      case 'blog': html += renderBlog(sec, numStr); break;
      case 'projects': html += renderProjects(sec, numStr); break;
      case 'contact': html += renderContact(sec, numStr, model.profile); break;
      default: html += renderCustomSection(sec, numStr); break;
    }
  });

  html += `<footer class="footer"><p>${inlineMd(model.profile.footer || '')}</p></footer>`;

  document.getElementById('sections-root').innerHTML = html;
}

function render(model) {
  renderSidebar(model);
  renderMain(model);
  document.dispatchEvent(new CustomEvent('content:rendered'));
}

// ---------- Fetch + live sync ----------

let lastRaw = null;

async function fetchContent() {
  const res = await fetch(`${CONTENT_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${CONTENT_URL}: ${res.status}`);
  return res.text();
}

async function loadAndRender(isInitial) {
  try {
    const raw = await fetchContent();
    if (raw === lastRaw) return;
    lastRaw = raw;
    const model = parseContent(raw);
    render(model);
  } catch (err) {
    if (isInitial) {
      document.getElementById('sections-root').innerHTML = `
        <section class="section">
          <div class="section-body">
            <p>Couldn't load <code>content.md</code>. If you opened this file directly
            (file://), serve the folder with a local server instead, e.g.
            <code>python3 -m http.server</code> or <code>vercel dev</code>, then reload.</p>
          </div>
        </section>
      `;
    }
    console.error(err);
  }
}

function startPolling() {
  setInterval(() => loadAndRender(false), POLL_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', () => {
  loadAndRender(true).then(startPolling);
});
