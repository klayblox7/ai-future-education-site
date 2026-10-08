const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../server');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const seedDir = path.join(root, 'seed');
const seed = JSON.parse(fs.readFileSync(path.join(seedDir, 'public-content.json'), 'utf8'));
if (db.prepare('SELECT COUNT(*) AS n FROM lectures').get().n) {
  console.error('Import stopped: the database already has lectures.');
  process.exitCode = 1;
} else {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  db.exec('BEGIN');
  try {
    const lectureInsert = db.prepare('INSERT INTO lectures(id,title,topic,summary,detail_body,audience,start_at,region,location,format,price_label,landing_url,published) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const imageInsert = db.prepare('INSERT INTO lecture_images(lecture_id,filename,caption,placement) VALUES(?,?,?,?)');
    const instructorInsert = db.prepare('INSERT INTO instructors(name,role,bio,photo_url,published) VALUES(?,?,?,?,?)');
    const reviewInsert = db.prepare('INSERT INTO reviews(title,body,image_path,image_alt,sort_order,published) VALUES(?,?,?,?,?,?)');
    for (const x of seed.lectures) lectureInsert.run(x.id,x.title,x.topic,x.summary,x.detail_body,x.audience,x.start_at,x.region,x.location,x.format,x.price_label,x.landing_url,1);
    for (const x of seed.images) {
      if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(x.filename)) throw new Error('Unexpected image filename');
      fs.copyFileSync(path.join(seedDir, 'uploads', x.filename), path.join(dataDir, 'uploads', x.filename));
      imageInsert.run(x.lecture_id,x.filename,x.caption,x.placement);
    }
    for (const x of seed.instructors) instructorInsert.run(x.name,x.role,x.bio,x.photo_url,1);
    if (Array.isArray(seed.reviews)) {
      db.prepare('DELETE FROM reviews').run();
      for (const x of seed.reviews) {
        if (/^\/uploads\//.test(x.image_path)) {
          const filename = x.image_path.slice('/uploads/'.length);
          if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(filename)) throw new Error('Unexpected review image filename');
          fs.copyFileSync(path.join(seedDir, 'uploads', filename), path.join(dataDir, 'uploads', filename));
        } else if (!/^\/assets\/[a-z0-9-]+\.(jpg|png|webp)$/.test(x.image_path)) throw new Error('Unexpected review image path');
        reviewInsert.run(x.title,x.body,x.image_path,x.image_alt,x.sort_order,1);
      }
    }
    db.exec('COMMIT');
    console.log(`Imported ${seed.lectures.length} lectures and ${seed.images.length} images.`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
db.close();
