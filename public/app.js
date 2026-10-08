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
  const regionSelect = document.getElementById('region-filter');
  const updateFilters = () => {
    let visible = 0;
    lectureGrid.querySelectorAll('.lecture-card').forEach(card => {
      const show = (month === 'all' || card.dataset.month === month) && (regionSelect.value === 'all' || card.dataset.region === regionSelect.value);
      card.hidden = !show;
      if (show) visible += 1;
    });
    document.querySelector('.no-filter-results').hidden = visible > 0;
  };
  document.querySelectorAll('[data-filter-month]').forEach(button => button.addEventListener('click', () => {
    month = button.dataset.filterMonth;
    document.querySelectorAll('[data-filter-month]').forEach(item => item.classList.toggle('active', item === button));
    updateFilters();
  }));
  regionSelect.addEventListener('change', updateFilters);
}

document.querySelectorAll('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
}));
