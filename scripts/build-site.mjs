import { readFileSync, copyFileSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../', import.meta.url))),
  out = join(root, 'dist');
if (existsSync(out) && !existsSync(join(out, 'fh3-local-map.json')))
  throw new Error('dist 已存在且不是本项目的构建输出，请另选目录。');
const context = { window: {} };
runInNewContext(readFileSync(join(root, 'maps.js'), 'utf8'), context);
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(join(out, 'assets'), { recursive: true });
for (const name of [
  'index.html',
  'style.css',
  'app.js',
  'progress.js',
  'tiles.js',
  'data.js',
  'maps.js',
  'fh3-local-map.json',
])
  copyFileSync(join(root, name), join(out, name));
copyFileSync(join(root, 'assets/favicon.svg'), join(out, 'assets/favicon.svg'));
for (const config of Object.values(context.window.FH3_MAPS)) {
  const target = join(out, config.tiles.base);
  mkdirSync(resolve(target, '..'), { recursive: true });
  cpSync(join(root, config.tiles.base), target, { recursive: true });
}
copyFileSync(join(root, 'source/hosting-headers.txt'), join(out, '_headers'));
console.log('静态部署目录：' + out);
console.log('仅包含页面和当前版本瓦片；原始 PNG、配准资料和验证截图不在部署包中。');
