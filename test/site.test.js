const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('published lecture seed imports into a fresh data directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-future-seed-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-public-seed.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: dir },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const seeded = new DatabaseSync(path.join(dir, 'site.sqlite'), { readOnly: true });
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM lectures WHERE published=1').get().n, 2);
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM lecture_images').get().n, 4);
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n, 0);
    seeded.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin can publish and update a lecture, and inquiries are stored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-future-site-'));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_PASSWORD = 'test-password-that-is-long';
  const { server, db } = require('../server');
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  try {
    const empty = await fetch(base);
    assert.equal(empty.status, 200);
    const emptyHtml = await empty.text();
    assert.match(emptyHtml, /강의 일정을 준비하고 있어요/);
    assert.match(emptyHtml, /ChatGPT·Gemini·Claude/);
    assert.doesNotMatch(emptyHtml, /2026\.11 첫 강의 시작/);
    assert.match(emptyHtml, /aria-controls="main-nav"/);

    const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 303);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const form = await fetch(`${base}/admin/lectures/new`, { headers: { Cookie: cookie } });
    const csrf = (await form.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
    const lecture = { csrf, title: 'AI 3종 활용 입문', topic: '생성형 AI', summary: '직접 써보는 입문 강의', detail_body: '첫 번째 문단\n\n두 번째 <안전한> 문단', audience: '처음 배우는 분', start_at: '2027-11-15T14:00', region: '부산', location: '교육장', format: '오프라인', price_label: '무료', landing_url: 'https://example.com/lecture', published: '1' };
    const create = await fetch(`${base}/admin/lectures/save`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(lecture) });
    assert.equal(create.status, 303);
    const published = await (await fetch(base)).text();
    assert.match(published, /AI 3종 활용 입문/);
    assert.match(published, /href="\/lectures\/1"/);
    assert.match(published, /data-region="부산"/);
    assert.match(published, /추천 대상<\/strong> 처음 배우는 분/);

    const item = db.prepare('SELECT id FROM lectures LIMIT 1').get();
    const detail = await fetch(`${base}/lectures/${item.id}`);
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /https:\/\/example.com\/lecture/);
    assert.match(detailHtml, /두 번째 &lt;안전한&gt; 문단/);

    const imageForm = new FormData();
    imageForm.set('csrf', csrf);
    imageForm.set('caption', '수업 현장');
    imageForm.set('image', new Blob([Buffer.from('89504e470d0a1a0a0000000049454e440000000000000000000000000000000000000000', 'hex')], { type: 'image/png' }), 'photo.png');
    const upload = await fetch(`${base}/admin/lectures/${item.id}/images`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: imageForm });
    assert.equal(upload.status, 303);
    const image = db.prepare('SELECT * FROM lecture_images WHERE lecture_id=?').get(item.id);
    assert.ok(image);
    assert.equal((await fetch(`${base}/uploads/${image.filename}`)).status, 200);
    assert.match(await (await fetch(base)).text(), new RegExp(image.filename.replace('.', '\\.')));
    assert.match(await (await fetch(`${base}/lectures/${item.id}`)).text(), /수업 현장/);
    const removeImage = await fetch(`${base}/admin/lectures/images/delete`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, id: String(image.id) }) });
    assert.equal(removeImage.status, 303);
    assert.equal((await fetch(`${base}/uploads/${image.filename}`)).status, 404);
    imageForm.set('placement', 'landing');
    const landingUpload = await fetch(`${base}/admin/lectures/${item.id}/images`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: imageForm });
    assert.equal(landingUpload.status, 303);
    const landingImage = db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='landing'").get(item.id);
    assert.ok(landingImage);
    const landingPage = await (await fetch(`${base}/lectures/${item.id}`)).text();
    assert.match(landingPage, /class="lecture-landing-image"/);
    assert.match(landingPage, new RegExp(landingImage.filename.replace('.', '\\.')));
    const replaceLanding = await fetch(`${base}/admin/lectures/${item.id}/images`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: imageForm });
    assert.equal(replaceLanding.status, 303);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lecture_images WHERE lecture_id=? AND placement='landing'").get(item.id).count, 1);
    assert.equal((await fetch(`${base}/uploads/${landingImage.filename}`)).status, 404);
    const change = await fetch(`${base}/admin/lectures/save`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...lecture, id: String(item.id), title: '수정된 강의', published: '' }) });
    assert.equal(change.status, 303);
    assert.doesNotMatch(await (await fetch(base)).text(), /수정된 강의/);
    assert.equal((await fetch(`${base}/lectures/${item.id}`)).status, 404);

    const invalid = await fetch(`${base}/admin/lectures/save`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...lecture, landing_url: 'javascript:alert(1)' }) });
    assert.equal(invalid.status, 400);

    const draft = await fetch(`${base}/admin/lectures/save`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...lecture, title: '주소 없는 초안', landing_url: '', published: '' }) });
    assert.equal(draft.status, 303);
    assert.doesNotMatch(await (await fetch(base)).text(), /주소 없는 초안/);

    const inquiry = await fetch(`${base}/inquiries`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: '테스트', contact: '010-0000-0000', kind: '강의 일정', message: '일정 문의', consent: 'yes' }) });
    assert.equal(inquiry.status, 303);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inquiries').get().count, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
