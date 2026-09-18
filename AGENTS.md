# SheepText 项目协作说明

> 本文件适用于本仓库根目录及所有子目录。按 20260917 需求轮次核对当前工作区；历史提交和安装包记录不代表未提交代码的验证状态。

## 1. 项目范围

- 正式项目：`C:\000Program\SheepText\代码\SheepText`
- 废弃项目：`C:\000Program\SheepText\代码\SheepText-obsolete`，不要参考、修改或复制其中的代码。
- 本地 Milkdown 源码参考：`C:\000Program\milkdown`。
- 产品定位：Windows 桌面 AI 文本工作台，UI 质量和交互一致性优先级很高。
- 修改时保持按钮、图标、Select、输入框、开关、弹层、Toast、滚动条等组件的视觉语言一致，并检查窄窗口和不同高度下的布局。

## 2. 技术栈

- Electron 43 + electron-vite 5
- Vue 3 + TypeScript
- CodeMirror 6
- Milkdown/Crepe 7.22.1
- SQLite 数据存储
- electron-builder + NSIS 安装包
- Lucide Vue 图标

当前版本：`0.3.0`。

## 3. 编辑器架构

当前不是模拟 Milkdown，而是已经真实安装和使用：

- TXT：`TextEditor.vue`，使用 CodeMirror。
- Markdown：`MilkdownEditor.vue`，直接使用真正的 Milkdown/Crepe 所见即所得编辑器。
- 当前 `App.vue` 已不提供 Markdown 源码、分栏、预览子模式切换；相关旧组件、分支和 CSS 残留不代表可用入口。
- 当前工作区及用户最新要求优先于早期需求文档。本轮待开发清单见 [20260917-编辑体验与窗口恢复需求](../../文档/20260917-编辑体验与窗口恢复需求.md)。

Milkdown 已经接入：

- Slash 菜单和块拖动
- 选区格式工具栏
- 标题、引用、列表、任务列表、链接、表格、代码块、公式和图片
- 纯 Markdown 序列化和自动保存
- 撤销、重做
- Ctrl + 鼠标滚轮调整字号
- 输入光标距底部约 8 行的安全距离
- 行号开关（Milkdown 中按可编辑内容块对齐；用户已要求移除，尚待开发）
- SheepText 风格的 Ctrl+F 查找替换浮层
- 粘贴图片复制到当前文稿的独立资源目录

### 重要的选区坐标约束

- CodeMirror 的 `from/to` 是原始 Markdown/TXT 字符偏移。
- Milkdown 的 `from/to` 是 ProseMirror 文档树位置，不能用于 `draft.content.slice(from, to)`。
- `App.vue` 的 AI 请求快照通过 `editorKind: 'text' | 'milkdown'` 区分两类坐标。
- AI 选区正文应使用编辑器上报的 `selection.text`。
- 在 AI 请求期间切换编辑方式时，不允许把旧编辑器的选区坐标回填到新编辑器。
- 全文 AI 结果通过 `EditorExpose.replaceRange(..., true)` 触发整篇替换；Milkdown 选区结果使用 ProseMirror 范围替换。

## 4. 关键文件

### 渲染进程

- `src/renderer/src/App.vue`：主页面状态、文稿切换、自动保存、AI 请求、编辑器模式切换、窗口交互。
- `src/renderer/src/components/TextEditor.vue`：当前用于 TXT 编辑与 CodeMirror 查找替换，文件内仍有未被主页面使用的 Markdown 相关逻辑。
- `src/renderer/src/components/MilkdownEditor.vue`：Milkdown/Crepe 编辑器、ProseMirror 选区、图片上传、查找替换、字号和滚动逻辑。
- `src/renderer/src/components/MarkdownPreview.vue`：只读 Markdown 渲染组件，当前不再用于主编辑页分栏；变更前检查其他引用。
- `src/renderer/src/components/HistoryDrawer.vue`：文稿历史、虚拟列表和删除确认。
- `src/renderer/src/components/SettingsPanel.vue`：默认设置、外观、桌面行为、模型、存储和关于页面。
- `src/renderer/src/styles.css`：全局样式及历次 UI 覆盖。该文件已有多段后置覆盖，修改前先搜索现有选择器，避免重复或互相覆盖。

### 主进程

- `src/main/data-store.ts`：SQLite、草稿、设置和模型数据。
- `src/main/window-manager.ts`：窗口、任务栏、托盘、置顶和贴边收起。
- `src/main/ipc.ts`：渲染进程 IPC，包括保存文稿、图片、设置和窗口操作。
- `src/main/ai-service.ts`：AI 请求和敏感片段保护。
- `src/shared/types.ts`：主进程、预加载和渲染进程共享类型。

## 5. 数据和图片

- 数据库：Electron `app.getPath('userData')/data/sheeptext.db`。
- 图片：`app.getPath('userData')/data/images/<文稿ID>/`。
- Markdown 粘贴图片必须调用 `window.sheepText.savePastedImage`，不要保存或引用剪贴板原始路径。
- 图片文件名由主进程增加随机字符，避免同名覆盖。
- Markdown 最终必须保存为纯 Markdown 文本，不要把 ProseMirror JSON 作为正式存储格式。

## 6. UI 与交互约定

- UI 要现代、简洁、有设计感，但不要破坏现有 SheepText 视觉体系。
- 优先复用 `BaseButton.vue`、`IconButton.vue`、`BaseSelect.vue`、`ToggleSwitch.vue`。
- 所有新增按钮应同时考虑图标、中文文字、禁用态、Hover、Focus、深色主题和窄窗口。
- 不使用浏览器默认灰色滚动条、原生 `alert` 或 `confirm` 作为最终 UI。
- 弹窗使用页面级 Dialog，不要塞进列表流布局。
- Toast 位于顶部，普通提示约 4.2 秒，错误提示约 7.2 秒。
- 底部左右功能区默认收起，Hover/Focus 时展开；调整样式时同时检查收起图标和内部间距。
- Ctrl+F 查找框必须非模态，不能遮住当前匹配内容，查找和替换输入框宽度保持一致，并保持 `user-select: none`。
- 当前只有 TXT / Markdown 两种入口；窄窗口下保持当前模式，适配浮层和工具区，不恢复旧分栏切换逻辑。

## 7. 图标

用户指定的原始图标来源：

`C:\000Program\SheepText\图片\icon11 (自定义).png`（20260917 更新，原图保持不变）。

使用 `uv run scripts/update-icons.py "C:/000Program/SheepText/图片/icon11 (自定义).png"` 同步多尺寸 ICO、托盘与应用内 PNG；`resources/icon-source.svg` 为历史素材，不作为当前图标来源。

仓库内构建资源：

- `resources/icon.ico`
- `resources/icon.png`
- `resources/tray.png`
- `src/renderer/src/assets/app-icon.png`

修改图标时要同步检查窗口、任务栏、托盘、应用内部和 NSIS 安装包。

## 8. 开发与验证

常用命令：

```powershell
npm install
npm run typecheck
npm run test
npm run build
npm run package
```

完成修改的最低验证要求：

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. 用户要求安装包时必须执行 `npm run package`，并确认实际生成的 EXE、文件大小和 SHA-256。
5. 验证后检查并还原不应提交的 `tsconfig.web.tsbuildinfo` 变化。
6. 执行 `git diff --check` 并检查中文没有乱码。

安装包目录：

`release/delivery`

历史记录的 0.3.0 安装包（未在本轮重新打包核验）：

`C:\000Program\SheepText\代码\SheepText\release\delivery\SheepText_0.3.0_x64-setup.exe`

历史记录的安装包 SHA-256（本轮未重新计算）：

`49D39C2B9ABED7464D2265F8A8957253AB56532F3C08D2BC6D2673DD192140D7`

## 9. Git 交接快照

截至 2026-09-11：

- `main` / `origin/main`：`a575b67 修复底部功能区与预览行号对齐`
- Milkdown 分支：`feature/milkdown-editor`
- Milkdown 提交：`6ded450 接入 Milkdown 即时 Markdown 编辑器`
- `origin/feature/milkdown-editor` 已推送到同一提交。

开始工作前仍要重新执行 `git status --short --branch` 和 `git log -3 --oneline --decorate`，不要只依赖本快照。

## 10. 修改边界

- 不要修改或引用 `SheepText-obsolete`。
- 保留当前 TXT / Markdown 双入口；Markdown 直接使用 Milkdown，不按旧文档擅自恢复源码或分栏入口。
- 不要把 CodeMirror 字符偏移和 ProseMirror 位置混用。
- 不要绕过现有 SQLite、自动保存、历史记录、图片 IPC、设置同步和窗口管理逻辑。
- 不要主动修改用户未要求的接口或数据结构。
- 不要删除文件、清理目录或覆盖不相关改动；如确需删除，先明确目标并征得用户同意。
- 提交前只暂存本次任务相关文件，避免带入其他未提交内容。

## 11. 验证状态

以下为 Milkdown 迁移提交的历史验证记录，不覆盖当前未提交改动：

- TypeScript 类型检查
- Vitest：1 个测试文件、4 个用例
- electron-vite 构建
- electron-builder NSIS 打包

这些是代码和构建验证，不等同于用户实际 UI 验收。后续修改 Milkdown、查找替换、行号、图片或窗口布局时，应重新进行真实桌面环境试用。
