# Forza Horizon Interactive Map

支持 Forza Horizon 2 和 Forza Horizon 3，通过作品选项卡切换，默认打开 FH3。

| 作品 | 区域 | 点位 |
| --- | --- | ---: |
| Forza Horizon 2 | 法国与意大利 | 240 |
| Forza Horizon 2 | 风暴岛 | 26 |
| Forza Horizon 3 | 澳洲大陆 | 183 |
| Forza Horizon 3 | 暴风雪山 | 26 |
| Forza Horizon 3 | 风火轮 | 26 |

FH2 法国与意大利包含 50 块快速移动广告牌、100 块 XP 广告牌、10 处车房宝物、30 处测速照相、15 处测速区间，以及《速度与激情》的 20 块奖励广告牌、10 处测速照相、5 处测速区间。风暴岛目前收录 25 块奖励广告牌和 1 处车房宝物。

各点位独立显示，点击点位直接切换收集状态。支持按类型和状态筛选、拖动缩放、进度导入/导出。进度保存在浏览器 localStorage，无需账号或后端。两部作品的标记和 JSON 备份相互独立，导入时会校验作品；原有 FH3 进度和版本 1 备份继续兼容。

## 本地运行

在项目目录运行：

```sh
python3 -m http.server 8763 --bind 127.0.0.1
```

然后打开 <http://127.0.0.1:8763/>。Windows 也可使用 `py -m http.server 8763 --bind 127.0.0.1`。

可以直接打开 `index.html`，但不同浏览器对 file:// 存储的处理不同，推荐固定使用本地 HTTP 地址。相同浏览器、相同地址下的多个标签页同步标记，批量变更合并刷新；不同浏览器、域名或端口的进度独立，迁移时使用 JSON 备份。清除浏览器数据前请导出进度。

地图获得焦点时可使用键盘：方向键平移，`+` / `-` 缩放，`0` 适应当前区域，`Esc` 关闭筛选面板。Tab 切换标记时地图自动平移至焦点位置；触屏标记提供 44 像素点击区域，重叠区域按触点最近的标记选择。

导出窗口会同步最新进度，下载时再次读取浏览器存储。导入撤销通过修订号保留其他标签页的后续修改，包括取消后重新收集同一点位的情况；原有进度键及版本 1 JSON 备份继续兼容。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `index.html`、`style.css`、`app.js` | 页面、筛选与地图交互，无第三方运行依赖 |
| `tiles.js`、`progress.js` | 瓦片加载/恢复与进度事务/回滚 |
| `tests/` | 存储单元测试与浏览器回归测试 |
| `data.js`、`maps.js`、`data-fh2.js`、`maps-fh2.js`、`games.js` | 点位、高清地图配置及作品列表 |
| `assets/maps/` | 574 块运行所需的多级 WebP 瓦片，约 31.1 MB |
| `assets/favicon.svg` | 页面图标 |
| `source/` | 点位提取记录、配准结果、构建统计与缓存配置 |
| `source/reference/` | 核对来源所用的旧底图与原站样式，不被页面加载 |
| `scripts/` | 数据校验、瓦片生成、静态包构建 |
| `wrangler.jsonc` | Cloudflare Worker 名称与静态资源目录 |

以下目录由 `.gitignore` 排除：

- `source/originals/`：五张原始高清 PNG，仅本地保留；保存的 KudosPrime 网页及资源文件夹也留在此处。
- `dist/`：构建输出，避免重复提交瓦片。
- `verification/`：本地验证截图、备份样本及历史记录。
- 除根目录 `README.md` 之外的 Markdown 文档、本地启动器、环境文件、缓存、日志和系统文件。

克隆仓库后即可运行和构建，无需原始 PNG 或保存的网页。

## 校验与构建

需要 Node.js 22 或更高版本，无需安装 npm 依赖：

```sh
node --check app.js
node scripts/verify-data.mjs
node scripts/build-site.mjs
```

开发与 CI 使用固定版本的开发依赖；正式页面无需 npm 依赖：

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run format:check
```

浏览器测试运行构建后的 `dist/`，覆盖加载失败后的自动/手动/联网恢复、标记独立显示、拖动与点击、快捷键、备份下载、导入/替换/撤销、存储失败回滚、跨标签页同步和批量刷新、键盘焦点导航、请求挂起超时、手机触摸命中及宽窄屏切换。FH2 测试还覆盖作品切换、相同编号的进度隔离、跨作品备份校验、FH3 图标复用及未选地图不加载。截图写入本地 `verification/`。

GitHub Actions 在推送和拉取请求时执行格式、语法、数据校验、存储测试、静态包构建和浏览器回归测试。

部署时只上传 **dist/** 的内容。构建不包含原始 PNG、来源记录、旧底图或截图。`dist/_headers` 提供带哈希瓦片的长期缓存及页面/脚本重新验证配置，需托管平台支持或配置等效响应头。

页面先加载小预览，再按视口和缩放加载 512 像素 WebP 瓦片，最多四个瓦片并发请求。离屏请求会取消，缓存约 96 块；预览图和瓦片每次加载最多等待 10 秒，超时会释放请求位置；临时失败最多自动重试两次，也可点击“重试”恢复；不会一次下载全部地图，也不请求原始 PNG。图片负载随视口、像素比和缩放变化。

## Cloudflare Workers

仓库包含 `wrangler.jsonc`，Worker 名称为 `fhmap`，仅发布 `dist/`。Cloudflare 控制台的构建设置为：

| 配置 | 值 |
| --- | --- |
| Git 仓库 | `dtqyai/FHMap` |
| 生产分支 | `main` |
| 构建命令 | `node scripts/build-site.mjs` |
| 部署命令 | `npx wrangler deploy` |
| 预览命令 | `npx wrangler preview` |
| 根目录 | `/` |
| 构建监视包括路径 | `*` |

GitHub 的 `Validate map` 只负责校验和构建，不会自行发布到 Cloudflare。原 Worker 已删除；仓库保留此配置供之后重新创建，当前没有执行生产部署。重新接入 Cloudflare Git 集成后，才会由 Cloudflare 触发自动发布。

## 重新生成瓦片

仅更换底图或调整瓦片编码时需要此步骤。将以下文件放入本地 `source/originals/`：

- `Australia.png`
- `Blizzard Mountain.png`
- `Hot Wheels Thrilltopia.png`
- `France & Italy.png`
- `Storm Island.png`

安装 Python 的 Pillow 后运行：

```sh
python3 scripts/build-tiles.py  # FH3
python3 scripts/build-fh2.py    # FH2
node scripts/verify-data.mjs --source-images
node scripts/build-site.mjs
```

`--source-images` 要求五张 PNG 均存在并校验尺寸；普通校验在没有原图时仍会校验点位、配准参数和全部瓦片。本地原图不上传，`maps.js`、`maps-fh2.js`、`data-fh2.js` 和生成的 WebP 瓦片需要提交。FH2 脚本使用 `source/fh2-extracted-points.json`、`source/fh2-storm-points.json` 和已记录的配准矩阵，不需要重新访问来源网站。

## 数据与图片来源

FH3 点位来自 [KudosPrime FH3 地图](https://www.kudosprime.com/fh3/gamemap.php)，提取日期为 2026-10-21，保留原站 ID、类别、源坐标和提示。原站没有 #145，实际为 235 个点位；未逐点进入游戏核验。

FH3 底图来自 [The Spriters Resource 的 Forza Horizon 3 页面](https://www.spriters-resource.com/xbox_one/forzahorizon3/)，使用用户提供的三张高清 PNG；Australia 图署名为 Trekeln。暴风雪山高清瓦片保留最初地图的朝向，点位使用同一参考坐标系；原始 PNG 保持不变。Forza Horizon 为 Microsoft 的商标。

FH2 法国与意大利点位来自 [KudosPrime Xbox One 地图](https://www.kudosprime.com/fh2xo/gamemap.php)，提取日期为 2026-11-03。读取用户保存的完整网页，保留全部 240 个点位的原站 ID、类别和图标中心坐标，包含《速度与激情》的 35 个点位。只提交必要的点位记录，不上传保存的网页、广告脚本或用户属性。FH2 复用 FH3 的 SVG 及文字标记样式，筛选列表和地图使用相同图标，不使用 KudosPrime 的位图图标。

KudosPrime 保存页没有风暴岛点位。风暴岛奖励广告牌坐标从 [Maka91 的完整点位图（XboxAchievements 托管）](https://www.xboxachievements.com/game/forza-horizon-2-xbox-one/guide/)中的 25 个蓝色标记中心提取；车房位置取自 [Classy Tech Calibrations 的攻略视频末尾](https://www.youtube.com/watch?v=Oug_58zd9dM&t=54)。参考图片、取点方式及配准结果保存在 `source/reference/fh2-*`、`source/fh2-storm-points.json` 和 `source/fh2-map-calibration.json`。风暴岛编号从 10001 起，属于本项目编号。

FH2 底图使用用户提供的 `France & Italy.png`、`Storm Island.png`，保持原图朝向。通过地形特征配准至来源点位坐标，法国与意大利、风暴岛分别有 5485、4395 个配准内点，95% 残差分别约为高清原图的 2.1、2.7 像素。坐标来自公开地图及视频画面，未逐点进入游戏核验。
