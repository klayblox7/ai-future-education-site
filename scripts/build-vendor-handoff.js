const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const copyTree = (source, target) => {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
};

const root = path.resolve(__dirname, '..');
const deliverables = path.join(root, 'deliverables');
const output = path.join(deliverables, 'vendor-handoff');
if (path.resolve(output) !== path.resolve(root, 'deliverables', 'vendor-handoff') || !output.startsWith(root + path.sep)) throw new Error('Unexpected handoff output directory');
fs.mkdirSync(deliverables, { recursive: true });
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-future-vendor-'));
let db;
try {
  const imported = spawnSync(process.execPath, [path.join(__dirname, 'import-public-seed.js')], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8'
  });
  if (imported.status !== 0) throw new Error(`Public seed import failed: ${imported.stderr || imported.stdout}`);
  process.env.DATA_DIR = dataDir;
  const site = require('../server');
  db = site.db;
  const publicContent = JSON.parse(fs.readFileSync(path.join(root, 'seed', 'public-content.json'), 'utf8'));
  const uploadNames = new Set(publicContent.images.map(image => image.filename));
  for (const review of publicContent.reviews || []) if (review.image_path.startsWith('/uploads/')) uploadNames.add(path.basename(review.image_path));
  const htmlDir = path.join(output, 'html-site');
  fs.mkdirSync(htmlDir, { recursive: true });
  copyTree(path.join(root, 'public', 'assets'), path.join(htmlDir, 'assets'));
  fs.rmSync(path.join(htmlDir, 'assets', 'sample-landing.jpg'), { force: true });
  fs.mkdirSync(path.join(htmlDir, 'uploads'));
  for (const name of uploadNames) fs.copyFileSync(path.join(root, 'seed', 'uploads', name), path.join(htmlDir, 'uploads', name));
  fs.copyFileSync(path.join(root, 'public', 'app.js'), path.join(htmlDir, 'app.js'));
  for (const name of ['style.css', 'site.css']) {
    const css = fs.readFileSync(path.join(root, 'public', name), 'utf8').replace(/url\(['"]?\/assets\//g, match => match.replace('/assets/', 'assets/'));
    fs.writeFileSync(path.join(htmlDir, name), css);
  }

  const staticHtml = (source, depth) => {
    const up = '../'.repeat(depth);
    return source.replace('<a href="/admin">관리자</a>', '').replace(/(href|src|action)="\/([^"#?]*)([^\"]*)"/g, (match, attr, pathname, suffix) => {
      if (attr === 'href' && pathname === '') return `${attr}="${up}index.html${suffix}"`;
      if (attr === 'href' && pathname === 'privacy') return `${attr}="${up}privacy/index.html${suffix}"`;
      if (attr === 'href' && /^lectures\/\d+$/.test(pathname)) return `${attr}="${up}${pathname}/index.html${suffix}"`;
      return `${attr}="${up}${pathname}${suffix}"`;
    });
  };
  const writePage = (relative, source, depth) => {
    const target = path.join(htmlDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, staticHtml(source, depth));
  };
  writePage('index.html', site.renderHome(), 0);
  writePage(path.join('privacy', 'index.html'), site.renderPrivacy(), 1);
  const lectures = db.prepare('SELECT * FROM lectures WHERE published=1 ORDER BY id').all();
  for (const lecture of lectures) writePage(path.join('lectures', String(lecture.id), 'index.html'), site.renderLecture(lecture), 2);
  const pages = ['index.html', path.join('privacy', 'index.html'), ...lectures.map(lecture => path.join('lectures', String(lecture.id), 'index.html'))];
  for (const relative of pages) {
    const file = path.join(htmlDir, relative);
    const markup = fs.readFileSync(file, 'utf8');
    if (markup.includes('신청 미리보기') || markup.includes('github.io')) throw new Error(`Preview content in ${relative}`);
    for (const [, attribute, link] of markup.matchAll(/\b(href|src)="([^"]+)"/g)) {
      if (/^(https?:|tel:|mailto:|#|data:)/.test(link)) continue;
      const target = path.resolve(path.dirname(file), link.split(/[?#]/, 1)[0]);
      if (!target.startsWith(htmlDir + path.sep) || !fs.existsSync(target)) throw new Error(`Broken ${attribute} in ${relative}: ${link}`);
    }
  }
  if (!fs.readFileSync(path.join(htmlDir, 'index.html'), 'utf8').includes('action="inquiries"')) throw new Error('Inquiry form missing');
  for (const lecture of lectures) if (!fs.readFileSync(path.join(htmlDir, 'lectures', String(lecture.id), 'index.html'), 'utf8').includes('action="../../registrations"')) throw new Error(`Registration form missing for ${lecture.id}`);
  fs.copyFileSync(path.join(root, 'seed', 'public-content.json'), path.join(htmlDir, 'public-content.json'));

  const nodeDir = path.join(output, 'node-app');
  fs.mkdirSync(nodeDir);
  for (const name of ['server.js', 'package.json', 'Dockerfile', '.env.example', 'README.md']) fs.copyFileSync(path.join(root, name), path.join(nodeDir, name));
  for (const name of ['public', 'seed', 'scripts', 'test']) copyTree(path.join(root, name), path.join(nodeDir, name));
  fs.rmSync(path.join(nodeDir, 'public', 'assets', 'sample-landing.jpg'), { force: true });
  for (const name of fs.readdirSync(path.join(nodeDir, 'seed', 'uploads'))) if (!uploadNames.has(name)) fs.rmSync(path.join(nodeDir, 'seed', 'uploads', name));
  fs.rmSync(path.join(nodeDir, 'scripts', 'build-vendor-handoff.js'));
  const nodeReadme = path.join(nodeDir, 'README.md');
  fs.writeFileSync(nodeReadme, fs.readFileSync(nodeReadme, 'utf8').replace(/^강사 정보는 아직 등록되지 않았습니다\..*\r?\n/m, '강사 정보는 아직 등록되지 않았습니다.\n'));
  for (const name of ['README-업체전달.md', 'FORM-API.md']) fs.copyFileSync(path.join(root, 'handoff', name), path.join(output, name));
  fs.writeFileSync(path.join(output, 'VERSION.txt'), `AI 미래교육원 업체 인계본\n생성일: ${new Date().toISOString()}\n공개 강의: ${lectures.length}건\n개인정보·로컬 비밀번호·운영 DB: 미포함\n`);
  const files = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push(file);
    }
  };
  visit(output);
  const checksums = files.sort().map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(output, file).replace(/\\/g, '/')}`).join('\n') + '\n';
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), checksums);
  console.log(`Vendor handoff ready: ${output} (${lectures.length} published lectures, ${files.length} files)`);
} finally {
  if (db) db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
