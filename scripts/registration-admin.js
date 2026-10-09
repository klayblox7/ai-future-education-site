const statuses = ['접수', '안내 완료', '참석', '취소'];

function createRegistrationAdmin({ db, e, adminShell, csrfField, csvCell }) {
  function query(params) {
    const search = String(params.get('q') || '').trim().slice(0, 100);
    const lectureId = Number(params.get('lecture_id')) || 0;
    const status = statuses.includes(params.get('status')) ? params.get('status') : '';
    const where = [], values = [];
    if (search) { where.push('(instr(r.name, ?) > 0 OR instr(r.contact, ?) > 0)'); values.push(search, search.replace(/\D/g, '') || search); }
    if (lectureId) { where.push('r.lecture_id=?'); values.push(lectureId); }
    if (status) { where.push('r.status=?'); values.push(status); }
    const sql = `FROM registrations r LEFT JOIN lectures l ON l.id=r.lecture_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    return { search, lectureId, status, sql, values };
  }
  function render(params, session) {
    const filter = query(params);
    const count = db.prepare(`SELECT COUNT(*) AS n ${filter.sql}`).get(...filter.values).n;
    const page = Math.min(Math.max(1, Number(params.get('page')) || 1), Math.max(1, Math.ceil(count / 30)));
    const items = db.prepare(`SELECT r.*, l.title AS lecture_title ${filter.sql} ORDER BY r.id DESC LIMIT 30 OFFSET ?`).all(...filter.values, (page - 1) * 30);
    const lectures = db.prepare('SELECT id,title FROM lectures ORDER BY start_at DESC').all();
    const link = (targetPage) => { const p = new URLSearchParams(params); p.set('page', String(targetPage)); return '/admin/registrations?' + p; };
    const totals = db.prepare('SELECT status,COUNT(*) AS n FROM registrations GROUP BY status').all();
    return adminShell('강의 신청', `<p><a class="admin-primary" href="/admin/backup">데이터 백업</a></p><div class="admin-stats">${statuses.map(status => `<div><strong>${totals.find(x => x.status === status)?.n || 0}</strong><span>${e(status)}</span></div>`).join('')}</div>
      <form class="registration-filters" method="get" action="/admin/registrations"><label>이름·연락처<input name="q" value="${e(filter.search)}" placeholder="이름 또는 전화번호"></label><label>강의<select name="lecture_id"><option value="">전체 강의</option>${lectures.map(x => `<option value="${x.id}" ${x.id === filter.lectureId ? 'selected' : ''}>${e(x.title)}</option>`).join('')}</select></label><label>상태<select name="status"><option value="">전체 상태</option>${statuses.map(x => `<option ${x === filter.status ? 'selected' : ''}>${e(x)}</option>`).join('')}</select></label><button class="admin-primary">조회</button></form>
      <div class="admin-section-title"><p>조회 결과 ${count}건 · ${page}페이지</p><a class="admin-primary" href="/admin/registrations.csv?${e(new URLSearchParams(params).toString())}">조회 결과 CSV 내려받기</a></div>
      <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>접수일</th><th>강의</th><th>신청자</th><th>연락처</th><th>성별·연령</th><th>시간대</th><th>광고 유입</th><th>처리</th></tr></thead><tbody>${items.length ? items.map(x => `<tr><td>${e(x.created_at)}</td><td>${e(x.lecture_title || '삭제된 강의')}</td><td><strong>${e(x.name)}</strong></td><td><a href="tel:${e(x.contact)}">${e(x.contact.replace(/^(01\d)(\d{3,4})(\d{4})$/, '$1-$2-$3'))}</a></td><td>${e(x.gender)} · ${e(x.age_range)}</td><td>${e(x.session_preference)}</td><td>${e(x.referral_source)}<small>${e([x.utm_source,x.utm_campaign].filter(Boolean).join(' / ') || '-')}</small></td><td><form method="post" action="/admin/registrations/update" class="registration-management">${csrfField(session)}<input type="hidden" name="id" value="${x.id}"><label>상태<select name="status">${statuses.map(s => `<option ${s === x.status ? 'selected' : ''}>${e(s)}</option>`).join('')}</select></label><label>운영 메모<textarea name="notes" maxlength="1000" rows="2">${e(x.notes)}</textarea></label><button class="admin-primary">저장</button></form><form method="post" action="/admin/registrations/delete" data-confirm="이 신청자의 개인정보를 영구 삭제할까요?">${csrfField(session)}<input type="hidden" name="id" value="${x.id}"><button class="delete-button">개인정보 삭제</button></form></td></tr>`).join('') : '<tr><td colspan="8" class="table-empty">조회된 신청이 없습니다.</td></tr>'}</tbody></table></div>
      <div class="registration-pagination">${page > 1 ? `<a href="${e(link(page - 1))}">← 이전</a>` : ''}${page * 30 < count ? `<a href="${e(link(page + 1))}">다음 →</a>` : ''}</div>`);
  }
  function csv(params) {
    const filter = query(params);
    const columns = ['id','created_at','lecture_id','lecture_title','name','contact','gender','age_range','session_preference','referral_source','status','notes','consent_at','consent_version','utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
    const rows = db.prepare(`SELECT r.*, l.title AS lecture_title ${filter.sql} ORDER BY r.id DESC`).all(...filter.values);
    return '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\r\n') + '\r\n';
  }
  return { render, csv, statuses };
}
module.exports = { createRegistrationAdmin };
