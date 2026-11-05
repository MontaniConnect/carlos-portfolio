// ===== Mobile nav toggle (static elements, bound once) =====
const navToggle = document.getElementById('nav-toggle');
const sidebar = document.getElementById('sidebar');
const navScrim = document.getElementById('nav-scrim');

function closeNav() {
  navToggle.classList.remove('open');
  navToggle.setAttribute('aria-expanded', 'false');
  sidebar.classList.remove('open');
  navScrim.classList.remove('open');
}

navToggle.addEventListener('click', () => {
  const isOpen = sidebar.classList.toggle('open');
  navToggle.classList.toggle('open', isOpen);
  navToggle.setAttribute('aria-expanded', String(isOpen));
  navScrim.classList.toggle('open', isOpen);
});
navScrim.addEventListener('click', closeNav);

// ===== Delegated clicks (survive re-renders from content.js) =====
document.body.addEventListener('click', e => {
  const navLink = e.target.closest('.sidebar-nav a');
  if (navLink) {
    closeNav();
    return;
  }

  const tabBtn = e.target.closest('.tab-btn');
  if (tabBtn) {
    const target = tabBtn.dataset.tab;
    const tabList = tabBtn.closest('.tab-list');
    const tabsRoot = tabBtn.closest('.tabs');

    tabList.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b === tabBtn);
      b.setAttribute('aria-selected', String(b === tabBtn));
    });

    tabsRoot.querySelectorAll('.tab-panel').forEach(panel => {
      const match = panel.id === `panel-${target}`;
      panel.classList.toggle('active', match);
      panel.hidden = !match;
    });
  }
});

// ===== Scroll-spy + reveal-on-scroll (re-attached after each render) =====
let spyObserver = null;
let revealObserver = null;

function setupObservers() {
  if (spyObserver) spyObserver.disconnect();
  if (revealObserver) revealObserver.disconnect();

  const sections = document.querySelectorAll('.section[id]');
  const navLinks = document.querySelectorAll('.sidebar-nav a');

  spyObserver = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          navLinks.forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
          });
        }
      });
    },
    { rootMargin: '-40% 0px -50% 0px', threshold: 0 }
  );
  sections.forEach(section => spyObserver.observe(section));

  document.querySelectorAll('.section').forEach(el => el.classList.add('reveal'));
  revealObserver = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 }
  );
  document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
}

document.addEventListener('content:rendered', setupObservers);
