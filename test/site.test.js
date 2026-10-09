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
    assert.equal(seeded.prepare("SELECT COUNT(*) AS n FROM lecture_images WHERE placement='landing'").get().n, 2);
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n, 0);
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM reviews WHERE published=1').get().n, 4);
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
    assert.match(emptyHtml, /무료로 수강할 수 있나요/);
    assert.match(emptyHtml, /보람상조/);
    assert.match(emptyHtml, /40분에서 70분/);
    assert.match(emptyHtml, /실무 중심의 맞춤형 교육을 제공합니다/);
    assert.match(emptyHtml, /맞춤형 커리큘럼/);
    assert.match(emptyHtml, /실습 중심 교육/);
    assert.match(emptyHtml, /사진으로 보는 수업 후기/);
    assert.equal((emptyHtml.match(/class="review-card"/g) || []).length, 4);

    const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 303);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const form = await fetch(`${base}/admin/lectures/new`, { headers: { Cookie: cookie } });
    const csrf = (await form.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
    const reviewForm = new FormData();
    reviewForm.set('csrf', csrf);
    reviewForm.set('title', '새 수업 현장');
    reviewForm.set('body', '사진과 함께 배우는 시간이었습니다.');
    reviewForm.set('image_alt', '수업 현장 사진');
    reviewForm.set('sort_order', '9');
    reviewForm.set('published', '1');
    reviewForm.set('image', new Blob([Buffer.from('89504e470d0a1a0a0000000049454e440000000000000000000000000000000000000000', 'hex')], { type: 'image/png' }), 'review.png');
    const newReview = await fetch(`${base}/admin/reviews/save`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: reviewForm });
    assert.equal(newReview.status, 303);
    const savedReview = db.prepare("SELECT * FROM reviews WHERE title='새 수업 현장'").get();
    assert.ok(savedReview);
    assert.equal((await fetch(`${base}${savedReview.image_path}`)).status, 200);
    assert.match(await (await fetch(base)).text(), /새 수업 현장/);
    reviewForm.set('id', String(savedReview.id));
    reviewForm.delete('image');
    reviewForm.set('title', '수정한 후기');
    reviewForm.delete('published');
    assert.equal((await fetch(`${base}/admin/reviews/save`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: reviewForm })).status, 303);
    assert.doesNotMatch(await (await fetch(base)).text(), /수정한 후기/);
    assert.match(await (await fetch(`${base}/admin/reviews`, { headers: { Cookie: cookie } })).text(), /수정한 후기/);
    assert.equal((await fetch(`${base}/admin/reviews/delete`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, id: String(savedReview.id) }) })).status, 303);
    assert.equal((await fetch(`${base}${savedReview.image_path}`)).status, 404);
    const lecture = { csrf, title: 'AI 3종 활용 입문', topic: '생성형 AI', summary: '직접 써보는 입문 강의', detail_body: '첫 번째 문단\n\n두 번째 <안전한> 문단', audience: '처음 배우는 분', start_at: '2027-11-15T14:00', region: '부산', location: '교육장', format: '오프라인', price_label: '무료', landing_url: 'https://example.com/lecture', published: '1' };
    const create = await fetch(`${base}/admin/lectures/save`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(lecture) });
    assert.equal(create.status, 303);
    const published = await (await fetch(base)).text();
    assert.match(published, /AI 3종 활용 입문/);
    assert.match(published, /href="\/lectures\/1"/);
    assert.match(published, /data-region="부산"/);
    assert.match(published, /추천 대상<\/strong> 처음 배우는 분/);
    assert.match(published, /class="lecture-mobile-row"/);
    assert.match(published, /id="lecture-show-more"/);

    const addLecture = db.prepare('INSERT INTO lectures(title,topic,start_at,region,landing_url,published) VALUES(?,?,?,?,?,1)');
    for (let day = 16; day <= 25; day += 1) addLecture.run(`추가 강의 ${day}`, 'AI 활용', `2027-11-${day}T10:00`, '부산', 'https://example.com/lecture');
    const manyLectures = await (await fetch(base)).text();
    assert.equal((manyLectures.match(/class="lecture-mobile-row"/g) || []).length, 11);

    const item = db.prepare('SELECT id FROM lectures LIMIT 1').get();
    const detail = await fetch(`${base}/lectures/${item.id}`);
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /상세 안내 이미지를 준비하고 있습니다/);
    assert.doesNotMatch(detailHtml, /lecture-page-cover|lecture-page-aside|강의 소개/);
    assert.doesNotMatch(detailHtml, /https:\/\/example.com\/lecture|두 번째 &lt;안전한&gt; 문단/);

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
    assert.match(await (await fetch(base)).text(), /class="lecture-mobile-thumb"/);
    assert.doesNotMatch(await (await fetch(`${base}/lectures/${item.id}`)).text(), /수업 현장/);
    const removeImage = await fetch(`${base}/admin/lectures/images/delete`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, id: String(image.id) }) });
    assert.equal(removeImage.status, 303);
    assert.equal((await fetch(`${base}/uploads/${image.filename}`)).status, 404);
    imageForm.set('placement', 'landing');
    const landingUpload = await fetch(`${base}/admin/lectures/${item.id}/images`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: imageForm });
    assert.equal(landingUpload.status, 303);
    const landingImage = db.prepare("SELECT * FROM lecture_images WHERE lecture_id=? AND placement='landing'").get(item.id);
    assert.ok(landingImage);
    const landingPage = await (await fetch(`${base}/lectures/${item.id}`)).text();
    assert.match(landingPage, /class="lecture-landing-only"/);
    assert.match(landingPage, new RegExp(landingImage.filename.replace('.', '\\.')));
    assert.doesNotMatch(landingPage, /lecture-page-cover|lecture-page-aside|강의 소개|두 번째 &lt;안전한&gt; 문단/);
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

    const active = db.prepare('SELECT id FROM lectures WHERE published=1 LIMIT 1').get();
    const applicant = new URLSearchParams({ lecture_id: String(active.id), name: '홍길동', phone_prefix: '010', phone_middle: '1234', phone_last: '5678', gender: '응답하지 않음', age_range: '36~40세', session_preference: '오전 시간대', referral_source: '인스타그램', consent: 'yes', utm_source: 'instagram', utm_medium: 'paid_social', utm_campaign: 'october-class' });
    const registration = await fetch(`${base}/registrations`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: applicant });
    assert.equal(registration.status, 303);
    assert.equal(db.prepare('SELECT utm_source FROM registrations LIMIT 1').get().utm_source, 'instagram');
    const duplicate = await fetch(`${base}/registrations`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: applicant });
    assert.equal(duplicate.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 1);
    assert.equal((await fetch(`${base}/admin/registrations.csv`, { redirect: 'manual' })).status, 303);
    const csv = await fetch(`${base}/admin/registrations.csv`, { headers: { Cookie: cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /registrations\.csv/);
    assert.match(await csv.text(), /october-class/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const registered = db.prepare('SELECT * FROM registrations LIMIT 1').get();
    assert.equal(registered.status, '접수');
    assert.ok(registered.consent_at);
    assert.equal(registered.consent_version, '2026-10-09-v1');
    const adminHeaders = { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' };
    const updateApplicant = async fields => fetch(`${base}/admin/registrations/update`, { method: 'POST', redirect: 'manual', headers: adminHeaders, body: new URLSearchParams({ csrf, id: String(registered.id), ...fields }) });
    assert.equal((await updateApplicant({ status: '안내 완료', notes: '문자 안내 완료', csrf: 'bad' })).status, 403);
    assert.equal((await updateApplicant({ status: '임의 상태' })).status, 400);
    assert.equal((await updateApplicant({ status: '안내 완료', notes: '문자 안내 완료' })).status, 303);
    assert.equal(db.prepare('SELECT status FROM registrations LIMIT 1').get().status, '안내 완료');
    const found = await fetch(`${base}/admin/registrations?q=홍길동&status=${encodeURIComponent('안내 완료')}`, { headers: { Cookie: cookie } });
    assert.equal(found.headers.get('cache-control'), 'no-store');
    assert.match(await found.text(), /홍길동/);
    const filteredCsv = await fetch(`${base}/admin/registrations.csv?status=${encodeURIComponent('취소')}`, { headers: { Cookie: cookie } });
    assert.doesNotMatch(await filteredCsv.text(), /홍길동/);
    assert.equal((await fetch(`${base}/admin/backup`, { method: 'POST', redirect: 'manual', headers: adminHeaders, body: new URLSearchParams({ csrf: 'bad' }) })).status, 403);
    const backup = await fetch(`${base}/admin/backup`, { method: 'POST', headers: adminHeaders, body: new URLSearchParams({ csrf }) });
    assert.equal(backup.status, 200);
    const archive = path.join(dir, 'test-backup.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await backup.arrayBuffer()));
    const restoredDir = path.join(dir, 'restored');
    fs.mkdirSync(restoredDir);
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', restoredDir], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const restored = new DatabaseSync(path.join(restoredDir, 'site.sqlite'), { readOnly: true });
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare('SELECT status FROM registrations LIMIT 1').get().status, '안내 완료');
    restored.close();
    assert.equal((await fetch(`${base}/admin/registrations/delete`, { method: 'POST', redirect: 'manual', headers: adminHeaders, body: new URLSearchParams({ csrf, id: String(registered.id) }) })).status, 303);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
