const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const seedDir = path.join(root, 'seed');
const uploadDir = path.join(seedDir, 'uploads');
const db = new DatabaseSync(path.join(dataDir, 'site.sqlite'), { readOnly: true });

const lectures = db.prepare('SELECT id,title,topic,summary,detail_body,audience,start_at,region,location,format,price_label,landing_url,published FROM lectures WHERE published=1 ORDER BY id').all();
const images = db.prepare('SELECT lecture_images.lecture_id,lecture_images.filename,lecture_images.caption,lecture_images.placement FROM lecture_images JOIN lectures ON lectures.id=lecture_images.lecture_id WHERE lectures.published=1 ORDER BY lecture_images.id').all();
const instructors = db.prepare('SELECT name,role,bio,photo_url,published FROM instructors WHERE published=1 ORDER BY id').all();
const reviews = db.prepare('SELECT title,body,image_path,image_alt,sort_order,published FROM reviews WHERE published=1 ORDER BY sort_order,id').all();
db.close();

fs.mkdirSync(uploadDir, { recursive: true });
for (const image of images) {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(image.filename)) throw new Error('Unexpected image filename');
  fs.copyFileSync(path.join(dataDir, 'uploads', image.filename), path.join(uploadDir, image.filename));
}
for (const review of reviews) {
  if (!review.image_path.startsWith('/uploads/')) continue;
  const filename = review.image_path.slice('/uploads/'.length);
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(filename)) throw new Error('Unexpected review image filename');
  fs.copyFileSync(path.join(dataDir, 'uploads', filename), path.join(uploadDir, filename));
}
fs.writeFileSync(path.join(seedDir, 'public-content.json'), JSON.stringify({ lectures, images, instructors, reviews }, null, 2) + '\n');
console.log(`Exported ${lectures.length} published lectures, ${reviews.length} reviews and ${images.length} lecture images. No inquiries or admin credentials included.`);
