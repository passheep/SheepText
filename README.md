# SheepText

SheepText 是一款面向日常 AI 使用场景的 Windows 桌面文本工作台。它以轻量编辑为核心，提供 AI 文本增强、即时渲染 Markdown、多窗口草稿、历史检索、贴边收起和托盘驻留等能力。

当前版本：`0.2.7`

## 主要能力

- CodeMirror 文本编辑器，支持中文输入、顶部查找替换、撤销重做、自动换行、选区处理、行号和 `Ctrl + 鼠标滚轮` 调整字号。
- TXT 与 Markdown 共用同一份原始文本，支持源码、分栏和预览三种 Markdown 编辑方式。
- Markdown “预览”采用单栏即时渲染：非光标行隐藏 Markdown 标记并显示排版效果，光标所在行恢复源码，最终仍保存为纯 Markdown；选中文字会显示浮动格式工具栏，支持粗体、斜体、删除线、行内代码和链接。
- Markdown 分栏支持拖动调整左右宽度、双栏同步滚动；窗口过窄时会自动切回源码并禁用分栏。
- Markdown 支持直接粘贴剪贴板图片。图片按文稿复制到应用数据目录并使用随机文件名，另存为 Markdown 时会同步导出资源目录和相对路径。
- 通用、编程、生图三种 AI 场景，以及保守增强、创意重写两种模式。
- 支持 DeepSeek、OpenAI 和 OpenAI 兼容服务，可维护多套模型配置。
- SQLite 自动保存、全文历史搜索、每批 30 条游标分页和多窗口工作区恢复。
- 提供主题色、浅色/深色界面、纯白/纯黑/护眼绿/纸张/牛皮纸编辑背景，以及方格、横线、波浪线等纹理。
- 无边框现代化界面，统一按钮、图标、Select、输入框、开关、状态标签、Toast 和弹层风格。
- 置顶、四侧贴边收起、托盘驻留、任务栏按钮控制、开机自启、TXT/Markdown 文件导入与另存为。
- 支持 `Ctrl + N` 新建文稿、`Ctrl + Shift + N` 新建窗口、`Ctrl + F` 编辑区搜索。

## 环境要求

- Windows 10/11 x64
- Node.js 24
- npm 11

## 开发与验证

```powershell
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

## 打包安装程序

```powershell
npm run package
```

安装包和免安装目录生成在 `release/delivery`。安装程序文件名格式为 `SheepText_<版本>_x64-setup.exe`。

## 本地数据与安全

- 草稿、窗口状态、模型公开配置和应用设置保存在 Electron `app.getPath('userData')/data/sheeptext.db`。
- Markdown 粘贴图片保存在 `app.getPath('userData')/data/images/<文稿ID>/`，删除文稿时会同步删除其图片目录。
- SQLite 使用 WAL、`synchronous=NORMAL` 和 5 秒 busy timeout；正文编辑后自动保存，正常关闭或退出前会再次刷新保存。
- 当前历史检索使用 SQLite `LIKE` 搜索。日常数量的文稿不会有明显压力；若未来达到数千篇超长文稿，可进一步升级为 SQLite FTS5 全文索引。
- API Key 通过 Electron `safeStorage` 使用当前 Windows 用户的系统加密能力保存，渲染进程不会读取已保存的明文 Key。
- Markdown 内容会清理危险 HTML；本地图片仅通过 SheepText 私有资源协议读取，远程图片保持阻止，外部 HTTP/HTTPS 链接由系统默认浏览器打开。
- 数据备份会同时复制数据库和 Markdown 图片目录；存储占用统计包含整个 `data` 目录。

## 发布说明

当前安装包未使用可信发行商证书进行代码签名，因此 Windows 可能显示“未知发布者”或 SmartScreen 提示。请从可信位置获取并核对文件哈希。
