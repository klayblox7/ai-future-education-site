const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { createRegistrationAdmin } = require('./scripts/registration-admin');
const { backupData } = require('./scripts/backup-data');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'site.sqlite'));
const reviewsTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviews'").get());
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS lectures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, topic TEXT NOT NULL DEFAULT 'AI 활용', summary TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL, region TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '오프라인', price_label TEXT NOT NULL DEFAULT '상세 페이지 참조',
  landing_url TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT NOT NULL,
  kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  name TEXT NOT NULL, contact TEXT NOT NULL, gender TEXT NOT NULL, age_range TEXT NOT NULL,
  session_preference TEXT NOT NULL, referral_source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lecture_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
  placement TEXT NOT NULL DEFAULT 'gallery',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  image_path TEXT NOT NULL, image_alt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
if (!reviewsTableExists) {
  const insertReview = db.prepare('INSERT INTO reviews(title,body,image_path,image_alt,sort_order,published) VALUES(?,?,?,?,?,1)');
  [
    ['함께 모여 배우는 AI', '여러 세대가 한자리에 모여 AI를 일상에 활용하는 방법을 함께 살펴봤습니다.', 'review-b1.jpg', '강연장을 가득 채운 참가자들이 발표를 듣는 모습'],
    ['배움으로 채운 강의실', '큰 화면의 설명을 따라가며 낯선 AI 도구를 조금씩 친숙하게 만나는 시간이었습니다.', 'review-b2.jpg', '강의실에서 참가자들이 화면을 보며 강연을 듣는 모습'],
    ['눈으로 보고 익히는 실습', '실제 사용 화면을 보며 단계를 하나씩 확인하니 AI 활용법이 한층 선명해집니다.', 'review-b3.jpg', '강사가 AI 도구 사용 화면을 시연하는 모습'],
    ['함께 나누는 새로운 가능성', '현장의 집중과 배움의 열기 속에서 각자의 일상에 쓸 아이디어를 발견했습니다.', 'review-b4.jpg', '참가자들이 강사의 설명과 발표 자료를 보는 모습']
  ].forEach(([title, body, image, alt], index) => insertReview.run(title, body, `/assets/${image}`, alt, index + 1));
}
if (!db.prepare('PRAGMA table_info(lectures)').all().some(column => column.name === 'audience')) {
  db.exec("ALTER TABLE lectures ADD COLUMN audience TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(lectures)').all().some(column => column.name === 'detail_body')) {
  db.exec("ALTER TABLE lectures ADD COLUMN detail_body TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(lecture_images)').all().some(column => column.name === 'placement')) {
  db.exec("ALTER TABLE lecture_images ADD COLUMN placement TEXT NOT NULL DEFAULT 'gallery'");
}
for (const column of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
  if (!db.prepare('PRAGMA table_info(registrations)').all().some(item => item.name === column)) db.exec(`ALTER TABLE registrations ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}
for (const [column, definition] of Object.entries({ status: "TEXT NOT NULL DEFAULT '접수'", notes: "TEXT NOT NULL DEFAULT ''", consent_at: "TEXT NOT NULL DEFAULT ''", consent_version: "TEXT NOT NULL DEFAULT ''" })) {
  if (!db.prepare('PRAGMA table_info(registrations)').all().some(item => item.name === column)) db.exec(`ALTER TABLE registrations ADD COLUMN ${column} ${definition}`);
}
const CONSENT_VERSION = '2026-10-09-v1';
// Only enable this behind a trusted ingress that appends the visitor IP.
const clientIp = req => {
  const hops = Number(process.env.TRUST_PROXY_HOPS || 0);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim());
  const candidate = hops > 0 ? forwarded[forwarded.length - hops] : '';
  return isIP(candidate || '') ? candidate : req.socket.remoteAddress || 'unknown';
};
const purgeExpiredPersonalData = () => {
  db.exec("DELETE FROM inquiries WHERE created_at < datetime('now', '-1 year')");
  db.exec("DELETE FROM registrations WHERE created_at < datetime('now', '-1 year')");
};
purgeExpiredPersonalData();
setInterval(purgeExpiredPersonalData, 24 * 60 * 60 * 1000).unref();

const sessions = new Map();
const loginAttempts = new Map();
const inquiryAttempts = new Map();
const e = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateText = value => { const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? `${m[1]}.${m[2]}.${m[3]}  ${m[4]}:${m[5]}` : e(value); };
const monthText = value => String(value || '').slice(0, 7).replace('-', '.');
const safeUrl = value => { try { const u = new URL(String(value)); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
const nav = `<header class="site-header"><div class="container nav-inner"><a class="brand" href="/" aria-label="AI 미래교육원 홈"><span class="brand-crop"><img src="/assets/logo-original.png" alt="AI 미래교육원"></span></a><nav class="main-nav" id="main-nav" aria-label="주요 메뉴"><a href="/#lectures">강의 일정</a><a href="/#approach">교육 방식</a><a href="/#about">교육원 소개</a><a href="/#faq">자주 묻는 질문</a><a class="mobile-nav-contact" href="/#contact">문의하기</a></nav><a class="nav-cta" href="/#contact">교육 문의</a><button class="menu-toggle" type="button" aria-controls="main-nav" aria-label="메뉴 열기" aria-expanded="false"><span>메뉴</span><b aria-hidden="true">☰</b></button></div></header>`;
const footer = `<footer class="footer"><div class="container footer-grid"><div><a class="footer-logo" href="/" aria-label="AI 미래교육원 홈"><span class="brand-crop"><img src="/assets/logo-original.png" alt="AI 미래교육원"></span></a></div><div><strong>안내</strong><a href="/#lectures">강의 일정</a><a href="/#about">교육원 소개</a><a href="/#faq">자주 묻는 질문</a><a href="/#contact">문의하기</a></div><div><strong>운영 정보</strong><p>(주)반도생활건강<br>부산광역시 금정구 중앙대로 2014<br>대표 박인우 · 사업자등록번호 607-81-98610<br>대표번호 <a href="tel:18776201">1877-6201</a></p></div></div><div class="container footer-bottom"><span>© ${new Date().getFullYear()} AI 미래교육원</span><a href="/privacy">개인정보처리방침</a><a href="/admin">관리자</a></div></footer><div class="mobile-actionbar"><a href="/#lectures">강의 일정</a><a href="/#contact">문의하기</a></div>`;
const html = (title, content, { admin = false, subpage = false } = {}) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#ffffff"><meta name="description" content="AI 미래교육원. ChatGPT, Gemini, Claude를 쉽게 배우고 직접 사용해 보는 AI 강의."><title>${e(title)} | AI 미래교육원</title><link rel="icon" href="/assets/symbol-new.png"><link rel="stylesheet" href="/style.css">${admin ? '' : '<link rel="stylesheet" href="/site.css?v=26">'}</head><body class="${admin ? 'admin-body' : ''} ${subpage ? 'subpage' : ''}">${admin ? '' : nav}${content}${admin ? '' : footer}<script src="/app.js?v=4" defer></script></body></html>`;
const send = (res, status, body, type = 'text/html; charset=utf-8', headers = {}) => { res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'", ...headers }); res.end(body); };
const redirect = (res, url, headers = {}) => { res.writeHead(303, { Location: url, ...headers }); res.end(); };
const readBody = req => new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 32000) { reject(new Error('입력 내용이 너무 깁니다.')); req.destroy(); } }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body)))); req.on('error', reject); });
const readUpload = (req, maxBytes = 24 * 1024 * 1024) => new Promise((resolve, reject) => { const chunks = []; let size = 0; let exceeded = false; req.on('data', chunk => { if (exceeded) return; size += chunk.length; if (size > maxBytes) { exceeded = true; reject(new Error('파일 용량이 너무 큽니다.')); req.resume(); return; } chunks.push(chunk); }); req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); }); req.on('error', reject); });
const imageType = bytes => {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
};
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
const currentSession = req => { const token = cookie(req).session; const session = token && sessions.get(token); if (!session || session.expires < Date.now()) return null; return session; };
const newSession = () => { const token = crypto.randomBytes(32).toString('hex'); const session = { csrf: crypto.randomBytes(24).toString('hex'), expires: Date.now() + 8 * 60 * 60 * 1000 }; sessions.set(token, session); return token; };
const secureCookie = req => req.socket.encrypted || PUBLIC_ORIGIN.startsWith('https://') ? '; Secure' : '';
const verifyOrigin = req => { const origin = req.headers.origin; if (!origin) return true; const expected = PUBLIC_ORIGIN || `http://${req.headers.host}`; return origin === expected; };
const csrfField = session => `<input type="hidden" name="csrf" value="${e(session.csrf)}">`;
const csvCell = value => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
const adminShell = (title, content) => html(title, `<header class="admin-header"><a href="/admin" class="admin-logo">AI 미래교육원 <span>관리자</span></a><nav><a href="/admin">대시보드</a><a href="/admin/lectures/new">강의 추가</a><a href="/admin/reviews">후기 관리</a><a href="/admin/instructors/new">강사 추가</a><a href="/admin/registrations">강의 신청</a><a href="/admin/inquiries">문의함</a><a href="/" target="_blank" rel="noopener">사이트 보기 ↗</a><form action="/admin/logout" method="post"><button>로그아웃</button></form></nav></header><main class="admin-main"><div class="admin-heading"><p class="eyebrow">OPERATIONS</p><h1>${e(title)}</h1></div>${content}</main>`, { admin: true });

function lectureCard(item) {
  const detail = `/lectures/${item.id}`;
  const start = String(item.start_at);
  const mobileDate = `${Number(start.slice(5, 7))}월 ${Number(start.slice(8, 10))}일`;
  const mobileMeta = [start.slice(11, 16), item.region || item.format].filter(Boolean).join(' · ');
  return `<article class="lecture-card" data-region="${e(item.region)}" data-month="${e(start.slice(0, 7))}">${item.cover_file ? `<a class="lecture-cover" href="${detail}"><img src="/uploads/${e(item.cover_file)}" alt="${e(item.title)}" loading="lazy"></a>` : ''}<div class="lecture-content"><div class="lecture-top"><span class="lecture-date">${e(dateText(item.start_at))}</span><span class="lecture-topic">${e(item.topic)}</span></div><h3><a href="${detail}">${e(item.title)}</a></h3>${item.summary ? `<p>${e(item.summary)}</p>` : ''}${item.audience ? `<p class="lecture-audience"><strong>추천 대상</strong> ${e(item.audience)}</p>` : ''}<div class="lecture-details"><span>📍 ${e(item.region || item.format)}${item.location ? ` · ${e(item.location)}` : ''}</span><span>${e(item.price_label)}</span></div><a class="lecture-link" href="${detail}" aria-label="${e(item.title)} 상세 페이지 열기">강의 자세히 보기 <span aria-hidden="true">→</span></a></div><a class="lecture-mobile-row" href="${detail}" aria-label="${e(mobileDate)} ${e(item.title)}, ${e(mobileMeta)}. 자세히 보기">${item.cover_file ? `<span class="lecture-mobile-thumb" aria-hidden="true"><img src="/uploads/${e(item.cover_file)}" alt="" loading="lazy"></span>` : `<span class="lecture-mobile-date" aria-hidden="true"><strong>${e(start.slice(8, 10))}</strong><small>${e(Number(start.slice(5, 7)))}월</small></span>`}<span class="lecture-mobile-info"><small class="lecture-mobile-schedule">${e(mobileDate)} · ${e(start.slice(11, 16))}</small><strong>${e(item.title)}</strong><small class="lecture-mobile-place">${e(item.region || item.format)}</small></span><span class="lecture-mobile-arrow" aria-hidden="true">→</span></a></article>`;
}

function renderHome(message = '') {
  const lectures = db.prepare("SELECT lectures.*, (SELECT filename FROM lecture_images WHERE lecture_id=lectures.id AND placement='gallery' ORDER BY id LIMIT 1) AS cover_file FROM lectures WHERE published=1 AND substr(start_at,1,10)>=? ORDER BY start_at ASC, id ASC").all(today());
  const instructors = db.prepare('SELECT * FROM instructors WHERE published=1 ORDER BY id ASC').all();
  const reviews = db.prepare('SELECT * FROM reviews WHERE published=1 ORDER BY sort_order ASC, id ASC').all();
  const reviewArea = reviews.length ? `<div class="review-grid">${reviews.map(x => `<article class="review-card"><img src="${e(x.image_path)}" alt="${e(x.image_alt || x.title)}" loading="lazy"><div class="review-copy"><h3>${e(x.title)}</h3><p>${e(x.body)}</p></div></article>`).join('')}</div>` : '<p class="review-empty">수업 현장을 곧 소개하겠습니다.</p>';
  const months = [...new Set(lectures.map(x => x.start_at.slice(0, 7)))];
  const regions = [...new Set(lectures.map(x => x.region).filter(Boolean))];
  const filters = lectures.length ? `<div class="filters"><div class="filter-group"><button class="filter active" data-filter-month="all">전체 일정</button>${months.map(x => `<button class="filter" data-filter-month="${e(x)}">${e(monthText(x))}</button>`).join('')}</div><label class="region-select">지역 <select id="region-filter"><option value="all">전체 지역</option>${regions.map(x => `<option value="${e(x)}">${e(x)}</option>`).join('')}</select></label></div>` : '';
  const lectureArea = lectures.length ? `<div class="lecture-grid" id="lecture-grid">${lectures.map(lectureCard).join('')}</div><button class="lecture-show-more" id="lecture-show-more" type="button" aria-controls="lecture-grid" hidden></button><p class="no-filter-results" hidden>선택한 조건의 강의가 없습니다. 다른 월이나 지역을 선택해 주세요.</p>` : `<div class="empty-events"><div class="empty-icon">✦</div><h3>강의 일정을 준비하고 있어요</h3><p>일정이 확정되면 이곳에서 날짜와 장소를 확인하고 바로 신청할 수 있습니다.</p><a class="text-link" href="#contact">궁금한 점 문의하기 →</a></div>`;
  const instructorArea = instructors.length ? `<div class="instructor-grid">${instructors.map(x => `<article class="instructor-card"><div class="instructor-photo">${safeUrl(x.photo_url) ? `<img src="${e(safeUrl(x.photo_url))}" alt="${e(x.name)} 강사">` : `<span>${e(x.name.slice(0, 1))}</span>`}</div><div><span class="tag">${e(x.role || '전문 강사')}</span><h3>${e(x.name)}</h3><p>${e(x.bio)}</p></div></article>`).join('')}</div>` : `<img class="instructor-feature-image" src="/assets/instructor-profile.png" alt="AI 미래교육원 강사 김아현 대표의 주요 경력과 강의 활동 소개" width="1448" height="1024" loading="lazy">`;
  return html('쉽게 배우는 AI 강의', `<main><section class="hero"><div class="container hero-inner"><div class="hero-copy"><h1>AI를 배우는 첫걸음,<br><em>여기서 시작하세요.</em></h1><p class="hero-description">ChatGPT·Gemini·Claude. 낯선 이름도 직접 써보면 가까워집니다. 내 일상과 일에 맞는 강의를 골라, 강사와 함께 차근차근 배워보세요.</p><div class="hero-actions"><a class="button button-primary" href="#lectures">강의 일정 보기 <span>↗</span></a><a class="button button-outline" href="#approach">어떻게 배우나요?</a></div></div></div><div class="container hero-illustration"><img src="/assets/hero-ai-tools.png" alt="여러 세대가 함께 ChatGPT, Gemini, Claude를 배우고 일상에 활용하는 일러스트" width="1672" height="941"></div><div class="container hero-footnote"><span>처음 시작하는 분도, 더 잘 쓰고 싶은 분도</span><span>AI 미래교육원</span></div></section>
  <section class="section lectures-section" id="lectures"><div class="container"><div class="section-head"><div><p class="eyebrow">강의 일정</p><h2>나에게 맞는 강의를 찾아보세요</h2><p class="section-sub">날짜와 지역을 확인하고 강의를 누르면 자세한 내용을 볼 수 있어요.</p></div></div>${filters}${lectureArea}</div></section>
  <section class="section approach-section" id="approach"><div class="container"><div class="section-head"><div><h2>어렵게 설명하지 않을게요</h2><p class="section-sub">처음 배우는 분도 직접 해보며 익힐 수 있도록 준비합니다.</p></div></div><div class="approach-grid"><article><div class="approach-copy"><h3>AI 기초부터 차근차근</h3><p>낯선 용어도 쉽게 배워요.</p></div><div class="approach-art art-basics" aria-hidden="true"></div></article><article><div class="approach-copy"><h3>보면서 직접 실습</h3><p>강사와 하나씩 따라 해요.</p></div><div class="approach-art art-practice" aria-hidden="true"></div></article><article><div class="approach-copy"><h3>막히면 바로 질문</h3><p>궁금한 건 그 자리에서 물어요.</p></div><div class="approach-art art-question" aria-hidden="true"></div></article><article><div class="approach-copy"><h3>배운 뒤 바로 활용</h3><p>일상과 업무에 써봐요.</p></div><div class="approach-art art-life" aria-hidden="true"></div></article></div></div></section>
  <section class="section about-section" id="about"><div class="container about-grid"><div class="about-card"><img src="/assets/about-learning.jpg" alt="AI 미래교육원 강사와 학습자가 함께 AI를 배우는 장면. 배움은 가볍게, 가능성은 넓게." width="1672" height="941" loading="lazy"></div><div class="about-copy"><p class="eyebrow">교육원 소개</p><h2>AI를 처음 만나는 순간부터<br>함께하겠습니다</h2><p>AI 미래교육원은 누구나 쉽게 AI를 배울 수 있도록 실무 중심의 맞춤형 교육을 제공합니다.</p><ul class="about-points"><li><strong>맞춤형 커리큘럼</strong><span>기초 입문부터 기업·관공서 출강, 심화 과정(전자책·영상·이미지 제작)까지</span></li><li><strong>다양한 프로그램</strong><span>대중과 폭넓게 소통하는 무료 행사부터 깊이있는 유료 프로그램까지 진행</span></li><li><strong>실습 중심 교육</strong><span>명확한 학습 목표 아래 직접 만들어 보며 익히는 실무 지향 수업</span></li></ul></div></div></section>
  <section class="section reviews-section" id="reviews"><div class="container"><div class="section-head"><div><h2>사진으로 보는 수업 후기</h2><p class="section-sub">함께 배우고 직접 살펴본 AI 강의 현장을 소개합니다.</p></div></div>${reviewArea}</div></section>
  <section class="section instructors-section" id="instructors"><div class="container"><div class="section-head"><div><p class="eyebrow">강사진</p><h2>함께 배우는 강사진</h2><p class="section-sub">강사별 전문 분야와 담당 강의를 확인해 보세요.</p></div></div>${instructorArea}</div></section>
  <section class="section faq-section" id="faq"><div class="container faq-grid"><div><p class="eyebrow">자주 묻는 질문</p><h2>궁금한 점을 확인하세요</h2><p>더 자세한 내용은 각 강의의 상세 페이지에서 안내합니다.</p></div><div class="faq-list"><details><summary>무료로 수강할 수 있나요?<span>+</span></summary><p>AI미래교육원 특강은 기업의 후원금을 바탕으로 운영되므로, 신청하신 모든 분이 수강료 부담 없이 참여하실 수 있습니다.</p></details><details><summary>메인 강연은 얼마나 진행되나요?<span>+</span></summary><p>본 강연은 약 90분가량 진행될 예정입니다.</p></details><details><summary>행사를 후원하는 기업은 어디인가요?<span>+</span></summary><p>'보람상조'의 지원으로 마련되었습니다.</p></details><details><summary>후원사 홍보시간 소요 시간은요?<span>+</span></summary><p>대략 40분에서 70분 정도 소요됩니다. 다만, 당일 현장 분위기와 상황에 따라 유동적으로 변동될 수 있습니다.</p></details></div></div></section>
  <section class="contact-section" id="contact"><div class="container contact-grid"><div><p class="eyebrow">문의하기</p><h2>궁금한 점이 있나요?</h2><p>강의 일정이나 단체 교육이 궁금하면 편하게 문의해 주세요.</p></div><form action="/inquiries" method="post" class="contact-form"><h3>문의 남기기</h3>${message ? `<div class="form-message">${e(message)}</div>` : ''}<label>이름 <input name="name" maxlength="50" required autocomplete="name" placeholder="성함을 입력해 주세요"></label><label>연락처 <input name="contact" maxlength="100" required placeholder="전화번호 또는 이메일"></label><label>문의 유형 <select name="kind" required><option value="">선택해 주세요</option><option>강의 일정</option><option>기업·단체 교육</option><option>기타 문의</option></select></label><label>문의 내용 <textarea name="message" maxlength="2000" rows="4" required placeholder="궁금한 점을 적어주세요"></textarea></label><label class="consent"><input type="checkbox" name="consent" value="yes" required><span><a href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>을 확인하고 문의 처리를 위한 수집·이용에 동의합니다.</span></label><input class="honeypot" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="button button-primary" type="submit">문의 보내기 <span>→</span></button></form></div></section></main>`);
}

function renderPrivacy() { return html('개인정보처리방침', `<main class="legal-page container"><p class="eyebrow dark">PRIVACY POLICY</p><h1>개인정보처리방침</h1><p>AI 미래교육원 운영사 (주)반도생활건강은 강의 신청 및 홈페이지 문의 처리에 필요한 최소한의 정보를 수집·이용합니다.</p><h2>1. 수집 항목 및 목적</h2><p>강의 신청 시 이름, 휴대전화번호, 성별, 연령대, 신청 시간대, 유입 경로를 수집하며 신청 확인, 강의 안내 및 운영을 위해 사용합니다. 문의 양식에서는 이름, 연락처, 문의 유형, 문의 내용을 수집하며 문의 확인과 답변을 위해 사용합니다.</p><h2>2. 보유 기간</h2><p>신청 및 문의 정보는 접수일로부터 1년간 보관한 뒤 삭제합니다. 관련 법령에 따라 더 보관해야 하는 경우에는 해당 기간을 따릅니다.</p><h2>3. 제3자 제공</h2><p>사전 동의나 법적 근거 없이 제3자에게 제공하지 않습니다.</p><h2>4. 이용자의 권리</h2><p>정보의 열람, 정정, 삭제, 처리정지를 요청할 수 있습니다. 대표번호 1877-6201로 연락해 주세요.</p><h2>5. 운영 정보</h2><p>(주)반도생활건강 · 대표 박인우<br>부산광역시 금정구 중앙대로 2014<br>사업자등록번호 607-81-98610 · 대표번호 1877-6201</p><p class="legal-note">시행일: 2026년 10월 8일.</p></main>`, { subpage: true }); }

function renderLecture(item, registered = false, staticPreview = false) {
  const landingImage = db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='landing' ORDER BY id DESC LIMIT 1").get(item.id);
  const content = landingImage
    ? `<div class="lecture-poster"><img class="lecture-landing-only" src="/uploads/${e(landingImage.filename)}" alt="${e(landingImage.caption || item.title + ' 상세 안내')}"></div>`
    : `<div class="lecture-image-pending"><h1>${e(item.title)}</h1><p>상세 안내 이미지를 준비하고 있습니다.</p></div>`;
  const ageOptions = ['21~25세','26~30세','31~35세','36~40세','41~45세','46~50세','51~55세','56~60세','61~65세','66~70세'];
  const sourceOptions = ['인스타그램','페이스북','당근','카카오','유튜브','네이버','기타'];
  const registrationContent = `<section class="registration-section"><div class="registration-card"><div class="registration-heading"><p class="eyebrow">FREE REGISTRATION</p><h2 id="registration-title">선착순 무료 신청</h2><p>${e(item.title)}에 참여하려면 아래 정보를 입력해 주세요.</p><p class="registration-success" role="status" ${registered ? '' : 'hidden'}>신청이 접수되었습니다. 확인 후 안내해 드리겠습니다.</p></div><form action="/registrations" method="post" class="registration-form"><input type="hidden" name="lecture_id" value="${item.id}">${['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].map(name => `<input type="hidden" name="${name}" value="">`).join('')}<label>이름<input name="name" maxlength="50" autocomplete="name" required></label><fieldset class="registration-field"><legend>연락처</legend><div class="phone-fields"><select name="phone_prefix" aria-label="휴대전화 앞자리"><option>010</option><option>011</option><option>016</option><option>017</option><option>018</option><option>019</option></select><input name="phone_middle" inputmode="numeric" autocomplete="tel-national" pattern="[0-9]{3,4}" maxlength="4" placeholder="앞자리" aria-label="휴대전화 가운데 자리" required><input name="phone_last" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="뒷자리" aria-label="휴대전화 뒷자리" required></div></fieldset><label>성별<select name="gender" required><option value="">선택해 주세요</option><option>여자</option><option>남자</option><option>응답하지 않음</option></select></label><label>연령<select name="age_range" required><option value="">선택해 주세요</option>${ageOptions.map(x => `<option>${x}</option>`).join('')}</select></label><label>강의 시간대를 선택해 주세요 <small>(중복 신청 불가)</small><select name="session_preference" required><option value="">선택해 주세요</option><option>오전 시간대</option><option>오후 시간대</option><option>시간대 무관</option></select></label><fieldset class="registration-field"><legend>유입 경로</legend><div class="source-options">${sourceOptions.map((x,i) => `<label><input type="radio" name="referral_source" value="${x}" ${i===0?'required':''}><span>${x}</span></label>`).join('')}</div></fieldset><label class="registration-consent"><input type="checkbox" name="consent" value="yes" required><span><a href="/privacy" target="_blank" rel="noopener">개인정보 수집 및 이용</a>에 동의합니다.</span></label><input class="honeypot" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="registration-submit" type="submit">무료 초대권 신청하기</button><p class="registration-note">신청 정보는 강의 운영 및 안내 목적으로만 사용됩니다.</p></form></div></section>`;
  const registration = staticPreview
    ? `<div class="registration-layer" id="register" aria-hidden="true"><div class="registration-backdrop" data-registration-close></div><section class="registration-sheet" role="dialog" aria-modal="true" aria-labelledby="registration-preview-title" tabindex="-1"><div class="registration-sheet-handle"><span></span><button class="registration-close" type="button" data-registration-close aria-label="안내 닫기">×</button></div><div class="registration-preview-message"><h2 id="registration-preview-title">신청 미리보기</h2><p>이 링크는 GitHub Pages 공유용 미리보기라 신청 정보가 저장되지 않습니다.</p><p>실제 신청 접수는 서버가 연결된 운영 사이트에서 이용할 수 있습니다.</p></div></section></div><div class="registration-dock"><button class="registration-dock-button" type="button" aria-controls="register" aria-expanded="false">선착순 무료신청</button></div>`
    : `<div class="registration-layer" id="register" aria-hidden="true"><div class="registration-backdrop" data-registration-close></div><section class="registration-sheet" role="dialog" aria-modal="true" aria-labelledby="registration-title" tabindex="-1"><div class="registration-sheet-handle"><span></span><button class="registration-close" type="button" data-registration-close aria-label="신청서 닫기">×</button></div>${registrationContent}</section></div><div class="registration-dock"><button class="registration-dock-button" type="button" aria-controls="register" aria-expanded="false">선착순 무료신청</button></div>`;
  return html(item.title, `<main class="lecture-page lecture-page-simple container"><a class="lecture-back" href="/#lectures">← 강의 목록으로</a>${landingImage ? `<h1 class="lecture-page-title-sr">${e(item.title)}</h1>` : ''}${content}</main>${registration}`, { subpage: true });
}

function renderDashboard(session) {
  const lectures = db.prepare('SELECT * FROM lectures ORDER BY start_at DESC, id DESC').all();
  const teachers = db.prepare('SELECT * FROM instructors ORDER BY id DESC').all();
  const count = db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n;
  const registrationCount = db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;
  return adminShell('운영 현황', `<div class="admin-stats"><div><strong>${lectures.length}</strong><span>등록 강의</span></div><div><strong>${lectures.filter(x => x.published).length}</strong><span>공개 강의</span></div><div><strong>${teachers.length}</strong><span>등록 강사</span></div><div><strong>${registrationCount}</strong><span><a href="/admin/registrations">강의 신청</a></span></div><div><strong>${count}</strong><span>접수 문의</span></div></div><div class="admin-section-title"><h2>강의 관리</h2><a class="admin-primary" href="/admin/lectures/new">+ 새 강의 추가</a></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>일시</th><th>강의</th><th>지역</th><th>상태</th><th>관리</th></tr></thead><tbody>${lectures.length ? lectures.map(x => `<tr><td>${e(dateText(x.start_at))}</td><td><strong>${e(x.title)}</strong><small>${e(x.topic)}</small></td><td>${e(x.region || '-')}</td><td><span class="status ${x.published ? 'published' : ''}">${x.published ? '공개' : '비공개'}</span></td><td><a href="/admin/lectures/${x.id}">수정 →</a></td></tr>`).join('') : '<tr><td colspan="5" class="table-empty">등록된 강의가 없습니다. 첫 강의를 추가해 주세요.</td></tr>'}</tbody></table></div><div class="admin-section-title"><h2>강사진</h2><a class="admin-primary" href="/admin/instructors/new">+ 강사 추가</a></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>이름</th><th>전문 분야</th><th>상태</th><th>관리</th></tr></thead><tbody>${teachers.length ? teachers.map(x => `<tr><td><strong>${e(x.name)}</strong></td><td>${e(x.role)}</td><td><span class="status ${x.published ? 'published' : ''}">${x.published ? '공개' : '비공개'}</span></td><td><a href="/admin/instructors/${x.id}">수정 →</a></td></tr>`).join('') : '<tr><td colspan="4" class="table-empty">강사 정보를 등록해 주세요.</td></tr>'}</tbody></table></div>`);
}

function lectureForm(item, session, error = '') {
  const isNew = !item.id;
  const landingImage = isNew ? null : db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='landing' ORDER BY id DESC LIMIT 1").get(item.id);
  const landingAdmin = isNew ? '' : `<section class="lecture-image-admin" id="landing-image"><h2>강의 상세 랜딩 이미지</h2><p>강의 상세 페이지에는 이 긴 이미지만 원래 비율로 표시됩니다. JPG, PNG, WebP 파일을 최대 20MB까지 올릴 수 있습니다. 새 파일을 올리면 기존 이미지는 교체됩니다.</p>${landingImage ? `<div class="landing-image-preview"><img src="/uploads/${e(landingImage.filename)}" alt="${e(landingImage.caption || '랜딩페이지 이미지 미리보기')}"><form action="/admin/lectures/images/delete" method="post" data-confirm="랜딩페이지 이미지를 삭제할까요?">${csrfField(session)}<input type="hidden" name="id" value="${landingImage.id}"><button class="delete-button">랜딩페이지 이미지 삭제</button></form></div>` : ''}<form action="/admin/lectures/${item.id}/images" method="post" enctype="multipart/form-data" class="admin-form image-upload-form">${csrfField(session)}<input type="hidden" name="placement" value="landing"><label>랜딩페이지 이미지 파일 <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label><label>이미지 설명 <input name="caption" maxlength="160" placeholder="예: 강의 일정과 상세 안내"></label><button class="admin-primary">${landingImage ? '이미지 교체' : '이미지 업로드'}</button></form></section>`;
  return adminShell(isNew ? '새 강의 추가' : '강의 수정', `<div class="admin-card">
    ${error ? `<div class="admin-error">${e(error)}</div>` : ''}
    <form action="/admin/lectures/save" method="post" class="admin-form">
      ${csrfField(session)}<input type="hidden" name="id" value="${e(item.id || '')}">
      <div class="field-grid">
        <label>강의명 <input name="title" value="${e(item.title)}" maxlength="120" required placeholder="예: AI 3종 활용 입문"></label>
        <label>주제 <input name="topic" value="${e(item.topic || 'AI 활용')}" maxlength="40" required placeholder="예: 생성형 AI 입문"></label>
      </div>
      <label>짧은 소개 <textarea name="summary" maxlength="300" rows="3" placeholder="목록에 표시할 강의 설명">${e(item.summary)}</textarea></label>
      <label>운영 메모 <textarea name="detail_body" maxlength="12000" rows="12" placeholder="강의에서 배우는 내용, 진행 순서, 준비물을 자세히 적어주세요. 빈 줄을 넣으면 문단이 나뉩니다.">${e(item.detail_body)}</textarea><small>공개 상세 페이지에는 표시되지 않습니다. 기존 내용을 보관할 수 있습니다.</small></label>
      <label>추천 대상 <input name="audience" value="${e(item.audience)}" maxlength="100" placeholder="예: 처음 배우는 분 / 초등학생과 보호자"><small>강의 카드에 표시됩니다. 강의별 대상에 맞게 입력해 주세요.</small></label>
      <div class="field-grid">
        <label>강의 일시 <input type="datetime-local" name="start_at" value="${e(item.start_at)}" required></label>
        <label>형식 <select name="format"><option ${item.format === '오프라인' ? 'selected' : ''}>오프라인</option><option ${item.format === '온라인' ? 'selected' : ''}>온라인</option><option ${item.format === '혼합' ? 'selected' : ''}>혼합</option></select></label>
      </div>
      <div class="field-grid">
        <label>지역 <input name="region" value="${e(item.region)}" maxlength="40" placeholder="예: 부산"></label>
        <label>장소 <input name="location" value="${e(item.location)}" maxlength="120" placeholder="예: 부산 BEXCO 1층"></label>
      </div>
      <div class="field-grid">
        <label>가격 표시 <input name="price_label" value="${e(item.price_label || '상세 페이지 참조')}" maxlength="50" placeholder="예: 무료 / 30,000원"></label>
        <label>신청 랜딩페이지 URL <input type="url" name="landing_url" value="${e(item.landing_url)}" placeholder="https://..."><small>선택 사항입니다. 신청 주소를 기록할 수 있습니다. 현재 상세 페이지에는 별도 버튼이 표시되지 않습니다.</small></label>
      </div>
      <label class="admin-check"><input type="checkbox" name="published" value="1" ${item.published ? 'checked' : ''}> 홈페이지에 공개</label>
      <div class="form-actions"><button class="admin-primary" type="submit">${isNew ? '강의 등록' : '변경 저장'}</button><a href="/admin">취소</a></div>
    </form>
    ${landingAdmin}
    ${isNew ? '<p class="upload-hint">강의를 먼저 저장하면 이미지를 올릴 수 있습니다.</p>' : `<section class="lecture-image-admin" id="images"><h2>대표·추가 이미지</h2><p>첫 번째 이미지는 강의 목록의 대표 이미지로 표시됩니다. 상세 페이지에는 긴 랜딩 이미지만 표시됩니다. JPG, PNG, WebP 파일을 최대 8MB까지 올릴 수 있습니다.</p><div class="admin-image-grid">${db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='gallery' ORDER BY id").all(item.id).map(img => `<figure><img src="/uploads/${e(img.filename)}" alt="${e(img.caption || item.title)}"><figcaption>${e(img.caption || '설명 없음')}</figcaption><form action="/admin/lectures/images/delete" method="post" data-confirm="이 이미지를 삭제할까요?">${csrfField(session)}<input type="hidden" name="id" value="${img.id}"><button class="delete-button">이미지 삭제</button></form></figure>`).join('') || '<p>등록된 이미지가 없습니다.</p>'}</div><form action="/admin/lectures/${item.id}/images" method="post" enctype="multipart/form-data" class="admin-form image-upload-form">${csrfField(session)}<label>이미지 파일 <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label><label>이미지 설명 <input name="caption" maxlength="160" placeholder="사진에 담긴 내용을 간단히 적어주세요"></label><button class="admin-primary">이미지 업로드</button></form></section><p><a href="/lectures/${item.id}" target="_blank" rel="noopener">공개 상세 페이지 미리 보기 ↗</a></p><form action="/admin/lectures/delete" method="post" class="delete-form" data-confirm="이 강의를 삭제할까요? 되돌릴 수 없습니다.">${csrfField(session)}<input type="hidden" name="id" value="${item.id}"><button class="delete-button">강의 삭제</button></form>`}
  </div>`);
}

function instructorForm(item, session, error = '') {
  const isNew = !item.id;
  return adminShell(isNew ? '강사 추가' : '강사 수정', `<div class="admin-card">${error ? `<div class="admin-error">${e(error)}</div>` : ''}<form action="/admin/instructors/save" method="post" class="admin-form">${csrfField(session)}<input type="hidden" name="id" value="${e(item.id || '')}"><div class="field-grid"><label>이름 <input name="name" value="${e(item.name)}" maxlength="60" required></label><label>전문 분야 <input name="role" value="${e(item.role)}" maxlength="100" placeholder="예: 생성형 AI 실무 강사"></label></div><label>소개 <textarea name="bio" maxlength="600" rows="5" placeholder="대표 경력과 담당 강의를 간결하게 적어주세요">${e(item.bio)}</textarea></label><label>사진 URL <input type="url" name="photo_url" value="${e(item.photo_url)}" placeholder="https://..."><small>강사 사진의 공개 HTTPS 주소를 입력하세요. 비워 두면 이니셜이 표시됩니다.</small></label><label class="admin-check"><input type="checkbox" name="published" value="1" ${item.published ? 'checked' : ''}> 홈페이지에 공개</label><div class="form-actions"><button class="admin-primary" type="submit">${isNew ? '강사 등록' : '변경 저장'}</button><a href="/admin">취소</a></div></form>${isNew ? '' : `<form action="/admin/instructors/delete" method="post" class="delete-form" data-confirm="이 강사를 삭제할까요? 되돌릴 수 없습니다.">${csrfField(session)}<input type="hidden" name="id" value="${item.id}"><button class="delete-button">강사 삭제</button></form>`}</div>`);
}

function renderReviews(session) {
  const items = db.prepare('SELECT * FROM reviews ORDER BY sort_order ASC, id ASC').all();
  return adminShell('후기 관리', `<div class="admin-section-title"><h2>수업 후기 ${items.length}개</h2><a class="admin-primary" href="/admin/reviews/new">+ 후기 추가</a></div><p class="admin-help">공개된 후기는 홈페이지의 강사진 소개 바로 위에 표시됩니다. 제목과 설명은 실제 수업 현장을 바탕으로 작성해 주세요.</p><div class="admin-review-list">${items.length ? items.map(x => `<article class="admin-review-item"><img src="${e(x.image_path)}" alt="${e(x.image_alt || x.title)}"><div><span class="status ${x.published ? 'published' : ''}">${x.published ? '공개' : '비공개'}</span><h3>${e(x.title)}</h3><p>${e(x.body)}</p><small>표시 순서 ${x.sort_order}</small></div><a href="/admin/reviews/${x.id}">수정 →</a></article>`).join('') : '<div class="admin-card">등록된 후기가 없습니다. 첫 후기를 추가해 주세요.</div>'}</div>`);
}

function reviewForm(item, session, error = '') {
  const isNew = !item.id;
  return adminShell(isNew ? '후기 추가' : '후기 수정', `<div class="admin-card">${error ? `<div class="admin-error" role="alert">${e(error)}</div>` : ''}<form action="/admin/reviews/save" method="post" enctype="multipart/form-data" class="admin-form">${csrfField(session)}<input type="hidden" name="id" value="${e(item.id || '')}"><label>제목 <input name="title" value="${e(item.title || '')}" maxlength="80" required placeholder="예: 함께 모여 배우는 AI"></label><label>내용 <textarea name="body" maxlength="400" rows="5" required placeholder="수업 현장의 모습을 짧고 긍정적으로 소개해 주세요">${e(item.body || '')}</textarea></label><label>사진 설명 <input name="image_alt" value="${e(item.image_alt || '')}" maxlength="160" placeholder="예: 참가자들이 강연을 듣는 모습"><small>이미지를 볼 수 없는 방문자를 위해 장면을 설명해 주세요.</small></label>${item.image_path ? `<div class="review-image-preview"><img src="${e(item.image_path)}" alt="현재 후기 사진"></div>` : ''}<label>사진 ${isNew ? '(필수)' : '(변경할 때만 선택)'} <input type="file" name="image" accept="image/jpeg,image/png,image/webp" ${isNew ? 'required' : ''}><small>JPG, PNG, WebP · 최대 8MB</small></label><div class="field-grid"><label>표시 순서 <input type="number" name="sort_order" value="${e(item.sort_order ?? 0)}" min="0" max="999" required></label></div><label class="admin-check"><input type="checkbox" name="published" value="1" ${item.published ? 'checked' : ''}> 홈페이지에 공개</label><div class="form-actions"><button class="admin-primary" type="submit">${isNew ? '후기 등록' : '변경 저장'}</button><a href="/admin/reviews">취소</a></div></form>${isNew ? '' : `<form action="/admin/reviews/delete" method="post" class="delete-form" data-confirm="이 후기를 삭제할까요? 되돌릴 수 없습니다.">${csrfField(session)}<input type="hidden" name="id" value="${item.id}"><button class="delete-button">후기 삭제</button></form>`}</div>`);
}

function renderInquiries() { const items = db.prepare('SELECT * FROM inquiries ORDER BY id DESC').all(); return adminShell('문의함', `<div class="inquiry-list">${items.length ? items.map(x => `<article class="inquiry-item"><div><span class="tag">${e(x.kind)}</span><time>${e(x.created_at)}</time></div><h2>${e(x.name)} <small>${e(x.contact)}</small></h2><p>${e(x.message).replace(/\n/g, '<br>')}</p></article>`).join('') : '<div class="admin-card">아직 접수된 문의가 없습니다.</div>'}</div>`); }

function renderRegistrations() { const items = db.prepare('SELECT registrations.*, lectures.title AS lecture_title FROM registrations LEFT JOIN lectures ON lectures.id=registrations.lecture_id ORDER BY registrations.id DESC').all(); return adminShell('강의 신청', `<div class="admin-section-title"><p>접수된 신청 ${items.length}건</p><a class="admin-primary" href="/admin/registrations.csv">CSV 내려받기</a></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>접수일</th><th>강의</th><th>신청자</th><th>연락처</th><th>성별·연령</th><th>시간대</th><th>유입 경로</th><th>광고 캠페인</th></tr></thead><tbody>${items.length ? items.map(x => { const phone = x.contact.replace(/^(01\d)(\d{3,4})(\d{4})$/, '$1-$2-$3'); return `<tr><td>${e(x.created_at)}</td><td>${e(x.lecture_title || '삭제된 강의')}</td><td><strong>${e(x.name)}</strong></td><td><a href="tel:${e(x.contact)}">${e(phone)}</a></td><td>${e(x.gender)} · ${e(x.age_range)}</td><td>${e(x.session_preference)}</td><td>${e(x.referral_source)}</td><td>${e([x.utm_source,x.utm_medium,x.utm_campaign].filter(Boolean).join(' / ') || '-')}</td></tr>`; }).join('') : '<tr><td colspan="8" class="table-empty">아직 접수된 강의 신청이 없습니다.</td></tr>'}</tbody></table></div>`); }

function limit(map, key, count, duration) { const now = Date.now(); const current = (map.get(key) || []).filter(t => now - t < duration); current.push(now); map.set(key, current); return current.length <= count; }

async function route(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname.startsWith('/admin')) res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && pathname === '/healthz') {
    db.prepare('SELECT 1').get();
    return send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json', { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'GET' && (pathname === '/style.css' || pathname === '/site.css' || pathname === '/app.js' || /^\/assets\/[a-z0-9-]+\.(png|jpg|webp)$/i.test(pathname))) {
    const file = path.join(__dirname, 'public', pathname.slice(1));
    if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file); return send(res, 200, fs.readFileSync(file), ({ '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[ext], { 'Cache-Control': ext === '.css' || ext === '.js' ? 'no-cache' : 'public, max-age=86400' });
  }
  if (req.method === 'GET' && /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(pathname)) {
    const file = path.join(UPLOAD_DIR, path.basename(pathname));
    if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), ({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)], { 'Cache-Control': 'public, max-age=86400' });
  }
  if (req.method === 'GET' && pathname === '/') return send(res, 200, renderHome(new URL(req.url, 'http://local').searchParams.has('sent') ? '문의가 접수되었습니다. 확인 후 연락드리겠습니다.' : ''));
  if (req.method === 'GET' && /^\/lectures\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM lectures WHERE id=? AND published=1').get(Number(pathname.split('/').pop())); return item ? send(res, 200, renderLecture(item, new URL(req.url, 'http://local').searchParams.has('registered'))) : send(res, 404, html('강의를 찾을 수 없습니다', '<main class="legal-page container"><h1>강의를 찾을 수 없습니다.</h1><a href="/#lectures">강의 목록으로 →</a></main>')); }
  if (req.method === 'GET' && pathname === '/privacy') return send(res, 200, renderPrivacy());
  if (req.method === 'POST' && pathname === '/inquiries') {
    if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
    const body = await readBody(req);
    if (body.website) return redirect(res, '/?sent=1#contact');
    const ip = clientIp(req);
    if (!limit(inquiryAttempts, ip, 5, 60 * 60 * 1000)) return send(res, 429, html('잠시 후 다시 시도해 주세요', '<main class="legal-page container"><h1>문의가 너무 자주 접수되었습니다.</h1><p>잠시 후 다시 시도하거나 1877-6201로 연락해 주세요.</p></main>'));
    if (!body.consent || !body.name?.trim() || !body.contact?.trim() || !body.kind?.trim() || !body.message?.trim() || body.name.length > 50 || body.contact.length > 100 || body.message.length > 2000) return send(res, 400, html('입력 확인', '<main class="legal-page container"><h1>입력 내용을 확인해 주세요.</h1><p>모든 필수 항목과 개인정보 동의가 필요합니다.</p><a href="/#contact">문의로 돌아가기</a></main>'));
    db.exec("DELETE FROM inquiries WHERE created_at < datetime('now', '-1 year')");
    db.prepare('INSERT INTO inquiries(name,contact,kind,message) VALUES(?,?,?,?)').run(body.name.trim(), body.contact.trim(), body.kind.trim(), body.message.trim());
    return redirect(res, '/?sent=1#contact');
  }
  if (req.method === 'POST' && pathname === '/registrations') {
    if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
    const body = await readBody(req);
    const lectureId = Number(body.lecture_id) || 0;
    const lecture = db.prepare('SELECT id FROM lectures WHERE id=? AND published=1').get(lectureId);
    if (body.website) return redirect(res, `/lectures/${lectureId}#register`);
    const ip = clientIp(req);
    if (!limit(inquiryAttempts, `registration:${ip}`, 30, 60 * 60 * 1000)) return send(res, 429, html('잠시 후 다시 시도해 주세요', '<main class="legal-page container"><h1>신청이 너무 자주 접수되었습니다.</h1><p>잠시 후 다시 신청해 주세요.</p></main>'));
    const name = (body.name || '').trim();
    const phoneDigits = [body.phone_prefix, body.phone_middle, body.phone_last].join('').replace(/\D/g, '');
    const genderOptions = ['여자','남자','응답하지 않음'];
    const ageOptions = ['21~25세','26~30세','31~35세','36~40세','41~45세','46~50세','51~55세','56~60세','61~65세','66~70세'];
    const sessionOptions = ['오전 시간대','오후 시간대','시간대 무관'];
    const sourceOptions = ['인스타그램','페이스북','당근','카카오','유튜브','네이버','기타'];
    if (!lecture || body.consent !== 'yes' || !name || name.length > 50 || !/^01[016789]\d{7,8}$/.test(phoneDigits) || !genderOptions.includes(body.gender) || !ageOptions.includes(body.age_range) || !sessionOptions.includes(body.session_preference) || !sourceOptions.includes(body.referral_source)) return send(res, 400, html('입력 확인', '<main class="legal-page container"><h1>신청 내용을 확인해 주세요.</h1><p>필수 항목을 모두 입력하고 개인정보 수집·이용에 동의해 주세요.</p><a href="/lectures/' + lectureId + '#register">신청서로 돌아가기</a></main>'));
    if (db.prepare('SELECT id FROM registrations WHERE lecture_id=? AND contact=?').get(lectureId, phoneDigits)) return send(res, 409, html('이미 신청했습니다', `<main class="legal-page container"><h1>이미 신청된 연락처입니다.</h1><p>신청 내용을 변경하려면 대표번호로 문의해 주세요.</p><a href="/lectures/${lectureId}">강의로 돌아가기</a></main>`));
    const utm = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].map(key => String(body[key] || '').trim().slice(0, 120));
    db.prepare('INSERT INTO registrations(lecture_id,name,contact,gender,age_range,session_preference,referral_source,utm_source,utm_medium,utm_campaign,utm_content,utm_term) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(lectureId, name, phoneDigits, body.gender, body.age_range, body.session_preference, body.referral_source, ...utm);
    db.prepare('UPDATE registrations SET consent_at=CURRENT_TIMESTAMP,consent_version=? WHERE id=last_insert_rowid()').run(CONSENT_VERSION);
    return redirect(res, `/lectures/${lectureId}?registered=1#register`);
  }
  if (pathname === '/admin/login' && req.method === 'GET') return send(res, 200, html('관리자 로그인', `<main class="login-page"><div class="login-card"><a href="/" class="admin-login-brand">AI 미래교육원</a><p class="eyebrow dark">ADMIN ACCESS</p><h1>관리자 로그인</h1><p>강의 일정과 강사진을 관리합니다.</p>${new URL(req.url, 'http://local').searchParams.has('error') ? '<div class="admin-error">비밀번호를 확인해 주세요.</div>' : ''}<form action="/admin/login" method="post"><label>관리자 비밀번호<input type="password" name="password" required autocomplete="current-password"></label><button class="admin-primary">로그인</button></form><a class="back-home" href="/">← 홈페이지로 돌아가기</a></div></main>`, { admin: true }));
  if (pathname === '/admin/login' && req.method === 'POST') {
    if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
    const ip = clientIp(req);
    if (!limit(loginAttempts, ip, 10, 15 * 60 * 1000)) return send(res, 429, 'Too many attempts', 'text/plain');
    const body = await readBody(req);
    const configured = process.env.ADMIN_PASSWORD;
    const localShortPassword = process.env.ALLOW_SHORT_LOCAL_ADMIN_PASSWORD === '1' && !PUBLIC_ORIGIN && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
    if (!configured || configured.length < (localShortPassword ? 6 : 12)) return send(res, 503, html('관리자 설정 필요', '<main class="legal-page container"><h1>관리자 비밀번호 설정이 필요합니다.</h1><p>온라인 운영에는 12자 이상의 관리자 비밀번호를 설정해 주세요.</p></main>', { admin: true }));
    const inputHash = crypto.createHash('sha256').update(body.password || '').digest();
    const expectedHash = crypto.createHash('sha256').update(configured).digest();
    if (!crypto.timingSafeEqual(inputHash, expectedHash)) return redirect(res, '/admin/login?error=1');
    const token = newSession(); return redirect(res, '/admin', { 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie(req)}` });
  }
  if (pathname.startsWith('/admin')) {
    const session = currentSession(req);
    if (!session) return redirect(res, '/admin/login');
    if (req.method === 'POST' && pathname === '/admin/reviews/save') {
      if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
      if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data') || Number(req.headers['content-length'] || 0) > 9 * 1024 * 1024) return send(res, 413, '사진 파일이 너무 큽니다.', 'text/plain; charset=utf-8');
      try {
        const bytes = await readUpload(req, 9 * 1024 * 1024);
        const form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes }).formData();
        if (form.get('csrf') !== session.csrf) return send(res, 403, 'Forbidden', 'text/plain');
        const id = Number(form.get('id')) || null;
        const old = id ? db.prepare('SELECT * FROM reviews WHERE id=?').get(id) : null;
        if (id && !old) return send(res, 404, 'Not found', 'text/plain');
        const item = { id, title: String(form.get('title') || '').trim(), body: String(form.get('body') || '').trim(), image_alt: String(form.get('image_alt') || '').trim(), sort_order: Number(form.get('sort_order')), published: form.get('published') === '1' ? 1 : 0, image_path: old?.image_path || '' };
        const file = form.get('image');
        const hasFile = file && typeof file.arrayBuffer === 'function' && file.size > 0;
        const error = !item.title || item.title.length > 80 || !item.body || item.body.length > 400 || item.image_alt.length > 160 || !Number.isInteger(item.sort_order) || item.sort_order < 0 || item.sort_order > 999 || (!old && !hasFile) ? '제목, 내용, 사진과 표시 순서를 확인해 주세요.' : '';
        if (error) return send(res, 400, reviewForm(item, session, error));
        let filename = '';
        if (hasFile) {
          const image = Buffer.from(await file.arrayBuffer());
          const ext = imageType(image);
          if (!ext || image.length > 8 * 1024 * 1024 || image.length < 32) return send(res, 400, reviewForm(item, session, 'JPG, PNG, WebP 사진을 8MB 이하로 올려 주세요.'));
          filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
          fs.writeFileSync(path.join(UPLOAD_DIR, filename), image, { flag: 'wx' });
          item.image_path = `/uploads/${filename}`;
        }
        try {
          if (id) db.prepare('UPDATE reviews SET title=?,body=?,image_path=?,image_alt=?,sort_order=?,published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.title,item.body,item.image_path,item.image_alt,item.sort_order,item.published,id);
          else item.id = Number(db.prepare('INSERT INTO reviews(title,body,image_path,image_alt,sort_order,published) VALUES(?,?,?,?,?,?)').run(item.title,item.body,item.image_path,item.image_alt,item.sort_order,item.published).lastInsertRowid);
        } catch (error) { if (filename) fs.rmSync(path.join(UPLOAD_DIR, filename), { force: true }); throw error; }
        if (filename && old?.image_path?.startsWith('/uploads/')) fs.rmSync(path.join(UPLOAD_DIR, path.basename(old.image_path)), { force: true });
        return redirect(res, '/admin/reviews');
      } catch (error) { return send(res, 400, e(error.message || '후기 저장에 실패했습니다.'), 'text/plain; charset=utf-8'); }
    }
    if (req.method === 'POST' && /^\/admin\/lectures\/\d+\/images$/.test(pathname)) {
      if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
      const lectureId = Number(pathname.split('/')[3]);
      if (!db.prepare('SELECT id FROM lectures WHERE id=?').get(lectureId)) return send(res, 404, 'Not found', 'text/plain');
      if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data') || Number(req.headers['content-length'] || 0) > 24 * 1024 * 1024) return send(res, 413, '이미지 파일이 너무 큽니다.', 'text/plain; charset=utf-8');
      try {
        const bytes = await readUpload(req);
        const form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes }).formData();
        if (form.get('csrf') !== session.csrf) return send(res, 403, 'Forbidden', 'text/plain');
        const placement = form.get('placement') === 'landing' ? 'landing' : 'gallery';
        const file = form.get('image');
        if (!file || typeof file.arrayBuffer !== 'function') return send(res, 400, '이미지 파일을 선택해 주세요.', 'text/plain; charset=utf-8');
        const image = Buffer.from(await file.arrayBuffer());
        const ext = imageType(image);
        if (!ext || image.length > (placement === 'landing' ? 20 : 8) * 1024 * 1024 || image.length < 32) return send(res, 400, 'JPG, PNG, WebP 파일을 선택하고 용량을 확인해 주세요.', 'text/plain; charset=utf-8');
        if (placement === 'gallery' && db.prepare("SELECT COUNT(*) AS n FROM lecture_images WHERE lecture_id=? AND placement='gallery'").get(lectureId).n >= 12) return send(res, 400, '강의당 이미지는 최대 12개까지 등록할 수 있습니다.', 'text/plain; charset=utf-8');
        const caption = String(form.get('caption') || '').trim().slice(0, 160);
        const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), image, { flag: 'wx' });
        if (placement === 'landing') {
          const oldImages = db.prepare("SELECT filename FROM lecture_images WHERE lecture_id=? AND placement='landing'").all(lectureId);
          db.prepare("DELETE FROM lecture_images WHERE lecture_id=? AND placement='landing'").run(lectureId);
          oldImages.forEach(old => fs.rmSync(path.join(UPLOAD_DIR, old.filename), { force: true }));
        }
        db.prepare('INSERT INTO lecture_images(lecture_id,filename,caption,placement) VALUES(?,?,?,?)').run(lectureId, filename, caption, placement);
        return redirect(res, `/admin/lectures/${lectureId}#${placement === 'landing' ? 'landing-image' : 'images'}`);
      } catch (error) { return send(res, 400, e(error.message || '업로드에 실패했습니다.'), 'text/plain; charset=utf-8'); }
    }
    if (req.method === 'POST') {
      if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
      const body = await readBody(req);
      if (pathname !== '/admin/logout' && body.csrf !== session.csrf) return send(res, 403, 'Forbidden', 'text/plain');
      if (pathname === '/admin/backup') {
        const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ai-future-download-'));
        try {
          const archive = backupData(DATA_DIR, temp, db);
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="site-backup.tar.gz"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          const stream = fs.createReadStream(archive);
          const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });
          stream.on('close', cleanup);
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          return stream.pipe(res);
        } catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error; }
      }
      if (pathname === '/admin/registrations/update') {
        if (!registrationAdmin.statuses.includes(body.status) || String(body.notes || '').length > 1000) return send(res, 400, '신청 상태와 메모를 확인해 주세요.', 'text/plain; charset=utf-8');
        const result = db.prepare('UPDATE registrations SET status=?,notes=? WHERE id=?').run(body.status, String(body.notes || '').trim(), Number(body.id) || 0);
        return result.changes ? redirect(res, '/admin/registrations') : send(res, 404, 'Not found', 'text/plain');
      }
      if (pathname === '/admin/registrations/delete') {
        db.prepare('DELETE FROM registrations WHERE id=?').run(Number(body.id) || 0);
        return redirect(res, '/admin/registrations');
      }
      if (pathname === '/admin/logout') { const token = cookie(req).session; sessions.delete(token); return redirect(res, '/admin/login', { 'Set-Cookie': `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(req)}` }); }
      if (pathname === '/admin/lectures/save') {
        const item = { id: Number(body.id) || null, title: (body.title || '').trim(), topic: (body.topic || '').trim(), summary: (body.summary || '').trim(), detail_body: (body.detail_body || '').trim(), audience: (body.audience || '').trim(), start_at: body.start_at || '', region: (body.region || '').trim(), location: (body.location || '').trim(), format: body.format || '오프라인', price_label: (body.price_label || '').trim(), landing_url: (body.landing_url || '').trim(), published: body.published === '1' ? 1 : 0 };
        const error = !item.title || item.title.length > 120 || !item.topic || item.topic.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.start_at) || (item.landing_url && !safeUrl(item.landing_url)) || item.summary.length > 300 || item.detail_body.length > 12000 || item.audience.length > 100 || item.region.length > 40 || item.location.length > 120 || item.price_label.length > 50 ? '필수 항목과 신청 URL(HTTPS)을 확인해 주세요.' : '';
        if (error) return send(res, 400, lectureForm(item, session, error));
        if (item.id) db.prepare('UPDATE lectures SET title=?,topic=?,summary=?,detail_body=?,audience=?,start_at=?,region=?,location=?,format=?,price_label=?,landing_url=?,published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.title,item.topic,item.summary,item.detail_body,item.audience,item.start_at,item.region,item.location,item.format,item.price_label,item.landing_url,item.published,item.id);
        else item.id = Number(db.prepare('INSERT INTO lectures(title,topic,summary,detail_body,audience,start_at,region,location,format,price_label,landing_url,published) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(item.title,item.topic,item.summary,item.detail_body,item.audience,item.start_at,item.region,item.location,item.format,item.price_label,item.landing_url,item.published).lastInsertRowid);
        return redirect(res, `/admin/lectures/${item.id}`);
      }
      if (pathname === '/admin/lectures/images/delete') { const image = db.prepare('SELECT * FROM lecture_images WHERE id=?').get(Number(body.id) || 0); if (image) { db.prepare('DELETE FROM lecture_images WHERE id=?').run(image.id); fs.rmSync(path.join(UPLOAD_DIR, image.filename), { force: true }); return redirect(res, `/admin/lectures/${image.lecture_id}#${image.placement === 'landing' ? 'landing-image' : 'images'}`); } return send(res, 404, 'Not found', 'text/plain'); }
      if (pathname === '/admin/lectures/delete') { const id = Number(body.id) || 0; const images = db.prepare('SELECT filename FROM lecture_images WHERE lecture_id=?').all(id); db.prepare('DELETE FROM lectures WHERE id=?').run(id); images.forEach(img => fs.rmSync(path.join(UPLOAD_DIR, img.filename), { force: true })); return redirect(res, '/admin'); }
      if (pathname === '/admin/instructors/save') {
        const item = { id: Number(body.id) || null, name: (body.name || '').trim(), role: (body.role || '').trim(), bio: (body.bio || '').trim(), photo_url: (body.photo_url || '').trim(), published: body.published === '1' ? 1 : 0 };
        const error = !item.name || item.name.length > 60 || item.role.length > 100 || item.bio.length > 600 || (item.photo_url && !safeUrl(item.photo_url)) ? '이름과 사진 주소(HTTPS)를 확인해 주세요.' : '';
        if (error) return send(res, 400, instructorForm(item, session, error));
        if (item.id) db.prepare('UPDATE instructors SET name=?,role=?,bio=?,photo_url=?,published=? WHERE id=?').run(item.name,item.role,item.bio,item.photo_url,item.published,item.id);
        else db.prepare('INSERT INTO instructors(name,role,bio,photo_url,published) VALUES(?,?,?,?,?)').run(item.name,item.role,item.bio,item.photo_url,item.published);
        return redirect(res, '/admin');
      }
      if (pathname === '/admin/instructors/delete') { db.prepare('DELETE FROM instructors WHERE id=?').run(Number(body.id) || 0); return redirect(res, '/admin'); }
      if (pathname === '/admin/reviews/delete') { const item = db.prepare('SELECT * FROM reviews WHERE id=?').get(Number(body.id) || 0); if (!item) return send(res, 404, 'Not found', 'text/plain'); db.prepare('DELETE FROM reviews WHERE id=?').run(item.id); if (item.image_path.startsWith('/uploads/')) fs.rmSync(path.join(UPLOAD_DIR, path.basename(item.image_path)), { force: true }); return redirect(res, '/admin/reviews'); }
      return send(res, 404, 'Not found', 'text/plain');
    }
    if (req.method === 'GET' && pathname === '/admin') return send(res, 200, renderDashboard(session));
    if (req.method === 'GET' && pathname === '/admin/backup') return send(res, 200, adminShell('데이터 백업', `<div class="admin-card"><h2>신청자 DB와 업로드 이미지</h2><p>현재 정보를 하나의 압축 파일로 내려받습니다. 개인정보가 포함되므로 회사의 접근 제한 저장소에 보관해 주세요. 백업은 서버 밖에 별도로 보관해야 합니다.</p><form method="post" action="/admin/backup">${csrfField(session)}<button class="admin-primary">전체 백업 내려받기</button></form></div>`));
    if (req.method === 'GET' && pathname === '/admin/registrations.csv') {
      const csv = registrationAdmin.csv(new URL(req.url, 'http://local').searchParams);
      return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="registrations.csv"', 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && pathname === '/admin/reviews') return send(res, 200, renderReviews(session));
    if (req.method === 'GET' && pathname === '/admin/reviews/new') return send(res, 200, reviewForm({ published: 1, sort_order: 0 }, session));
    if (req.method === 'GET' && /^\/admin\/reviews\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM reviews WHERE id=?').get(Number(pathname.split('/').pop())); return item ? send(res, 200, reviewForm(item, session)) : send(res, 404, 'Not found', 'text/plain'); }
    if (req.method === 'GET' && pathname === '/admin/lectures/new') return send(res, 200, lectureForm({}, session));
    if (req.method === 'GET' && /^\/admin\/lectures\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM lectures WHERE id=?').get(Number(pathname.split('/').pop())); return item ? send(res, 200, lectureForm(item, session)) : send(res, 404, 'Not found', 'text/plain'); }
    if (req.method === 'GET' && pathname === '/admin/instructors/new') return send(res, 200, instructorForm({}, session));
    if (req.method === 'GET' && /^\/admin\/instructors\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM instructors WHERE id=?').get(Number(pathname.split('/').pop())); return item ? send(res, 200, instructorForm(item, session)) : send(res, 404, 'Not found', 'text/plain'); }
    if (req.method === 'GET' && pathname === '/admin/inquiries') return send(res, 200, renderInquiries());
    if (req.method === 'GET' && pathname === '/admin/registrations') return send(res, 200, registrationAdmin.render(new URL(req.url, 'http://local').searchParams, session));
  }
  return send(res, 404, html('페이지를 찾을 수 없습니다', '<main class="legal-page container"><h1>페이지를 찾을 수 없습니다.</h1><a href="/">홈으로 돌아가기 →</a></main>'));
}

const registrationAdmin = createRegistrationAdmin({ db, e, adminShell, csrfField, csvCell });
const server = http.createServer((req, res) => route(req, res).catch(error => { console.error(error); if (!res.headersSent) send(res, 500, '서버 오류가 발생했습니다.', 'text/plain; charset=utf-8'); }));
if (require.main === module) server.listen(PORT, () => console.log(`AI 미래교육원: http://localhost:${PORT}`));
module.exports = { server, db, renderHome, renderLecture, renderPrivacy, safeUrl };


