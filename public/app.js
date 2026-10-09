const menuButton = document.querySelector('.menu-toggle');
if (menuButton) {
  const menuIcon = menuButton.querySelector('b');
  const closeMenu = () => {
    document.body.classList.remove('menu-open');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', '메뉴 열기');
    menuIcon.textContent = '☰';
  };
  menuButton.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
    menuIcon.textContent = open ? '✕' : '☰';
  });
  document.querySelectorAll('.main-nav a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
}

const lectureGrid = document.getElementById('lecture-grid');
if (lectureGrid) {
  let month = 'all';
  let shownCount = 5;
  const regionSelect = document.getElementById('region-filter');
  const moreButton = document.getElementById('lecture-show-more');
  const mobileList = window.matchMedia('(max-width: 760px)');
  const updateFilters = () => {
    let matched = 0;
    lectureGrid.querySelectorAll('.lecture-card').forEach(card => {
      const matches = (month === 'all' || card.dataset.month === month) && (regionSelect.value === 'all' || card.dataset.region === regionSelect.value);
      if (matches) matched += 1;
      card.hidden = !matches || (mobileList.matches && matched > shownCount);
    });
    document.querySelector('.no-filter-results').hidden = matched > 0;
    const remaining = matched - shownCount;
    moreButton.hidden = !mobileList.matches || remaining <= 0;
    if (!moreButton.hidden) moreButton.textContent = `강의 ${Math.min(5, remaining)}개 더 보기 (남은 ${remaining}개)`;
  };
  document.querySelectorAll('[data-filter-month]').forEach(button => button.addEventListener('click', () => {
    month = button.dataset.filterMonth;
    shownCount = 5;
    document.querySelectorAll('[data-filter-month]').forEach(item => item.classList.toggle('active', item === button));
    updateFilters();
  }));
  regionSelect.addEventListener('change', () => { shownCount = 5; updateFilters(); });
  moreButton.addEventListener('click', () => { shownCount += 5; updateFilters(); });
  mobileList.addEventListener('change', updateFilters);
  updateFilters();
}

const registrationLayer = document.getElementById('register');
const registrationOpenButton = document.querySelector('.registration-dock-button');
const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const query = new URLSearchParams(window.location.search);
if (query.has('registered')) {
  const confirmation = document.querySelector('.registration-success');
  if (confirmation) confirmation.hidden = false;
}
utmKeys.forEach(key => {
  const fromUrl = query.get(key);
  if (fromUrl !== null) {
    try { window.sessionStorage.setItem(key, fromUrl.slice(0, 120)); } catch { /* Storage may be disabled. */ }
  }
  const field = document.querySelector(`.registration-form input[name="${key}"]`);
  if (field) {
    let value = fromUrl;
    if (value === null) { try { value = window.sessionStorage.getItem(key); } catch { value = ''; } }
    field.value = String(value || '').slice(0, 120);
  }
});
if (registrationLayer && registrationOpenButton) {
  const registrationSheet = registrationLayer.querySelector('.registration-sheet');
  const closeButtons = registrationLayer.querySelectorAll('[data-registration-close]');
  let previousFocus = null;
  const openRegistration = () => {
    previousFocus = document.activeElement;
    registrationLayer.classList.add('is-open');
    registrationLayer.setAttribute('aria-hidden', 'false');
    registrationOpenButton.setAttribute('aria-expanded', 'true');
    document.body.classList.add('registration-open');
    window.setTimeout(() => registrationSheet.querySelector('input:not([type="hidden"])')?.focus(), 160);
  };
  const closeRegistration = () => {
    registrationLayer.classList.remove('is-open');
    registrationLayer.setAttribute('aria-hidden', 'true');
    registrationOpenButton.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('registration-open');
    if (window.location.hash === '#register') window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    (previousFocus instanceof HTMLElement ? previousFocus : registrationOpenButton).focus();
  };
  registrationOpenButton.addEventListener('click', openRegistration);
  closeButtons.forEach(button => button.addEventListener('click', closeRegistration));
  document.addEventListener('keydown', event => {
    if (!registrationLayer.classList.contains('is-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeRegistration(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...registrationSheet.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')].filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  if (window.location.hash === '#register' || new URLSearchParams(window.location.search).has('registered')) openRegistration();
}

document.querySelectorAll('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
}));
