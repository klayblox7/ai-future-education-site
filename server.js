const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'site.sqlite'));
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
CREATE TABLE IF NOT EXISTS lecture_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
  placement TEXT NOT NULL DEFAULT 'gallery',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
if (!db.prepare('PRAGMA table_info(lectures)').all().some(column => column.name === 'audience')) {
  db.exec("ALTER TABLE lectures ADD COLUMN audience TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(lectures)').all().some(column => column.name === 'detail_body')) {
  db.exec("ALTER TABLE lectures ADD COLUMN detail_body TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(lecture_images)').all().some(column => column.name === 'placement')) {
  db.exec("ALTER TABLE lecture_images ADD COLUMN placement TEXT NOT NULL DEFAULT 'gallery'");
}
db.exec("DELETE FROM inquiries WHERE created_at < datetime('now', '-1 year')");

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
const html = (title, content, { admin = false, subpage = false } = {}) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#ffffff"><meta name="description" content="AI 미래교육원. ChatGPT, Gemini, Claude를 쉽게 배우고 직접 사용해 보는 AI 강의."><title>${e(title)} | AI 미래교육원</title><link rel="icon" href="/assets/symbol-new.png"><link rel="stylesheet" href="/style.css">${admin ? '' : '<link rel="stylesheet" href="/site.css?v=17">'}</head><body class="${admin ? 'admin-body' : ''} ${subpage ? 'subpage' : ''}">${admin ? '' : nav}${content}${admin ? '' : footer}<script src="/app.js?v=3" defer></script></body></html>`;
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
const adminShell = (title, content) => html(title, `<header class="admin-header"><a href="/admin" class="admin-logo">AI 미래교육원 <span>관리자</span></a><nav><a href="/admin">대시보드</a><a href="/admin/lectures/new">강의 추가</a><a href="/admin/instructors/new">강사 추가</a><a href="/admin/inquiries">문의함</a><a href="/" target="_blank" rel="noopener">사이트 보기 ↗</a><form action="/admin/logout" method="post"><button>로그아웃</button></form></nav></header><main class="admin-main"><div class="admin-heading"><p class="eyebrow">OPERATIONS</p><h1>${e(title)}</h1></div>${content}</main>`, { admin: true });

function lectureCard(item) {
  const detail = `/lectures/${item.id}`;
  const start = String(item.start_at);
  const mobileDate = `${Number(start.slice(5, 7))}월 ${Number(start.slice(8, 10))}일`;
  const mobileMeta = [start.slice(11, 16), item.region || item.format].filter(Boolean).join(' · ');
  return `<article class="lecture-card" data-region="${e(item.region)}" data-month="${e(start.slice(0, 7))}">${item.cover_file ? `<a class="lecture-cover" href="${detail}"><img src="/uploads/${e(item.cover_file)}" alt="${e(item.title)}" loading="lazy"></a>` : ''}<div class="lecture-content"><div class="lecture-top"><span class="lecture-date">${e(dateText(item.start_at))}</span><span class="lecture-topic">${e(item.topic)}</span></div><h3><a href="${detail}">${e(item.title)}</a></h3>${item.summary ? `<p>${e(item.summary)}</p>` : ''}${item.audience ? `<p class="lecture-audience"><strong>추천 대상</strong> ${e(item.audience)}</p>` : ''}<div class="lecture-details"><span>📍 ${e(item.region || item.format)}${item.location ? ` · ${e(item.location)}` : ''}</span><span>${e(item.price_label)}</span></div><a class="lecture-link" href="${detail}" aria-label="${e(item.title)} 상세 페이지 열기">강의 자세히 보기 <span aria-hidden="true">→</span></a></div><a class="lecture-mobile-row" href="${detail}" aria-label="${e(mobileDate)} ${e(item.title)}, ${e(mobileMeta)}. 자세히 보기"><span class="lecture-mobile-date" aria-hidden="true"><strong>${e(start.slice(8, 10))}</strong><small>${e(Number(start.slice(5, 7)))}월</small></span><span class="lecture-mobile-info"><strong>${e(item.title)}</strong><small>${e(mobileMeta)}</small></span><span class="lecture-mobile-arrow" aria-hidden="true">→</span></a></article>`;
}

function renderHome(message = '') {
  const lectures = db.prepare("SELECT lectures.*, (SELECT filename FROM lecture_images WHERE lecture_id=lectures.id AND placement='gallery' ORDER BY id LIMIT 1) AS cover_file FROM lectures WHERE published=1 AND substr(start_at,1,10)>=? ORDER BY start_at ASC, id ASC").all(today());
  const instructors = db.prepare('SELECT * FROM instructors WHERE published=1 ORDER BY id ASC').all();
  const months = [...new Set(lectures.map(x => x.start_at.slice(0, 7)))];
  const regions = [...new Set(lectures.map(x => x.region).filter(Boolean))];
  const filters = lectures.length ? `<div class="filters"><div class="filter-group"><button class="filter active" data-filter-month="all">전체 일정</button>${months.map(x => `<button class="filter" data-filter-month="${e(x)}">${e(monthText(x))}</button>`).join('')}</div><label class="region-select">지역 <select id="region-filter"><option value="all">전체 지역</option>${regions.map(x => `<option value="${e(x)}">${e(x)}</option>`).join('')}</select></label></div>` : '';
  const lectureArea = lectures.length ? `<div class="lecture-grid" id="lecture-grid">${lectures.map(lectureCard).join('')}</div><button class="lecture-show-more" id="lecture-show-more" type="button" aria-controls="lecture-grid" hidden></button><p class="no-filter-results" hidden>선택한 조건의 강의가 없습니다. 다른 월이나 지역을 선택해 주세요.</p>` : `<div class="empty-events"><div class="empty-icon">✦</div><h3>강의 일정을 준비하고 있어요</h3><p>일정이 확정되면 이곳에서 날짜와 장소를 확인하고 바로 신청할 수 있습니다.</p><a class="text-link" href="#contact">궁금한 점 문의하기 →</a></div>`;
  const instructorArea = instructors.length ? `<div class="instructor-grid">${instructors.map(x => `<article class="instructor-card"><div class="instructor-photo">${safeUrl(x.photo_url) ? `<img src="${e(safeUrl(x.photo_url))}" alt="${e(x.name)} 강사">` : `<span>${e(x.name.slice(0, 1))}</span>`}</div><div><span class="tag">${e(x.role || '전문 강사')}</span><h3>${e(x.name)}</h3><p>${e(x.bio)}</p></div></article>`).join('')}</div>` : `<div class="instructor-pending"><span class="pending-star">✦</span><div><h3>강사진을 곧 소개할게요</h3><p>강사의 전문 분야와 담당 강의를 확인할 수 있도록 준비하고 있습니다.</p></div></div>`;
  return html('쉽게 배우는 AI 강의', `<main><section class="hero"><div class="container hero-inner"><div class="hero-copy"><h1>AI를 배우는 첫걸음,<br><em>여기서 시작하세요.</em></h1><p class="hero-description">ChatGPT·Gemini·Claude. 낯선 이름도 직접 써보면 가까워집니다. 내 일상과 일에 맞는 강의를 골라, 강사와 함께 차근차근 배워보세요.</p><div class="hero-actions"><a class="button button-primary" href="#lectures">강의 일정 보기 <span>↗</span></a><a class="button button-outline" href="#approach">어떻게 배우나요?</a></div></div></div><div class="container hero-illustration"><img src="/assets/hero-ai-tools.png" alt="여러 세대가 함께 ChatGPT, Gemini, Claude를 배우고 일상에 활용하는 일러스트" width="1672" height="941"></div><div class="container hero-footnote"><span>처음 시작하는 분도, 더 잘 쓰고 싶은 분도</span><span>AI 미래교육원</span></div></section>
  <section class="section lectures-section" id="lectures"><div class="container"><div class="section-head"><div><p class="eyebrow">강의 일정</p><h2>나에게 맞는 강의를 찾아보세요</h2><p class="section-sub">날짜와 지역을 확인하고 강의를 누르면 자세한 내용을 볼 수 있어요.</p></div></div>${filters}${lectureArea}</div></section>
  <section class="section approach-section" id="approach"><div class="container"><div class="section-head"><div><h2>어렵게 설명하지 않을게요</h2><p class="section-sub">처음 배우는 분도 직접 해보며 익힐 수 있도록 준비합니다.</p></div></div><div class="approach-grid"><article><div class="approach-copy"><h3>AI 기초부터 차근차근</h3><p>낯선 용어도 쉽게 배워요.</p></div><div class="approach-art art-basics" aria-hidden="true"></div></article><article><div class="approach-copy"><h3>보면서 직접 실습</h3><p>강사와 하나씩 따라 해요.</p></div><div class="approach-art art-practice" aria-hidden="true"></div></article><article><div class="approach-copy"><h3>막히면 바로 질문</h3><p>궁금한 건 그 자리에서 물어요.</p></div><div class="approach-art art-question" aria-hidden="true"></div></article><article><div class="approach-copy"><h3>배운 뒤 바로 활용</h3><p>일상과 업무에 써봐요.</p></div><div class="approach-art art-life" aria-hidden="true"></div></article></div></div></section>
  <section class="section about-section" id="about"><div class="container about-grid"><div class="about-card"><img src="/assets/about-learning.jpg" alt="AI 미래교육원 강사와 학습자가 함께 AI를 배우는 장면. 배움은 가볍게, 가능성은 넓게." width="1672" height="941" loading="lazy"></div><div class="about-copy"><p class="eyebrow">교육원 소개</p><h2>AI를 처음 만나는 순간부터<br>함께하겠습니다</h2><p>AI 미래교육원은 (주)반도생활건강이 운영하는 AI 교육 브랜드입니다. 여유톡에서 공연과 강연으로 다양한 사람을 만나온 경험을 바탕으로, 이제 누구나 참여할 수 있는 배움의 시간을 만들고자 합니다.</p><p>강의마다 대상과 내용을 분명하게 안내하고, 배우는 사람이 직접 해볼 수 있는 수업을 준비하겠습니다.</p></div></div></section>
  <section class="section instructors-section" id="instructors"><div class="container"><div class="section-head"><div><p class="eyebrow">강사진</p><h2>함께 배우는 강사진</h2><p class="section-sub">강사별 전문 분야와 담당 강의를 확인해 보세요.</p></div></div>${instructorArea}</div></section>
  <section class="section faq-section" id="faq"><div class="container faq-grid"><div><p class="eyebrow">자주 묻는 질문</p><h2>궁금한 점을 확인하세요</h2><p>더 자세한 내용은 각 강의의 상세 페이지에서 안내합니다.</p></div><div class="faq-list"><details><summary>강의는 어떻게 신청하나요?<span>+</span></summary><p>원하는 강의를 누르면 상세 페이지가 열립니다. 내용을 확인하고 신청 버튼을 눌러 주세요.</p></details><details><summary>AI를 처음 배우는데 괜찮을까요?<span>+</span></summary><p>강의마다 권장 수준이 다릅니다. 상세 페이지에서 대상과 준비물을 확인하고 나에게 맞는 강의를 선택해 주세요.</p></details><details><summary>강의 장소와 시간은 어디서 보나요?<span>+</span></summary><p>강의 목록에서 날짜와 지역을 먼저 볼 수 있습니다. 정확한 장소와 시간은 강의 상세 페이지를 확인해 주세요.</p></details><details><summary>기업이나 단체 교육도 문의할 수 있나요?<span>+</span></summary><p>네. 교육 목적, 대상, 인원, 희망 지역을 아래 문의 양식에 남겨 주세요.</p></details></div></div></section>
  <section class="contact-section" id="contact"><div class="container contact-grid"><div><p class="eyebrow">문의하기</p><h2>궁금한 점이 있나요?</h2><p>강의 일정이나 단체 교육이 궁금하면 편하게 문의해 주세요.</p></div><form action="/inquiries" method="post" class="contact-form"><h3>문의 남기기</h3>${message ? `<div class="form-message">${e(message)}</div>` : ''}<label>이름 <input name="name" maxlength="50" required autocomplete="name" placeholder="성함을 입력해 주세요"></label><label>연락처 <input name="contact" maxlength="100" required placeholder="전화번호 또는 이메일"></label><label>문의 유형 <select name="kind" required><option value="">선택해 주세요</option><option>강의 일정</option><option>기업·단체 교육</option><option>기타 문의</option></select></label><label>문의 내용 <textarea name="message" maxlength="2000" rows="4" required placeholder="궁금한 점을 적어주세요"></textarea></label><label class="consent"><input type="checkbox" name="consent" value="yes" required><span><a href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>을 확인하고 문의 처리를 위한 수집·이용에 동의합니다.</span></label><input class="honeypot" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="button button-primary" type="submit">문의 보내기 <span>→</span></button></form></div></section></main>`);
}

function renderPrivacy() { return html('개인정보처리방침', `<main class="legal-page container"><p class="eyebrow dark">PRIVACY POLICY</p><h1>개인정보처리방침</h1><p>AI 미래교육원 운영사 (주)반도생활건강은 홈페이지 문의에 필요한 최소한의 정보를 처리합니다.</p><h2>1. 수집 항목 및 목적</h2><p>문의 양식에서 이름, 연락처, 문의 유형, 문의 내용을 수집하며, 문의 확인 및 답변을 위해 사용합니다.</p><h2>2. 보유 기간</h2><p>문의 접수일로부터 1년간 보관하고 삭제합니다. 관련 법령에 따라 더 보관해야 하는 경우에는 해당 기간을 따릅니다.</p><h2>3. 제3자 제공</h2><p>사전 동의나 법적 근거 없이 제3자에게 제공하지 않습니다.</p><h2>4. 이용자의 권리</h2><p>정보의 열람, 정정, 삭제, 처리정지를 요청할 수 있습니다. 대표번호 1877-6201로 연락해 주세요.</p><h2>5. 운영 정보</h2><p>(주)반도생활건강 · 대표 박인우<br>부산광역시 금정구 중앙대로 2014<br>사업자등록번호 607-81-98610 · 대표번호 1877-6201</p><p class="legal-note">시행일: 2026년 10월 8일. 실제 운영 및 외부 서비스 위탁 방식이 확정되면 내용을 갱신합니다.</p></main>`, { subpage: true }); }

function renderLecture(item) {
  const images = db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='gallery' ORDER BY id").all(item.id);
  const landingImage = db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='landing' ORDER BY id DESC LIMIT 1").get(item.id);
  const body = String(item.detail_body || item.summary || '').trim().split(/\n\s*\n/).filter(Boolean).map(p => `<p>${e(p).replace(/\n/g, '<br>')}</p>`).join('');
  const application = safeUrl(item.landing_url);
  const landingSection = landingImage ? `<div class="lecture-landing-image"><img src="/uploads/${e(landingImage.filename)}" alt="${e(landingImage.caption || item.title + ' 상세 안내')}" loading="lazy"></div>` : '';
  return html(item.title, `<main class="lecture-page container"><a class="lecture-back" href="/#lectures">← 강의 목록으로</a><div class="lecture-page-heading"><span class="lecture-page-topic">${e(item.topic)}</span><h1>${e(item.title)}</h1>${item.summary ? `<p>${e(item.summary)}</p>` : ''}</div>${images[0] ? `<img class="lecture-page-cover" src="/uploads/${e(images[0].filename)}" alt="${e(images[0].caption || item.title)}">` : ''}<div class="lecture-page-layout"><article class="lecture-page-main"><h2>강의 소개</h2><div class="lecture-page-body">${body || '<p>강의 내용을 준비하고 있습니다.</p>'}</div>${images.length > 1 ? `<div class="lecture-page-gallery">${images.slice(1).map(img => `<figure><img src="/uploads/${e(img.filename)}" alt="${e(img.caption || item.title)}" loading="lazy">${img.caption ? `<figcaption>${e(img.caption)}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}${landingSection}</article><aside class="lecture-page-aside"><h2>강의 안내</h2><dl><div><dt>일시</dt><dd>${e(dateText(item.start_at))}</dd></div><div><dt>진행 방식</dt><dd>${e(item.format)}</dd></div>${item.region || item.location ? `<div><dt>장소</dt><dd>${e([item.region, item.location].filter(Boolean).join(' · '))}</dd></div>` : ''}${item.audience ? `<div><dt>추천 대상</dt><dd>${e(item.audience)}</dd></div>` : ''}<div><dt>참가비</dt><dd>${e(item.price_label)}</dd></div></dl><a class="button button-primary" href="${application ? e(application) : '/#contact'}" ${application ? 'target="_blank" rel="noopener noreferrer"' : ''}>${application ? '신청 페이지로 이동' : '강의 문의하기'} <span>↗</span></a><p>자세한 신청 조건은 연결된 신청 페이지에서 확인해 주세요.</p></aside></div></main>`, { subpage: true });
}

function renderDashboard(session) {
  const lectures = db.prepare('SELECT * FROM lectures ORDER BY start_at DESC, id DESC').all();
  const teachers = db.prepare('SELECT * FROM instructors ORDER BY id DESC').all();
  const count = db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n;
  return adminShell('운영 현황', `<div class="admin-stats"><div><strong>${lectures.length}</strong><span>등록 강의</span></div><div><strong>${lectures.filter(x => x.published).length}</strong><span>공개 강의</span></div><div><strong>${teachers.length}</strong><span>등록 강사</span></div><div><strong>${count}</strong><span>접수 문의</span></div></div><div class="admin-section-title"><h2>강의 관리</h2><a class="admin-primary" href="/admin/lectures/new">+ 새 강의 추가</a></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>일시</th><th>강의</th><th>지역</th><th>상태</th><th>관리</th></tr></thead><tbody>${lectures.length ? lectures.map(x => `<tr><td>${e(dateText(x.start_at))}</td><td><strong>${e(x.title)}</strong><small>${e(x.topic)}</small></td><td>${e(x.region || '-')}</td><td><span class="status ${x.published ? 'published' : ''}">${x.published ? '공개' : '비공개'}</span></td><td><a href="/admin/lectures/${x.id}">수정 →</a></td></tr>`).join('') : '<tr><td colspan="5" class="table-empty">등록된 강의가 없습니다. 첫 강의를 추가해 주세요.</td></tr>'}</tbody></table></div><div class="admin-section-title"><h2>강사진</h2><a class="admin-primary" href="/admin/instructors/new">+ 강사 추가</a></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>이름</th><th>전문 분야</th><th>상태</th><th>관리</th></tr></thead><tbody>${teachers.length ? teachers.map(x => `<tr><td><strong>${e(x.name)}</strong></td><td>${e(x.role)}</td><td><span class="status ${x.published ? 'published' : ''}">${x.published ? '공개' : '비공개'}</span></td><td><a href="/admin/instructors/${x.id}">수정 →</a></td></tr>`).join('') : '<tr><td colspan="4" class="table-empty">강사 정보를 등록해 주세요.</td></tr>'}</tbody></table></div>`);
}

function lectureForm(item, session, error = '') {
  const isNew = !item.id;
  const landingImage = isNew ? null : db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='landing' ORDER BY id DESC LIMIT 1").get(item.id);
  const landingAdmin = isNew ? '' : `<section class="lecture-image-admin" id="landing-image"><h2>본문 아래 랜딩페이지 이미지</h2><p>강의 소개 글 아래에 긴 이미지가 원래 비율로 표시됩니다. JPG, PNG, WebP 파일을 최대 20MB까지 올릴 수 있습니다. 새 파일을 올리면 기존 이미지는 교체됩니다.</p>${landingImage ? `<div class="landing-image-preview"><img src="/uploads/${e(landingImage.filename)}" alt="${e(landingImage.caption || '랜딩페이지 이미지 미리보기')}"><form action="/admin/lectures/images/delete" method="post" data-confirm="랜딩페이지 이미지를 삭제할까요?">${csrfField(session)}<input type="hidden" name="id" value="${landingImage.id}"><button class="delete-button">랜딩페이지 이미지 삭제</button></form></div>` : ''}<form action="/admin/lectures/${item.id}/images" method="post" enctype="multipart/form-data" class="admin-form image-upload-form">${csrfField(session)}<input type="hidden" name="placement" value="landing"><label>랜딩페이지 이미지 파일 <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label><label>이미지 설명 <input name="caption" maxlength="160" placeholder="예: 강의 일정과 상세 안내"></label><button class="admin-primary">${landingImage ? '이미지 교체' : '이미지 업로드'}</button></form></section>`;
  return adminShell(isNew ? '새 강의 추가' : '강의 수정', `<div class="admin-card">
    ${error ? `<div class="admin-error">${e(error)}</div>` : ''}
    <form action="/admin/lectures/save" method="post" class="admin-form">
      ${csrfField(session)}<input type="hidden" name="id" value="${e(item.id || '')}">
      <div class="field-grid">
        <label>강의명 <input name="title" value="${e(item.title)}" maxlength="120" required placeholder="예: AI 3종 활용 입문"></label>
        <label>주제 <input name="topic" value="${e(item.topic || 'AI 활용')}" maxlength="40" required placeholder="예: 생성형 AI 입문"></label>
      </div>
      <label>짧은 소개 <textarea name="summary" maxlength="300" rows="3" placeholder="목록에 표시할 강의 설명">${e(item.summary)}</textarea></label>
      <label>상세 페이지 본문 <textarea name="detail_body" maxlength="12000" rows="12" placeholder="강의에서 배우는 내용, 진행 순서, 준비물을 자세히 적어주세요. 빈 줄을 넣으면 문단이 나뉩니다.">${e(item.detail_body)}</textarea><small>강의 상세 페이지에 표시됩니다. 빈 줄로 문단을 나눌 수 있습니다.</small></label>
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
        <label>신청 랜딩페이지 URL <input type="url" name="landing_url" value="${e(item.landing_url)}" placeholder="https://..."><small>선택 사항입니다. 입력하면 상세 페이지의 신청 버튼이 이 주소로 연결됩니다.</small></label>
      </div>
      <label class="admin-check"><input type="checkbox" name="published" value="1" ${item.published ? 'checked' : ''}> 홈페이지에 공개</label>
      <div class="form-actions"><button class="admin-primary" type="submit">${isNew ? '강의 등록' : '변경 저장'}</button><a href="/admin">취소</a></div>
    </form>
    ${landingAdmin}
    ${isNew ? '<p class="upload-hint">강의를 먼저 저장하면 이미지를 올릴 수 있습니다.</p>' : `<section class="lecture-image-admin" id="images"><h2>대표·추가 이미지</h2><p>첫 번째 이미지가 강의 목록과 상세 페이지의 대표 이미지로 표시됩니다. JPG, PNG, WebP 파일을 최대 8MB까지 올릴 수 있습니다.</p><div class="admin-image-grid">${db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='gallery' ORDER BY id").all(item.id).map(img => `<figure><img src="/uploads/${e(img.filename)}" alt="${e(img.caption || item.title)}"><figcaption>${e(img.caption || '설명 없음')}</figcaption><form action="/admin/lectures/images/delete" method="post" data-confirm="이 이미지를 삭제할까요?">${csrfField(session)}<input type="hidden" name="id" value="${img.id}"><button class="delete-button">이미지 삭제</button></form></figure>`).join('') || '<p>등록된 이미지가 없습니다.</p>'}</div><form action="/admin/lectures/${item.id}/images" method="post" enctype="multipart/form-data" class="admin-form image-upload-form">${csrfField(session)}<label>이미지 파일 <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label><label>이미지 설명 <input name="caption" maxlength="160" placeholder="사진에 담긴 내용을 간단히 적어주세요"></label><button class="admin-primary">이미지 업로드</button></form></section><p><a href="/lectures/${item.id}" target="_blank" rel="noopener">공개 상세 페이지 미리 보기 ↗</a></p><form action="/admin/lectures/delete" method="post" class="delete-form" data-confirm="이 강의를 삭제할까요? 되돌릴 수 없습니다.">${csrfField(session)}<input type="hidden" name="id" value="${item.id}"><button class="delete-button">강의 삭제</button></form>`}
  </div>`);
}

function instructorForm(item, session, error = '') {
  const isNew = !item.id;
  return adminShell(isNew ? '강사 추가' : '강사 수정', `<div class="admin-card">${error ? `<div class="admin-error">${e(error)}</div>` : ''}<form action="/admin/instructors/save" method="post" class="admin-form">${csrfField(session)}<input type="hidden" name="id" value="${e(item.id || '')}"><div class="field-grid"><label>이름 <input name="name" value="${e(item.name)}" maxlength="60" required></label><label>전문 분야 <input name="role" value="${e(item.role)}" maxlength="100" placeholder="예: 생성형 AI 실무 강사"></label></div><label>소개 <textarea name="bio" maxlength="600" rows="5" placeholder="대표 경력과 담당 강의를 간결하게 적어주세요">${e(item.bio)}</textarea></label><label>사진 URL <input type="url" name="photo_url" value="${e(item.photo_url)}" placeholder="https://..."><small>강사 사진의 공개 HTTPS 주소를 입력하세요. 비워 두면 이니셜이 표시됩니다.</small></label><label class="admin-check"><input type="checkbox" name="published" value="1" ${item.published ? 'checked' : ''}> 홈페이지에 공개</label><div class="form-actions"><button class="admin-primary" type="submit">${isNew ? '강사 등록' : '변경 저장'}</button><a href="/admin">취소</a></div></form>${isNew ? '' : `<form action="/admin/instructors/delete" method="post" class="delete-form" data-confirm="이 강사를 삭제할까요? 되돌릴 수 없습니다.">${csrfField(session)}<input type="hidden" name="id" value="${item.id}"><button class="delete-button">강사 삭제</button></form>`}</div>`);
}

function renderInquiries() { const items = db.prepare('SELECT * FROM inquiries ORDER BY id DESC').all(); return adminShell('문의함', `<div class="inquiry-list">${items.length ? items.map(x => `<article class="inquiry-item"><div><span class="tag">${e(x.kind)}</span><time>${e(x.created_at)}</time></div><h2>${e(x.name)} <small>${e(x.contact)}</small></h2><p>${e(x.message).replace(/\n/g, '<br>')}</p></article>`).join('') : '<div class="admin-card">아직 접수된 문의가 없습니다.</div>'}</div>`); }

function limit(map, key, count, duration) { const now = Date.now(); const current = (map.get(key) || []).filter(t => now - t < duration); current.push(now); map.set(key, current); return current.length <= count; }

async function route(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
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
  if (req.method === 'GET' && /^\/lectures\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM lectures WHERE id=? AND published=1').get(Number(pathname.split('/').pop())); return item ? send(res, 200, renderLecture(item)) : send(res, 404, html('강의를 찾을 수 없습니다', '<main class="legal-page container"><h1>강의를 찾을 수 없습니다.</h1><a href="/#lectures">강의 목록으로 →</a></main>')); }
  if (req.method === 'GET' && pathname === '/privacy') return send(res, 200, renderPrivacy());
  if (req.method === 'POST' && pathname === '/inquiries') {
    if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
    const body = await readBody(req);
    if (body.website) return redirect(res, '/?sent=1#contact');
    const ip = req.socket.remoteAddress || 'unknown';
    if (!limit(inquiryAttempts, ip, 5, 60 * 60 * 1000)) return send(res, 429, html('잠시 후 다시 시도해 주세요', '<main class="legal-page container"><h1>문의가 너무 자주 접수되었습니다.</h1><p>잠시 후 다시 시도하거나 1877-6201로 연락해 주세요.</p></main>'));
    if (!body.consent || !body.name?.trim() || !body.contact?.trim() || !body.kind?.trim() || !body.message?.trim() || body.name.length > 50 || body.contact.length > 100 || body.message.length > 2000) return send(res, 400, html('입력 확인', '<main class="legal-page container"><h1>입력 내용을 확인해 주세요.</h1><p>모든 필수 항목과 개인정보 동의가 필요합니다.</p><a href="/#contact">문의로 돌아가기</a></main>'));
    db.exec("DELETE FROM inquiries WHERE created_at < datetime('now', '-1 year')");
    db.prepare('INSERT INTO inquiries(name,contact,kind,message) VALUES(?,?,?,?)').run(body.name.trim(), body.contact.trim(), body.kind.trim(), body.message.trim());
    return redirect(res, '/?sent=1#contact');
  }
  if (pathname === '/admin/login' && req.method === 'GET') return send(res, 200, html('관리자 로그인', `<main class="login-page"><div class="login-card"><a href="/" class="admin-login-brand">AI 미래교육원</a><p class="eyebrow dark">ADMIN ACCESS</p><h1>관리자 로그인</h1><p>강의 일정과 강사진을 관리합니다.</p>${new URL(req.url, 'http://local').searchParams.has('error') ? '<div class="admin-error">비밀번호를 확인해 주세요.</div>' : ''}<form action="/admin/login" method="post"><label>관리자 비밀번호<input type="password" name="password" required autocomplete="current-password"></label><button class="admin-primary">로그인</button></form><a class="back-home" href="/">← 홈페이지로 돌아가기</a></div></main>`, { admin: true }));
  if (pathname === '/admin/login' && req.method === 'POST') {
    if (!verifyOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain');
    const ip = req.socket.remoteAddress || 'unknown';
    if (!limit(loginAttempts, ip, 10, 15 * 60 * 1000)) return send(res, 429, 'Too many attempts', 'text/plain');
    const body = await readBody(req);
    const configured = process.env.ADMIN_PASSWORD;
    if (!configured || configured.length < 12) return send(res, 503, html('관리자 설정 필요', '<main class="legal-page container"><h1>관리자 비밀번호 설정이 필요합니다.</h1><p>서버 환경 변수 ADMIN_PASSWORD에 12자 이상의 비밀번호를 설정해 주세요.</p></main>', { admin: true }));
    const inputHash = crypto.createHash('sha256').update(body.password || '').digest();
    const expectedHash = crypto.createHash('sha256').update(configured).digest();
    if (!crypto.timingSafeEqual(inputHash, expectedHash)) return redirect(res, '/admin/login?error=1');
    const token = newSession(); return redirect(res, '/admin', { 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie(req)}` });
  }
  if (pathname.startsWith('/admin')) {
    const session = currentSession(req);
    if (!session) return redirect(res, '/admin/login');
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
      return send(res, 404, 'Not found', 'text/plain');
    }
    if (req.method === 'GET' && pathname === '/admin') return send(res, 200, renderDashboard(session));
    if (req.method === 'GET' && pathname === '/admin/lectures/new') return send(res, 200, lectureForm({}, session));
    if (req.method === 'GET' && /^\/admin\/lectures\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM lectures WHERE id=?').get(Number(pathname.split('/').pop())); return item ? send(res, 200, lectureForm(item, session)) : send(res, 404, 'Not found', 'text/plain'); }
    if (req.method === 'GET' && pathname === '/admin/instructors/new') return send(res, 200, instructorForm({}, session));
    if (req.method === 'GET' && /^\/admin\/instructors\/\d+$/.test(pathname)) { const item = db.prepare('SELECT * FROM instructors WHERE id=?').get(Number(pathname.split('/').pop())); return item ? send(res, 200, instructorForm(item, session)) : send(res, 404, 'Not found', 'text/plain'); }
    if (req.method === 'GET' && pathname === '/admin/inquiries') return send(res, 200, renderInquiries());
  }
  return send(res, 404, html('페이지를 찾을 수 없습니다', '<main class="legal-page container"><h1>페이지를 찾을 수 없습니다.</h1><a href="/">홈으로 돌아가기 →</a></main>'));
}

const server = http.createServer((req, res) => route(req, res).catch(error => { console.error(error); if (!res.headersSent) send(res, 500, '서버 오류가 발생했습니다.', 'text/plain; charset=utf-8'); }));
if (require.main === module) server.listen(PORT, () => console.log(`AI 미래교육원: http://localhost:${PORT}`));
module.exports = { server, db, renderHome, renderLecture, renderPrivacy, safeUrl };


