const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

function backupData(dataDir, outputDir, liveDb) {
  fs.mkdirSync(outputDir, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-future-backup-'));
  const filename = `site-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${require('node:crypto').randomBytes(3).toString('hex')}.tar.gz`;
  const archive = path.resolve(outputDir, filename);
  let db = liveDb;
  try {
    if (!db) db = new DatabaseSync(path.join(dataDir, 'site.sqlite'), { readOnly: true });
    // SQLite creates a consistent snapshot including committed WAL contents.
    db.prepare('VACUUM INTO ?').run(path.join(temp, 'site.sqlite'));
    fs.mkdirSync(path.join(temp, 'uploads'));
    const uploads = path.join(dataDir, 'uploads');
    if (fs.existsSync(uploads)) for (const file of fs.readdirSync(uploads)) {
      if (/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(file)) fs.copyFileSync(path.join(uploads, file), path.join(temp, 'uploads', file));
    }
    fs.writeFileSync(path.join(temp, 'BACKUP.txt'), `AI Future Education\nCreated: ${new Date().toISOString()}\nContains personal data. Keep private.\nStop the application before restoring site.sqlite and uploads.\n`);
    const result = spawnSync('tar', ['-czf', archive, '-C', temp, 'site.sqlite', 'uploads', 'BACKUP.txt'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('백업 압축 실패: tar 명령을 확인하세요.');
    return archive;
  } catch (error) {
    fs.rmSync(archive, { force: true });
    throw error;
  } finally {
    if (!liveDb && db) db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  console.log(backupData(dataDir, path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'))));
}
module.exports = { backupData };
