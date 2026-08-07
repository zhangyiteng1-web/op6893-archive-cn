# OP6893 中文归档

这是一个中文静态站点模板，用来展示 `RMX3031 Archive` 的公开刷机资源数据。站点本身不保存刷机文件，下载链接仍指向上游归档地址。

支持设备按原站说明展示为 OP6893 家族：Realme X7 Max、Realme GT Neo、Realme GT Neo Flash、OnePlus Nord 2。上游 JSON 的 `device` 字段目前只写了 `Realme X7 Max`，页面不会直接用它作为唯一支持设备。

## 功能

- 科技感中文首页、同步终端面板、最新收录、全部资源列表
- 分类顺序跟随原站：ROM、内核、模块、X7 Max、GT Neo、GT Neo Flash、固件、SP 工具、Recovery、其他
- 支持按原站分类快速筛选
- 支持按名称、版本、Android 版本和更新日志搜索
- 自动同步上游公开数据
- 可部署到 Cloudflare Pages、GitHub Pages、Vercel、Netlify 等静态托管平台

## 数据同步方式

前端运行时会按顺序读取：

1. `https://rmx3031-archive.pages.dev/index.json`
2. `https://raw.githubusercontent.com/xCaptaiN09/rmx3031-archive/main/public/index.json`

优先读取原站部署后的 JSON。如果原站临时不可访问，会回退到 GitHub Raw。因为数据是在浏览器端实时读取，所以只要上游 JSON 更新，中文站刷新后就会同步显示最新内容。

## 本地开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

构建产物会输出到 `dist` 目录。

## Cloudflare Pages 部署

1. 把这个项目推送到你的 GitHub 仓库。
2. 打开 Cloudflare Pages，选择连接 GitHub 仓库。
3. 构建命令填写：

```bash
npm run build
```

4. 输出目录填写：

```bash
dist
```

5. 部署完成后即可访问 Cloudflare Pages 分配的域名。

## 说明

上游项目为 `xCaptaiN09/rmx3031-archive`。请保留页面中的上游项目链接和风险提示。刷机文件的版权、可用性和风险请以原作者说明为准。
