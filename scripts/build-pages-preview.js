const fs = require('node:fs');
const path = require('node:path');
const { db, renderHome, renderLecture, renderPrivacy } = require('../server');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs');
const base = '/ai-future-education-site';
try {
  if (path.resolve(output) !== path.resolve(root, 'docs') || !output.startsWith(root + path.sep)) throw new Error('Unexpected output path');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['app.js', 'style.css', 'site.css']) fs.copyFileSync(path.join(root, 'public', name), path.join(output, name));
  fs.mkdirSync(path.join(output, 'assets'));
  for (const name of fs.readdirSync(path.join(root, 'public', 'assets'))) fs.copyFileSync(path.join(root, 'public', 'assets', name), path.join(output, 'assets', name));
  fs.mkdirSync(path.join(output, 'uploads'));
  for (const name of fs.readdirSync(path.join(root, 'seed', 'uploads'))) fs.copyFileSync(path.join(root, 'seed', 'uploads', name), path.join(output, 'uploads', name));
  fs.writeFileSync(path.join(output, '.nojekyll'), '');

  const preview = source => source
    .replace(/<section class="contact-section" id="contact">[\s\S]*?<\/section>/, '')
    .replace(/<a class="mobile-nav-contact" href="\/#contact">문의하기<\/a>/, '')
    .replace(/<a class="nav-cta" href="\/#contact">교육 문의<\/a>/, '')
    .replace(/<a href="\/#contact">문의하기<\/a>/g, '')
    .replace(/<div class="mobile-actionbar">[\s\S]*?<\/div>/, '')
    .replace(/<details><summary>기업이나 단체 교육도 문의할 수 있나요\?[\s\S]*?<\/details>/, '')
    .replace(/<details><summary>강의는 어떻게 신청하나요\?[\s\S]*?<\/details>/, '<details><summary>강의는 어떻게 신청하나요?<span>+</span></summary><p>현재 페이지는 강의 소개용 미리보기입니다. 신청 기능은 정식 운영 사이트에서 안내합니다.</p></details>')
    .replace(/<a class="button button-primary" href="\/#contact"[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<p>자세한 신청 조건은 연결된 신청 페이지에서 확인해 주세요.<\/p>/g, '')
    .replace('<a href="/admin">관리자</a>', '')
    .replace(/(href|src|action)="\/(?!\/)/g, (_, attr) => `${attr}="${base}/`)
    .replace(new RegExp(`href="${base}/lectures/(\\d+)"`, 'g'), `href="${base}/lectures/$1/"`)
    .replace(`href="${base}/privacy"`, `href="${base}/privacy/"`);
  const writePage = (relative, source) => {
    const dir = path.join(output, relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), preview(source));
  };
  writePage('', renderHome());
  writePage('privacy', renderPrivacy());
  for (const lecture of db.prepare('SELECT * FROM lectures WHERE published=1 ORDER BY id').all()) {
    writePage(path.join('lectures', String(lecture.id)), renderLecture(lecture));
  }
  for (const stylesheet of ['style.css', 'site.css']) {
    const file = path.join(output, stylesheet);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/url\('\/assets\//g, `url('${base}/assets/`));
  }
  fs.appendFileSync(path.join(output, 'site.css'), '\n@media(max-width:760px){body:not(.admin-body){padding-bottom:0}}\n');
  console.log('GitHub Pages preview built in docs/. Admin and inquiry forms are not active in this static preview.');
} finally {
  db.close();
}
