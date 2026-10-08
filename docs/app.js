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

document.querySelectorAll('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
}));
