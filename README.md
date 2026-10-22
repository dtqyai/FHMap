# Forza Horizon 3 Interactive Map

《极限竞速：地平线 3》本地收集地图，包含澳洲大陆 183 个点位、暴风雪山 26 个点位、风火轮 26 个点位。

点击点位切换收集状态，支持按类型和状态筛选、拖动缩放、进度导入/导出。进度保存在浏览器 localStorage，无需账号或后端。

## 本地运行

在项目目录运行：

```sh
python3 -m http.server 8763 --bind 127.0.0.1
```

然后打开 <http://127.0.0.1:8763/>。Windows 也可使用 `py -m http.server 8763 --bind 127.0.0.1`。

可以直接打开 `index.html`，但不同浏览器对 file:// 存储的处理不同，推荐固定使用本地 HTTP 地址。相同浏览器、相同地址下的多个标签页同步标记；不同浏览器、域名或端口的进度独立，迁移时使用 JSON 备份。清除浏览器数据前请导出进度。

键盘：方向键平移，`+` / `-` 缩放，`0` 适应当前区域，`Esc` 关闭筛选面板。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `index.html`、`style.css`、`app.js` | 页面与交互，无第三方运行依赖 |
| `data.js`、`maps.js` | 原站点位及高清地图配置 |
| `assets/maps/` | 360 块运行所需的多级 WebP 瓦片，约 19.3 MB |
| `assets/favicon.svg` | 页面图标 |
| `source/` | 点位提取记录、配准结果、构建统计与缓存配置 |
| `source/reference/` | 核对来源所用的旧底图与原站样式，不被页面加载 |
| `scripts/` | 数据校验、瓦片生成、静态包构建 |

以下目录由 `.gitignore` 排除：

- `source/originals/`：三张原始高清 PNG，合计约 239 MB，仅本地保留。
- `dist/`：构建输出，避免重复提交瓦片。
- `verification/`：本地验证截图、备份样本及历史记录。
- 除根目录 `README.md` 之外的 Markdown 文档、本地启动器、环境文件、缓存、日志和系统文件。

克隆仓库后即可运行和构建，无需三张原始 PNG。

## 校验与构建

需要 Node.js 22 或更高版本，无需安装 npm 依赖：

```sh
node --check app.js
node scripts/verify-data.mjs
node scripts/build-site.mjs
```

GitHub Actions 在推送和拉取请求时执行语法检查、点位/瓦片校验和静态包构建。

部署时只上传 **dist/** 的内容。构建不包含原始 PNG、来源记录、旧底图或截图。`dist/_headers` 提供带哈希瓦片的长期缓存及页面/脚本重新验证配置，需托管平台支持或配置等效响应头。

页面先加载小预览，再按视口和缩放加载 512 像素 WebP 瓦片，最多四个瓦片并发请求。离屏请求会取消，缓存约 96 块；不会一次下载全部地图，也不请求原始 PNG。图片负载随视口、像素比和缩放变化。

## 重新生成瓦片

仅更换底图或调整瓦片编码时需要此步骤。将以下文件放入本地 `source/originals/`：

- `Australia.png`
- `Blizzard Mountain.png`
- `Hot Wheels Thrilltopia.png`

安装 Python 的 Pillow 后运行：

```sh
python3 scripts/build-tiles.py
node scripts/verify-data.mjs --source-images
node scripts/build-site.mjs
```

`--source-images` 要求三张 PNG 均存在并校验尺寸；普通校验在没有原图时仍会校验点位、配准参数和全部瓦片。本地原图不上传，`maps.js` 和生成的 WebP 瓦片需要提交。

## 数据与图片来源

点位来自 [KudosPrime FH3 地图](https://www.kudosprime.com/fh3/gamemap.php)，提取日期为 2026-10-21，保留原站 ID、类别、源坐标和提示。原站没有 #145，实际为 235 个点位；未逐点进入游戏核验。

底图来自 [The Spriters Resource 的 Forza Horizon 3 页面](https://www.spriters-resource.com/xbox_one/forzahorizon3/)，使用用户提供的三张高清 PNG；Australia 图署名为 Trekeln。暴风雪山高清瓦片保留最初地图的朝向，点位使用同一参考坐标系；原始 PNG 保持不变。Forza Horizon 为 Microsoft 的商标。
