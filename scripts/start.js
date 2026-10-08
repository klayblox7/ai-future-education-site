const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
if (!fs.existsSync(path.join(dataDir, 'site.sqlite')) && fs.existsSync(path.join(root, 'seed', 'public-content.json'))) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'import-public-seed.js')], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
const { server } = require('../server');
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`AI 미래교육원: http://localhost:${port}`));
