<script setup lang="ts">
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'
import { editorViewCtx, prosePluginsCtx } from '@milkdown/kit/core'
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history'
import { closeHistory } from '@milkdown/prose/history'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { callCommand, getMarkdown, replaceAll, replaceRange as replaceMarkdownRange } from '@milkdown/kit/utils'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ListTree } from '@lucide/vue'
import { stripPasteMarkdown } from '../../../shared/paste-format'
import type { CompletionTriggerKey, ToastPayload } from '../../../shared/types'

const props = defineProps<{
  modelValue: string
  fontSize: number
  draftId: string
  windowId: string
  /** 已解析好的补全模型 ID（补全模型为空时由上层回退到默认模型）；空串表示未配置。 */
  completionModelId: string
  completionEnabled: boolean
  completionAutoEnabled: boolean
  completionTrigger: CompletionTriggerKey
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  selectionChange: [selection: { from: number; to: number; text: string }]
  focusChange: [focused: boolean]
  compositionChange: [composing: boolean]
  fontSizeChange: [size: number]
  scrollChange: [ratio: number]
  toast: [payload: ToastPayload]
  pasted: [range: { from: number; to: number }, text: string]
  pasteInvalidated: []
  outlineHold: [value: boolean]
  completionChange: [state: { active: boolean; preview: string }]
}>()

// ---- AI 行内补全（灰字） ----
// 上下文阈值：文稿不超阈值发全文，否则只发光标附近的文本
const COMPLETION_FULL_DOC_LIMIT = 3000
const COMPLETION_PREFIX_LIMIT = 2000
const COMPLETION_SUFFIX_LIMIT = 500
// 灰字最长字符数；需求定为「一句或一段」，超出容易被模型带偏
const COMPLETION_MAX_CHARS = 200
// 自动补全：停止输入多久后请求；太短会在打字途中反复请求，太长又会显得迟钝
const COMPLETION_AUTO_DELAY_MS = 900

/** 灰字插件状态；from 为插入位置（ProseMirror 位置，非字符偏移）。 */
type CompletionState = {
  status: 'idle' | 'loading' | 'ready'
  text: string
  from: number | null
}

const COMPLETION_IDLE: CompletionState = { status: 'idle', text: '', from: null }
const completionKey = new PluginKey<CompletionState>('sheep-completion')

/** 触发键预设到键盘事件的映射。 */
const COMPLETION_TRIGGERS: Record<CompletionTriggerKey, { key: string; code: string; ctrl: boolean; alt: boolean }> = {
  'alt-arrow-right': { key: 'ArrowRight', code: 'ArrowRight', ctrl: false, alt: true },
  'ctrl-arrow-right': { key: 'ArrowRight', code: 'ArrowRight', ctrl: true, alt: false },
  'alt-slash': { key: '/', code: 'Slash', ctrl: false, alt: true }
}

// 纯修饰键按下时不清除灰字，否则按 Shift 会把刚出现的提示抹掉
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

/** 灰字 DOM；只读、不参与选区、不换行。 */
function buildCompletionDom(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'sheep-completion-ghost'
  span.setAttribute('aria-hidden', 'true')
  span.textContent = text
  return span
}

/**
 * 清洗模型输出：
 * 取第一段、去掉与前缀结尾重复的部分、去掉模型爱加的开头引号。
 * 模型经常把上文末尾一并返回，直接展示会看到重复文字。
 */
function sanitizeCompletion(raw: string, prefix: string): string {
  if (!raw) return ''
  let text = raw.replace(/\r\n?/g, '\n')
  const paragraphBreak = text.indexOf('\n\n')
  if (paragraphBreak >= 0) text = text.slice(0, paragraphBreak)
  text = text.replace(/^[\s"'「『]+/, '').replace(/[\s]+$/, '')
  const tail = prefix.slice(-40)
  for (let length = Math.min(tail.length, text.length); length > 2; length -= 1) {
    if (tail.slice(-length) === text.slice(0, length)) {
      text = text.slice(length).replace(/^[\s"'「『]+/, '')
      break
    }
  }
  if (text.length > COMPLETION_MAX_CHARS) text = text.slice(0, COMPLETION_MAX_CHARS)
  return text
}

type SearchMatch = {
  from: number
  to: number
  text: string
  groups: string[]
}

const shell = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const findInput = ref<HTMLInputElement | null>(null)
const replaceInput = ref<HTMLInputElement | null>(null)
const findWidget = ref<HTMLElement | null>(null)
const searchOpen = ref(false)
const replaceOpen = ref(false)
const searchText = ref('')
const replacementText = ref('')
const matchCase = ref(false)
const wholeWord = ref(false)
const useRegex = ref(false)
const selectionOnly = ref(false)
const preserveCase = ref(false)
const searchError = ref('')
const matches = ref<SearchMatch[]>([])
const activeMatchIndex = ref(-1)
const hasEditorSelection = ref(false)

// 大纲导航：从 ProseMirror 文档树提取标题及真实节点位置
type OutlineItem = { level: number; text: string; pos: number }
const outlineOpen = ref(false)
const outlinePinned = ref(false)
watch(outlineOpen, (open) => emit('outlineHold', open))
const outlineItems = ref<OutlineItem[]>([])
let outlineCloseTimer: ReturnType<typeof setTimeout> | null = null

// 只记录当前文档的最近一次粘贴；后续正文事务立即使旧范围失效。
let lastPasteRange: { from: number; to: number; text: string; doc: ProseMirrorNode } | null = null
let pendingPaste: { from: number; to: number; formatted: boolean } | null = null
// 粘贴事件到粘贴事务之间的容差；超过该时长未产生事务就丢弃，避免误认到后续输入上
const PASTE_PENDING_TTL_MS = 600

let crepe: Crepe | null = null
let editorView: EditorView | null = null
let searchDecorations = DecorationSet.empty
// 在途补全的请求 ID；不为空说明有一个请求未结束，切文稿/失焦时需要取消
let activeCompletionId: string | null = null
// 自动补全的待触发定时器
let autoCompletionTimer: ReturnType<typeof setTimeout> | null = null
// 输入法组合中标记：组合期间不自动请求补全
let composing = false
// 刚接受过补全：抑制一次自动触发，否则接受带来的文档变化会立刻再请求一轮
let suppressAutoOnce = false
let selectionScope: { from: number; to: number } | null = null
let syncingScroll = false
let localFontSize = props.fontSize
let pendingExternalMarkdown: string | null = null
let cursorUpdateFrame = 0

// 手柄相对首行中心的视觉微调：整体再向右下移动，使图标看起来与文字行齐平
const HANDLE_NUDGE = 1.5

// 取块内首行正文的矩形：列表等结构的行盒不在块元素自身，需下钻到首个正文文本
function measureFirstLine(el: HTMLElement, blockRect: DOMRect): { top: number; height: number } {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  while ((node = walker.nextNode())) {
    const text = node.nodeValue ?? ''
    if (!text.trim()) continue
    // 列表符号所在的 label-wrapper 不算正文
    if ((node as Text).parentElement?.closest('.label-wrapper')) continue
    const start = text.search(/\S/)
    if (start < 0) continue
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + 1)
    const glyph = range.getBoundingClientRect()
    if (glyph.height > 0) return { top: glyph.top, height: glyph.height }
  }
  // 回退：按块自身的内边距与行高推算首行
  const style = window.getComputedStyle(el)
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0
  const lineHeight = Number.parseFloat(style.lineHeight) || blockRect.height
  const contentHeight = Math.max(blockRect.height - paddingTop - paddingBottom, 0)
  return { top: blockRect.top + paddingTop, height: Math.min(lineHeight, contentHeight) || blockRect.height }
}

const matchLabel = computed(() => {
  if (searchError.value) return '表达式错误'
  if (!searchText.value) return '0/0'
  if (!matches.value.length) return '无结果'
  return `${activeMatchIndex.value + 1}/${matches.value.length}`
})

onMounted(async () => {
  if (!host.value || !shell.value) return

  crepe = new Crepe({
    root: host.value,
    defaultValue: props.modelValue,
    features: {
      [CrepeFeature.AI]: false,
      [CrepeFeature.TopBar]: false
    },
    featureConfigs: {
      [CrepeFeature.Placeholder]: {
        text: '开始写作，输入 / 可以插入标题、列表、图片、表格等内容'
      },
      [CrepeFeature.ImageBlock]: {
        inlineUploadButton: '上传图片',
        inlineUploadPlaceholderText: '或粘贴图片链接',
        blockUploadButton: '选择图片',
        blockUploadPlaceholderText: '或粘贴图片链接',
        blockCaptionPlaceholderText: '添加图片说明…',
        blockConfirmButton: '确认',
        onUpload: uploadImage,
        proxyDomURL: (url: string) => url,
        maxWidth: 980,
        maxHeight: 680
      },
      [CrepeFeature.LinkTooltip]: {
        inputPlaceholder: '粘贴或输入链接…'
      },
      [CrepeFeature.Toolbar]: {
        boldLabel: '粗体',
        italicLabel: '斜体',
        strikethroughLabel: '删除线',
        codeLabel: '行内代码',
        linkLabel: '链接',
        latexLabel: '公式'
      },
      [CrepeFeature.BlockEdit]: {
        // 操作柄对齐首行文字中心：仅把首行区域交给定位，避免整段居中或顶对齐造成高低不一。
        blockHandle: {
          // 手柄整体向右下微调：左放置时 offset 越小越靠右，纵向在首行基线上再加偏移
          getOffset: () => 5 - HANDLE_NUDGE,
          getPosition: ({ active }) => {
            const rect = active.el.getBoundingClientRect()
            const line = measureFirstLine(active.el, rect)
            const top = line.top + HANDLE_NUDGE
            return { x: rect.x, y: top, width: rect.width, height: line.height, top, right: rect.right, bottom: top + line.height, left: rect.left }
          },
          // 位置已是首行区域，居中即可与文字同行。
          getPlacement: () => 'left'
        },
        textGroup: {
          label: '文字',
          text: { label: '正文' },
          h1: { label: '一级标题' },
          h2: { label: '二级标题' },
          h3: { label: '三级标题' },
          h4: { label: '四级标题' },
          h5: { label: '五级标题' },
          h6: { label: '六级标题' },
          quote: { label: '引用' },
          divider: { label: '分割线' }
        },
        listGroup: {
          label: '列表',
          bulletList: { label: '无序列表' },
          orderedList: { label: '有序列表' },
          taskList: { label: '任务列表' }
        },
        advancedGroup: {
          label: '高级内容',
          image: { label: '图片' },
          codeBlock: { label: '代码块' },
          table: { label: '表格' },
          math: { label: '数学公式' }
        }
      }
    }
  })

  crepe.setReadonly(Boolean(props.readonly))
  crepe.editor.config((ctx) => {
    ctx.update(prosePluginsCtx, (plugins) => [
      keymap({ 'Mod-d': duplicateCurrentBlock }),
      // 行内补全插件：灰字走自带 decorations，由 ProseMirror 自动与查找高亮合并
      new Plugin<CompletionState>({
        key: completionKey,
        state: {
          init: () => COMPLETION_IDLE,
          apply(transaction, value) {
            const meta = transaction.getMeta(completionKey) as CompletionState | undefined
            if (meta) return meta
            if (value.status === 'idle') return value
            // 灰字本身不入文档，所以这里能变动的只有用户输入
            if (transaction.docChanged) return COMPLETION_IDLE
            if (value.from !== null) return { ...value, from: transaction.mapping.map(value.from) }
            return value
          }
        },
        view() {
          return {
            update(view, prevState) {
              const previous = completionKey.getState(prevState)
              const current = completionKey.getState(view.state)
              // 灰字的出现与消失都在这里统一对外通知：
              // 用户输入会让插件 apply 直接把状态清成 idle，那条路径发不出事件。
              if (previous?.status !== current?.status || previous?.text !== current?.text) {
                const active = current?.status === 'ready' && Boolean(current.text)
                emit('completionChange', { active, preview: active ? current.text.slice(0, 40) : '' })
              }
              if (view.state.doc.eq(prevState.doc)) {
                return
              }
              // 刚接受过补全：本次文档变化来自接受，跳过一轮自动触发
              if (suppressAutoOnce) {
                suppressAutoOnce = false
                return
              }
              scheduleAutoCompletion(view)
            }
          }
        },
        props: {
          decorations(state) {
            const value = completionKey.getState(state)
            if (!value || value.status !== 'ready' || !value.text || value.from === null) return null
            return DecorationSet.create(state.doc, [
              Decoration.widget(value.from, () => buildCompletionDom(value.text), { side: 1, key: `ghost-${value.text}` })
            ])
          },
          handleKeyDown(view, event) {
            const trigger = COMPLETION_TRIGGERS[props.completionTrigger] ?? COMPLETION_TRIGGERS['alt-arrow-right']
            const matchesTrigger = event.altKey === trigger.alt
              && event.ctrlKey === trigger.ctrl
              && !event.metaKey
              && (event.key === trigger.key || event.code === trigger.code)
            if (matchesTrigger) {
              void triggerCompletion(view)
              return true
            }
            // 接受：→（无灰字时返回 false，让光标正常右移）
            if (event.key === 'ArrowRight' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              return acceptCompletion(view)
            }
            if (event.key === 'Escape') return clearCompletion()
            // 其它任意键：先清灰字，再把该键交给编辑器正常处理
            if (!MODIFIER_KEYS.has(event.key)) clearCompletion()
            return false
          }
        }
      }),
      new Plugin({
        appendTransaction(transactions, oldState, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          const pending = pendingPaste
          pendingPaste = null
          const incoming = pending ? mapRangeThrough(transactions, pending) : null

          // 已有粘贴提示：只要粘贴进来的文字原样还在，就只是 Milkdown 自己的规范化事务
          // （列表组件、标题 ID 等）在改文档，不该把提示取消掉。
          // 原先要求“文档完全未变”才显示提示，会被这类事务误伤。
          if (lastPasteRange) {
            const mapped = mapRangeThrough(transactions, lastPasteRange)
            const textNow = state.doc.textBetween(mapped.from, mapped.to, '\n')
            // 规范化事务常在粘贴内容后补一个空段落，使区间与文字各多出一截；
            // 比较时忽略首尾空白，否则正常的粘贴会被误判成「用户改了内容」而取消提示。
            if (textNow.trim() && textNow.trim() === lastPasteRange.text.trim()) {
              lastPasteRange.from = mapped.from
              lastPasteRange.to = mapped.to
              lastPasteRange.text = textNow
              lastPasteRange.doc = state.doc
              if (!incoming) return null
            } else {
              lastPasteRange = null
              emit('pasteInvalidated')
            }
          }

          if (!incoming) return null
          // 只有真的带格式才提示：纯文本粘贴时「清除格式」按下去什么都不会变，
          // 提示反而成了噪声。判定在粘贴那一刻就做好了（见 clipboardHasFormat）。
          if (!incoming.formatted) return null
          const pastedText = state.doc.textBetween(incoming.from, incoming.to, '\n')
          if (!pastedText.trim() || incoming.to <= incoming.from) return null
          const snapshot = { from: incoming.from, to: incoming.to, text: pastedText, doc: state.doc }
          lastPasteRange = snapshot
          // 必须等正文更新回调跑完再提示：粘贴会让 App.vue 的 onContentChanged 先清一次提示，
          // 立即 emit 会被它当场清掉。期间若用户改动了粘贴内容，上面的检查已把
          // lastPasteRange 置空（或换成新对象），这里就不会再提示。
          window.setTimeout(() => {
            if (lastPasteRange !== snapshot) return
            emit('pasted', { from: snapshot.from, to: snapshot.to }, snapshot.text)
          }, 250)
          return null
        }
      }),
      ...plugins
    ])
  })

  crepe.on((listener) => {
    listener.markdownUpdated((_, markdown) => {
      if (pendingExternalMarkdown !== null && markdown === pendingExternalMarkdown) {
        pendingExternalMarkdown = null
      } else if (markdown !== props.modelValue) {
        emit('update:modelValue', markdown)
      }
      updateSearchMatches()
      refreshOutline()
      syncListLabelWidth()
      scheduleCursorSafetyUpdate()
    })
    listener.selectionUpdated((ctx, value) => {
      editorView = ctx.get(editorViewCtx)
      const { from, to } = value
      const text = from === to ? '' : crepe?.editor.action(getMarkdown({ from, to })) ?? editorView.state.doc.textBetween(from, to, '\n')
      hasEditorSelection.value = to > from
      emit('selectionChange', { from, to, text })
      scheduleCursorSafetyUpdate()
    })
    listener.focus(() => emit('focusChange', true))
    listener.blur(() => {
      // 编辑器失焦时丢弃灰字，避免切回来看到一个已过期的建议
      clearCompletion()
      requestAnimationFrame(() => {
        const focusedInside = shell.value?.contains(document.activeElement) ?? false
        emit('focusChange', focusedInside || searchOpen.value)
      })
    })
  })

  try {
    await crepe.create()
    editorView = crepe.editor.action((ctx) => ctx.get(editorViewCtx))
    editorView.setProps({ decorations: () => searchDecorations })
    // ProseMirror 默认给可编辑区开启拼写检查，这里显式关闭以避免英文单词下的红色波浪线
    editorView.dom.setAttribute('spellcheck', 'false')
    editorView.dom.addEventListener('paste', onPasteCapture, true)
    editorView.dom.addEventListener('compositionstart', onCompositionStart)
    editorView.dom.addEventListener('compositionend', onCompositionEnd)
    editorView.dom.addEventListener('click', onEditorClick)
    shell.value.addEventListener('wheel', onWheel, { passive: false })
    shell.value.addEventListener('scroll', onScroll, { passive: true })
    shell.value.addEventListener('keydown', onSearchShortcut, true)
    syncListLabelWidth()
    // 自选字体可能晚于首次渲染才加载完成，加载后再量一次
    void document.fonts?.ready.then(() => syncListLabelWidth())

    emitSelection()
  } catch (error) {
    emit('toast', { type: 'error', message: `Milkdown 编辑器初始化失败：${cleanError(error)}` })
  }
})

onBeforeUnmount(() => {
  if (cursorUpdateFrame) cancelAnimationFrame(cursorUpdateFrame)
  // 组件卸载前取消在途补全，避免请求返回后往已销毁的视图写入
  clearCompletion()
  if (editorView) {
    editorView.dom.removeEventListener('paste', onPasteCapture, true)
    editorView.dom.removeEventListener('compositionstart', onCompositionStart)
    editorView.dom.removeEventListener('compositionend', onCompositionEnd)
    editorView.dom.removeEventListener('click', onEditorClick)
  }
  shell.value?.removeEventListener('wheel', onWheel)
  shell.value?.removeEventListener('scroll', onScroll)
  shell.value?.removeEventListener('keydown', onSearchShortcut, true)
  void crepe?.destroy()
  crepe = null
  editorView = null
})

watch(() => props.modelValue, (value) => {
  if (!crepe || !editorView) return
  const current = crepe.getMarkdown()
  if (value === current) return
  pendingExternalMarkdown = value
  crepe.editor.action(replaceAll(value))
  requestAnimationFrame(() => {
    updateSearchMatches()
  })
})

watch(() => props.fontSize, (size) => {
  localFontSize = size
  // 字号变化后重新量一次序号列宽度
  requestAnimationFrame(syncListLabelWidth)
})

watch(() => props.draftId, () => clearCompletion())
watch(() => props.readonly, (value) => crepe?.setReadonly(Boolean(value)))
watch([searchText, matchCase, wholeWord, useRegex, selectionOnly], updateSearchMatches)
watch(replaceOpen, () => nextTick(() => (replaceOpen.value ? replaceInput.value : findInput.value)?.focus({ preventScroll: true })))

// 序号列宽度按当前字体实测：不同字体的数字与点号宽度差异很大（宋体/黑体/楷体/仿宋
// 的点号是半宽全角，需要约 3ch；默认字体、微软雅黑、Arial 只要约 2.4ch），
// 写死固定值会让两位序号（10.）撑开或换行，导致序号与内容缩进参差。
const LIST_LABEL_MIN_WIDTH = 20
let listLabelProbe: HTMLSpanElement | null = null
let listLabelSignature = ''

function syncListLabelWidth(): void {
  const source = shell.value?.querySelector('.ProseMirror')
  if (!source) return
  const style = getComputedStyle(source)
  const signature = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`
  // 字体没变就不用重量（每次正文更新都会调到这里）
  if (signature === listLabelSignature && listLabelProbe) return
  if (!listLabelProbe) {
    listLabelProbe = document.createElement('span')
    listLabelProbe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none'
    // 用「99.」代表两位序号的最宽情形（9 是最宽数字）
    listLabelProbe.textContent = '99.'
  }
  listLabelProbe.style.fontFamily = style.fontFamily
  listLabelProbe.style.fontSize = style.fontSize
  listLabelProbe.style.fontWeight = style.fontWeight
  shell.value?.appendChild(listLabelProbe)
  const width = Math.ceil(listLabelProbe.getBoundingClientRect().width)
  listLabelProbe.remove()
  if (!width) return
  listLabelSignature = signature
  shell.value?.style.setProperty('--sheep-list-label-width', `${Math.max(LIST_LABEL_MIN_WIDTH, width)}px`)
}

async function uploadImage(file: File): Promise<string> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await window.sheepText.savePastedImage(props.draftId, { mimeType: file.type, bytes })
    emit('toast', { type: 'success', message: '图片已复制到当前文稿的独立资源目录' })
    return result.url
  } catch (error) {
    const message = `图片粘贴失败：${cleanError(error)}`
    emit('toast', { type: 'error', message })
    throw new Error(message)
  }
}

// 比较正文时仅忽略自动生成的标题 ID，其他节点属性、标记及文字仍严格比较。

// 捕获阶段只记录选区，不阻断原生粘贴，避免其他插件先消费 HTML 后漏记。
/** 把一个位置区间依次过一遍事务映射，得到它在当前文档中的位置；附加字段原样保留。 */
function mapRangeThrough<T extends { from: number; to: number }>(
  transactions: readonly Transaction[],
  range: T
): T {
  let from = range.from
  let to = range.to
  for (const transaction of transactions) {
    from = transaction.mapping.map(from, -1)
    to = transaction.mapping.map(to, 1)
  }
  return { ...range, from, to }
}

/** 这些标签出现即认为粘贴内容带格式（标题、列表、表格、代码、引用、链接、强调等）。 */
const FORMATTING_TAGS = [
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'a', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre', 'img', 'hr'
].join(',')

/**
 * 判断剪贴板内容是否真的带可清除的格式。
 * 在粘贴那一刻判定，而不是事后去看文档区间：粘贴会整段替换当前空段落，
 * 事后的位置区间可能落空（实测取不到刚插入的列表节点），导致提示漏报。
 */
function clipboardHasFormat(data: DataTransfer): boolean {
  const plain = data.getData('text/plain') ?? ''
  // 纯文本里带 Markdown 标记：Milkdown 会解析成结构，「清除格式」有意义
  if (stripPasteMarkdown(plain) !== plain) return true
  const html = data.getData('text/html') ?? ''
  if (!html.trim()) return false
  try {
    const body = new DOMParser().parseFromString(html, 'text/html').body
    if (body.querySelector(FORMATTING_TAGS)) return true
    // Word、网页复制时常用行内样式表达加粗/斜体/下划线，没有语义标签
    return Array.from(body.querySelectorAll('[style]')).some((element) => {
      const style = (element as HTMLElement).style
      const weight = style.fontWeight === 'bold' ? 700 : Number(style.fontWeight) || 0
      const decoration = style.textDecorationLine || style.textDecoration || ''
      return weight >= 600 || style.fontStyle === 'italic'
        || decoration.includes('underline') || decoration.includes('line-through')
    })
  } catch {
    return false
  }
}

function onPasteCapture(event: ClipboardEvent): void {
  pendingPaste = null
  const data = event.clipboardData
  if (!editorView || props.readonly || !data || editorView.state.selection.$from.parent.type.spec.code) return
  if ((event.target as Element)?.closest('.cm-editor') || Array.from(data.items).some((item) => item.kind === 'file')) return
  const snapshot = {
    from: editorView.state.selection.from,
    to: editorView.state.selection.to,
    formatted: clipboardHasFormat(data)
  }
  pendingPaste = snapshot
  // 粘贴事务可能比 paste 事件晚几毫秒到达，不能用微任务立即清理，
  // 否则 appendTransaction 取不到范围，底部「保留原格式 / 清除格式」提示就不会出现。
  window.setTimeout(() => { if (pendingPaste === snapshot) pendingPaste = null }, PASTE_PENDING_TTL_MS)
}

function onCompositionStart(): void {
  composing = true
  cancelAutoCompletion()
  emit('compositionChange', true)
}

function onCompositionEnd(): void {
  composing = false
  emit('compositionChange', false)
  // U02：一次输入法提交切成一步撤销。
  // ProseMirror 默认按 500ms 合并历史，中文连打会被并成一整段；
  // 这里补一个带 closeHistory 的空事务，把下一步强制开成新分组。
  // 需等本次组合的 DOM 变更被观察器收完，否则切断过早会把提交内容挤进下一组。
  queueMicrotask(() => {
    if (!editorView || props.readonly) return
    editorView.dispatch(closeHistory(editorView.state.tr))
  })
}

function onEditorClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  const link = target.closest<HTMLAnchorElement>('a[href]')
  if (!link) return
  const href = link.getAttribute('href') ?? ''
  if (!/^(https?:|mailto:)/i.test(href)) return
  event.preventDefault()
  void window.sheepText.openExternal(href)
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  const nextSize = Math.max(13, Math.min(26, localFontSize + (event.deltaY < 0 ? 1 : -1)))
  if (nextSize === localFontSize) return
  localFontSize = nextSize
  emit('fontSizeChange', nextSize)
}

function onScroll(): void {
  if (!shell.value || syncingScroll) return
  const maximum = shell.value.scrollHeight - shell.value.clientHeight
  emit('scrollChange', maximum > 0 ? shell.value.scrollTop / maximum : 0)
}

function emitSelection(): void {
  if (!editorView || !crepe) return
  const { from, to } = editorView.state.selection
  const text = from === to ? '' : crepe.editor.action(getMarkdown({ from, to }))
  hasEditorSelection.value = to > from
  emit('selectionChange', { from, to, text })
}

function scheduleCursorSafetyUpdate(): void {
  if (cursorUpdateFrame) cancelAnimationFrame(cursorUpdateFrame)
  cursorUpdateFrame = requestAnimationFrame(keepCursorAboveBottom)
}
// 占位：保持光标安全距离更新入口不变（行号测量已随功能移除）

function keepCursorAboveBottom(): void {
  cursorUpdateFrame = 0
  if (!editorView || !shell.value || !editorView.hasFocus()) return
  const cursor = editorView.coordsAtPos(editorView.state.selection.head)
  const bounds = shell.value.getBoundingClientRect()
  const safeBottom = bounds.bottom - localFontSize * 1.78 * 8
  if (cursor.bottom > safeBottom) shell.value.scrollTop += cursor.bottom - safeBottom
}

function duplicateCurrentBlock(state: EditorState, dispatch?: (transaction: Transaction) => void): boolean {
  const { $head } = state.selection
  let blockDepth = Math.max(1, $head.depth)
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth)
    if (node.type.name === 'list_item') {
      blockDepth = depth
      break
    }
    if (node.isTextblock) blockDepth = depth
  }

  const from = $head.before(blockDepth)
  const to = $head.after(blockDepth)
  const slice = state.doc.slice(from, to)
  if (!slice.content.size) return false
  if (!dispatch) return true

  const selectionOffset = Math.max(1, state.selection.head - from)
  let transaction = state.tr.insert(to, slice.content)
  const nextCursor = Math.min(transaction.doc.content.size, to + selectionOffset)
  transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(nextCursor))).scrollIntoView()
  dispatch(transaction)
  return true
}

function buildSearchExpression(global = true): RegExp | null {
  if (!searchText.value) return null
  let source = useRegex.value ? searchText.value : escapeRegExp(searchText.value)
  if (wholeWord.value) source = `\\b(?:${source})\\b`
  try {
    return new RegExp(source, `${global ? 'g' : ''}${matchCase.value ? '' : 'i'}u`)
  } catch {
    searchError.value = '表达式无效'
    return null
  }
}

function updateSearchMatches(): void {
  // 搜索框关闭后禁止重建高亮装饰，避免输入或选项变化让旧高亮复现。
  if (!editorView || !searchOpen.value) {
    matches.value = []
    activeMatchIndex.value = -1
    if (editorView) applySearchDecorations()
    return
  }
  searchError.value = ''
  const expression = buildSearchExpression(true)
  if (!expression) {
    matches.value = []
    activeMatchIndex.value = -1
    applySearchDecorations()
    return
  }

  const scope = selectionOnly.value ? selectionScope : null
  const found: SearchMatch[] = []
  editorView.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return true
    expression.lastIndex = 0
    let result: RegExpExecArray | null
    while ((result = expression.exec(node.text))) {
      const from = position + result.index
      const to = from + result[0].length
      if ((!scope || (from >= scope.from && to <= scope.to)) && to > from) {
        found.push({ from, to, text: result[0], groups: Array.from(result) })
      }
      if (!result[0].length) expression.lastIndex += 1
    }
    return true
  })

  matches.value = found
  if (!found.length) activeMatchIndex.value = -1
  else if (activeMatchIndex.value < 0 || activeMatchIndex.value >= found.length) activeMatchIndex.value = 0
  applySearchDecorations()
}

function applySearchDecorations(): void {
  if (!editorView) return
  const ranges = matches.value.map((match, index) => Decoration.inline(match.from, match.to, {
    class: index === activeMatchIndex.value ? 'milkdown-search-match is-active' : 'milkdown-search-match'
  }))
  searchDecorations = DecorationSet.create(editorView.state.doc, ranges)
  editorView.updateState(editorView.state)
}

function navigateMatch(direction: 1 | -1): void {
  if (!editorView || !matches.value.length) return
  activeMatchIndex.value = (activeMatchIndex.value + direction + matches.value.length) % matches.value.length
  applySearchDecorations()
  revealActiveMatch()
}

function revealActiveMatch(): void {
  if (!editorView) return
  const match = matches.value[activeMatchIndex.value]
  if (!match) return
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const keepWidgetFocus = focusedElement ? findWidget.value?.contains(focusedElement) ?? false : false
  editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, match.from, match.to)).scrollIntoView())
  if (!keepWidgetFocus) editorView.focus()
  requestAnimationFrame(() => {
    ensurePositionVisible(match.from)
    if (keepWidgetFocus) focusedElement?.focus({ preventScroll: true })
  })
}

function ensurePositionVisible(position: number): void {
  if (!editorView || !shell.value) return
  const coords = editorView.coordsAtPos(position)
  const shellBounds = shell.value.getBoundingClientRect()
  const widgetBottom = searchOpen.value && findWidget.value ? findWidget.value.getBoundingClientRect().bottom + 8 : shellBounds.top + 8
  if (coords.top < widgetBottom) shell.value.scrollTop -= widgetBottom - coords.top
  else if (coords.bottom > shellBounds.bottom - 12) shell.value.scrollTop += coords.bottom - shellBounds.bottom + 12
}

function onSearchShortcut(event: KeyboardEvent): void {
  if (!searchOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeSearch()
    return
  }
  if (event.key === 'F3') {
    event.preventDefault()
    event.stopPropagation()
    navigateMatch(event.shiftKey ? -1 : 1)
    return
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'r') {
    event.preventDefault()
    event.stopPropagation()
    replaceOpen.value = !replaceOpen.value
  }
}

function replacementFor(match: SearchMatch): string {
  let result = replacementText.value
  if (useRegex.value) {
    const expression = buildSearchExpression(false)
    if (expression) result = match.text.replace(expression, replacementText.value)
  }
  return preserveCase.value ? preserveReplacementCase(match.text, result) : result
}

function selectEveryMatch(): void {
  if (!editorView || !matches.value.length) return
  const first = matches.value[0]
  const last = matches.value[matches.value.length - 1]
  if (!first || !last) return
  editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, first.from, last.to)).scrollIntoView())
  editorView.focus()
}

function replaceCurrent(): void {
  if (!editorView) return
  const match = matches.value[activeMatchIndex.value]
  if (!match) return
  const replacement = replacementFor(match)
  const transaction = editorView.state.tr.insertText(replacement, match.from, match.to)
  editorView.dispatch(transaction)
  updateSearchMatches()
  if (matches.value.length) revealActiveMatch()
}

function replaceEveryMatch(): void {
  if (!editorView || !matches.value.length) return
  let transaction = editorView.state.tr
  for (const match of [...matches.value].reverse()) {
    transaction = transaction.insertText(replacementFor(match), match.from, match.to)
  }
  editorView.dispatch(transaction)
  updateSearchMatches()
  emit('toast', { type: 'success', message: '已替换全部匹配内容' })
}

function toggleSelectionOnly(): void {
  if (!editorView) return
  if (!selectionOnly.value) {
    const { from, to } = editorView.state.selection
    if (from === to) return
    selectionScope = { from, to }
    selectionOnly.value = true
  } else {
    selectionOnly.value = false
    selectionScope = null
  }
}

function onFindKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    navigateMatch(event.shiftKey ? -1 : 1)
  } else if (event.key === 'ArrowDown' && !searchText.value) {
    event.preventDefault()
  }
}

function onReplaceKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    replaceCurrent()
  }
}

function openSearch(): void {
  if (props.readonly) return
  const previousScrollTop = shell.value?.scrollTop ?? 0
  searchOpen.value = true
  emit('focusChange', true)
  if (editorView) {
    const { from, to } = editorView.state.selection
    hasEditorSelection.value = to > from
    if (to > from) {
      const selected = editorView.state.doc.textBetween(from, to, '\n')
      if (selected && !selected.includes('\n')) searchText.value = selected
    }
  }
  nextTick(() => {
    if (shell.value) shell.value.scrollTop = previousScrollTop
    findInput.value?.focus({ preventScroll: true })
    findInput.value?.select()
    updateSearchMatches()
    requestAnimationFrame(() => {
      if (shell.value) shell.value.scrollTop = previousScrollTop
    })
  })
}

function closeSearch(): void {
  searchOpen.value = false
  replaceOpen.value = false
  selectionOnly.value = false
  selectionScope = null
  matches.value = []
  activeMatchIndex.value = -1
  applySearchDecorations()
  // 搜索导航留下的匹配选区收为光标，避免关闭后仍呈现高亮背景。
  if (editorView && !editorView.state.selection.empty) {
    editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, editorView.state.selection.head)))
  }
  editorView?.focus()
}

function focus(): void {
  editorView?.focus()
}

function replaceRange(from: number, to: number, text: string, replaceWholeDocument = false): void {
  if (!crepe || !editorView) return
  if (replaceWholeDocument) crepe.editor.action(replaceAll(text))
  else crepe.editor.action(replaceMarkdownRange(text, { from, to }))
  requestAnimationFrame(() => {
    editorView?.focus()
    scheduleCursorSafetyUpdate()
  })
}

function undoOnce(): boolean {
  return crepe?.editor.action(callCommand(undoCommand.key)) ?? false
}

function redoOnce(): boolean {
  return crepe?.editor.action(callCommand(redoCommand.key)) ?? false
}

function setScrollRatio(ratio: number): void {
  if (!shell.value) return
  const maximum = shell.value.scrollHeight - shell.value.clientHeight
  syncingScroll = true
  shell.value.scrollTop = Math.max(0, Math.min(1, ratio)) * Math.max(0, maximum)
  requestAnimationFrame(() => { syncingScroll = false })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function preserveReplacementCase(source: string, replacement: string): string {
  if (!replacement) return replacement
  if (source === source.toUpperCase()) return replacement.toUpperCase()
  if (source === source.toLowerCase()) return replacement.toLowerCase()
  if (source[0] === source[0]?.toUpperCase()) return replacement[0]?.toUpperCase() + replacement.slice(1)
  return replacement
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
}

// 从当前文档提取标题，只遍历真实 heading 节点，避免把代码块里的 # 当标题
function refreshOutline(): void {
  if (!editorView) {
    outlineItems.value = []
    return
  }
  const items: OutlineItem[] = []
  editorView.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim()
      if (text) items.push({ level: node.attrs.level as number, text, pos })
    }
    return true
  })
  outlineItems.value = items
}

function handleOutlineEnter(): void {
  if (outlineCloseTimer) { clearTimeout(outlineCloseTimer); outlineCloseTimer = null }
  refreshOutline()
  outlineOpen.value = true
}

function handleOutlineLeave(): void {
  if (outlineCloseTimer) clearTimeout(outlineCloseTimer)
  if (outlinePinned.value) return
  outlineCloseTimer = setTimeout(() => { outlineOpen.value = false }, 220)
}

// 悬停临时预览，点击固定，再次点击取消并收起。
function toggleOutlinePinned(): void {
  if (outlinePinned.value) closeOutline()
  else { outlinePinned.value = true; handleOutlineEnter() }
}

function closeOutline(): void {
  if (outlineCloseTimer) clearTimeout(outlineCloseTimer)
  outlinePinned.value = false
  outlineOpen.value = false
}

function jumpToHeading(item: OutlineItem): void {
  if (!editorView) return
  const target = editorView.state.doc.nodeAt(item.pos)
  if (!target) { refreshOutline(); return }
  // 点击大纲仅移动选区和滚动，不改动正文内容
  editorView.dispatch(editorView.state.tr.setSelection(TextSelection.near(editorView.state.doc.resolve(item.pos + 1))).scrollIntoView())
  editorView.focus()
  requestAnimationFrame(() => {
    if (!editorView || !shell.value) return
    const dom = editorView.domAtPos(item.pos + 1)
    const element = dom.node instanceof Element ? dom.node : dom.node.parentElement
    const bounds = element?.getBoundingClientRect()
    if (bounds) shell.value.scrollTop += bounds.top - shell.value.getBoundingClientRect().top - 24
  })
}

// 清除粘贴范围的 Markdown 格式标记：逐行转成普通段落，避免换行进入文本节点；单次事务可撤销
function clearPasteFormat(from: number, to: number): boolean {
  if (!editorView || props.readonly || !lastPasteRange) return false
  if (lastPasteRange.doc !== editorView.state.doc || from !== lastPasteRange.from || to !== lastPasteRange.to) return false
  // 完整覆盖的首尾文本块连同块类型一起替换，才能真正清除标题格式。
  const start = editorView.state.doc.resolve(from)
  const end = editorView.state.doc.resolve(to)
  const replaceFrom = start.depth && start.parent.isTextblock && start.parentOffset === 0 ? start.before() : from
  const replaceTo = end.depth && end.parent.isTextblock && end.parentOffset === end.parent.content.size ? end.after() : to
  const source = editorView.state.doc.textBetween(replaceFrom, replaceTo, '\n', (node) => {
    if (node.type.name.includes('image')) return String(node.attrs.alt || node.attrs.src || '')
    if (node.type.name === 'hardbreak' || node.type.name === 'hard_break') return '\n'
    return ''
  })
  if (!source.trim()) return false
  const schema = editorView.state.schema
  const paragraphs = source.split('\n').map((line) =>
    schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined)
  )
  // 保持粘贴边界的开放深度，不把同段前后的未粘贴文字一起转成普通段落。
  const original = editorView.state.doc.slice(replaceFrom, replaceTo)
  const slice = new Slice(Fragment.fromArray(paragraphs), Math.min(original.openStart, 1), Math.min(original.openEnd, 1))
  editorView.dispatch(editorView.state.tr.replace(replaceFrom, replaceTo, slice))
  lastPasteRange = null
  return true
}

onBeforeUnmount(() => {
  if (outlineCloseTimer) clearTimeout(outlineCloseTimer)
  emit('outlineHold', false)
})


// ---- 补全：状态写入、触发、接受、清除 ----

/** 只改插件 state，不动文档；因此不会触发 markdownUpdated 与自动保存。 */
function setCompletionState(view: EditorView, next: CompletionState): void {
  view.dispatch(view.state.tr.setMeta(completionKey, next))
}

/** 按 F08 裁剪上下文：短文稿发全文，长文稿只发光标附近。 */
function buildCompletionContext(view: EditorView): { prefix: string; suffix: string; pos: number } {
  const pos = view.state.selection.to
  const doc = view.state.doc
  const prefixFull = doc.textBetween(0, pos, '\n', '\n')
  const suffixFull = doc.textBetween(pos, doc.content.size, '\n', '\n')
  const total = prefixFull.length + suffixFull.length
  if (total <= COMPLETION_FULL_DOC_LIMIT) return { prefix: prefixFull, suffix: suffixFull, pos }
  return {
    prefix: prefixFull.slice(-COMPLETION_PREFIX_LIMIT),
    suffix: suffixFull.slice(0, COMPLETION_SUFFIX_LIMIT),
    pos
  }
}


/** 取消待触发的自动补全（输入继续、失焦、清除灰字时调用）。 */
function cancelAutoCompletion(): void {
  if (autoCompletionTimer) {
    clearTimeout(autoCompletionTimer)
    autoCompletionTimer = null
  }
}

/** 停止输入后自动请求补全；模仿 Copilot 的「打字停顿即提示」。 */
function scheduleAutoCompletion(view: EditorView): void {
  cancelAutoCompletion()
  if (!props.completionEnabled || !props.completionAutoEnabled) return
  if (view.state.selection.from !== view.state.selection.to) return
  // 输入法组合期间不请求：中文打字中途的中间态没有补全价值，还会浪费 token
  if (composing) return
  const $from = view.state.selection.$from
  // 代码块里补全意义不大，且容易与代码语义冲突
  if ($from.parent.type.spec.code) return
  autoCompletionTimer = setTimeout(() => {
    autoCompletionTimer = null
    if (editorView !== view || !view.hasFocus()) return
    if (view.state.selection.from !== view.state.selection.to) return
    void triggerCompletion(view)
  }, COMPLETION_AUTO_DELAY_MS)
}

/** 取消在途请求并抹掉灰字；返回是否真的清掉了东西（用于决定是否拦截按键）。 */
function clearCompletion(): boolean {
  cancelAutoCompletion()
  if (activeCompletionId) {
    void window.sheepText.cancelCompletion(activeCompletionId)
    activeCompletionId = null
  }
  if (!editorView) return false
  const current = completionKey.getState(editorView.state)
  if (!current || current.status === 'idle') return false
  setCompletionState(editorView, COMPLETION_IDLE)
  return true
}

/** 接受灰字：作为一次普通事务插入，可被 Ctrl+Z 撤销。 */
function acceptCompletion(view?: EditorView): boolean {
  // 键盘路径传入 view；底部提示条的「采用」按钮从组件外部调用，不传参，
  // 此时回退到当前编辑器实例，否则会在 view.state 上抛错、按钮点了没反应。
  const target = view ?? editorView
  if (!target) return false
  const current = completionKey.getState(target.state)
  if (!current || current.status !== 'ready' || !current.text || current.from === null) return false
  // 必须先置抑制标记再 dispatch：dispatch 会同步触发 view.update，
  // 那里看到标记才会跳过自动补全，否则接受完会立刻又请求一轮。
  suppressAutoOnce = true
  cancelAutoCompletion()
  const transaction = target.state.tr.insertText(current.text, current.from)
  transaction.setMeta(completionKey, COMPLETION_IDLE)
  target.dispatch(transaction)
  return true
}

/** 触发一次补全；在途或已有灰字时忽略，避免连按产生重复请求。 */
async function triggerCompletion(view: EditorView): Promise<void> {
  if (!props.completionEnabled) {
    emit('toast', { type: 'info', message: 'AI 补全未启用，可在「设置 - 外观与行为」中开启' })
    return
  }
  if (!props.completionModelId) {
    emit('toast', { type: 'info', message: '请先在设置中配置补全模型' })
    return
  }
  const current = completionKey.getState(view.state)
  if (current && current.status !== 'idle') return

  const { prefix, suffix, pos } = buildCompletionContext(view)
  if (!prefix.trim()) {
    emit('toast', { type: 'info', message: '光标前没有内容，无法补全' })
    return
  }

  const requestId = `completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  activeCompletionId = requestId
  setCompletionState(view, { status: 'loading', text: '', from: pos })
  try {
    const result = await window.sheepText.runCompletion({
      requestId,
      windowId: props.windowId,
      modelConfigId: props.completionModelId,
      prefix,
      suffix
    })
    // 期间切了文稿、失了焦或被新请求取代，结果一律丢弃
    if (activeCompletionId !== requestId || editorView !== view) return
    const text = sanitizeCompletion(result.text, prefix)
    setCompletionState(view, text ? { status: 'ready', text, from: pos } : COMPLETION_IDLE)
  } catch {
    // 补全失败不打扰写作，原因已记入用量统计
    if (activeCompletionId === requestId && editorView === view) setCompletionState(view, COMPLETION_IDLE)
  } finally {
    if (activeCompletionId === requestId) activeCompletionId = null
  }
}

defineExpose({ focus, openSearch, replaceRange, undoOnce, redoOnce, setScrollRatio, clearPasteFormat, clearCompletion, acceptCompletion })
</script>

<template>
  <div class="milkdown-editor-frame">
    <!-- 大纲是滚动容器的兄弟节点，始终固定在编辑区右上角。 -->
    <div class="milkdown-outline no-drag" @mouseenter="handleOutlineEnter" @mouseleave="handleOutlineLeave" @keydown.esc.stop="closeOutline">
      <button type="button" class="milkdown-outline-trigger" :class="{ 'is-active': outlinePinned }" :aria-pressed="outlinePinned" :aria-expanded="outlineOpen" :title="outlinePinned ? '取消固定文档大纲' : '文档大纲（点击固定）'" @click="toggleOutlinePinned"><ListTree :size="17" /></button>
      <Transition name="popover">
        <div v-if="outlineOpen" class="milkdown-outline-panel">
          <p v-if="!outlineItems.length" class="milkdown-outline-empty">暂无标题，使用 # 可创建标题</p>
          <button v-for="(item, index) in outlineItems" :key="`${index}-${item.pos}`" type="button" class="milkdown-outline-item" :style="{ paddingLeft: `${(item.level - 1) * 14 + 12}px` }" :title="item.text" @click="jumpToHeading(item)">
            <span class="milkdown-outline-level">H{{ item.level }}</span><span class="milkdown-outline-text">{{ item.text }}</span>
          </button>
        </div>
      </Transition>
    </div>
  <div
    ref="shell"
    class="milkdown-editor-shell"
    :class="{
      'is-readonly': readonly,
      'has-find-widget': searchOpen,
      'has-replace-widget': searchOpen && replaceOpen
    }"
    :style="{ '--milkdown-font-size': `${fontSize}px` }"
  >
    <div v-if="searchOpen" ref="findWidget" class="milkdown-find-widget sheep-find-widget no-drag" :class="{ 'is-replacing': replaceOpen }" @mousedown.stop>
      <div class="milkdown-find-row sheep-find-row sheep-find-search-row">
        <button class="milkdown-find-toggle sheep-find-expand" :class="{ 'is-expanded': replaceOpen }" type="button" :title="replaceOpen ? '收起替换' : '展开替换'" @click="replaceOpen = !replaceOpen">›</button>
        <div class="sheep-find-field">
          <input ref="findInput" v-model="searchText" type="text" placeholder="查找" spellcheck="false" @keydown="onFindKeydown">
          <span class="milkdown-find-options sheep-find-options">
            <button type="button" class="sheep-find-option" :class="{ 'is-active': matchCase }" title="区分大小写" @click="matchCase = !matchCase">Aa</button>
            <button type="button" class="sheep-find-option" :class="{ 'is-active': wholeWord }" title="全字匹配" @click="wholeWord = !wholeWord">ab</button>
            <button type="button" class="sheep-find-option" :class="{ 'is-active': useRegex }" title="使用正则表达式" @click="useRegex = !useRegex">.*</button>
          </span>
        </div>
        <button type="button" class="sheep-find-icon-button" :class="{ 'is-active': selectionOnly }" :disabled="!hasEditorSelection && !selectionOnly" title="仅在初始选区中查找" @click="toggleSelectionOnly">▣</button>
        <span class="milkdown-find-count sheep-find-count" :class="{ 'is-empty': searchText && !matches.length }">{{ matchLabel }}</span>
        <button type="button" class="sheep-find-icon-button" title="上一个匹配项（Shift + Enter）" :disabled="!matches.length" @click="navigateMatch(-1)">↑</button>
        <button type="button" class="sheep-find-icon-button" title="下一个匹配项（Enter）" :disabled="!matches.length" @click="navigateMatch(1)">↓</button>
        <button type="button" class="sheep-find-icon-button" title="选择所有匹配项" :disabled="!matches.length" @click="selectEveryMatch">≡</button>
        <button type="button" class="sheep-find-icon-button sheep-find-close" title="关闭查找（Esc）" @click="closeSearch">×</button>
      </div>
      <div v-if="replaceOpen" class="milkdown-find-row sheep-find-row sheep-find-replace-row">
        <span class="sheep-find-spacer" />
        <input ref="replaceInput" v-model="replacementText" type="text" placeholder="替换" spellcheck="false" @keydown="onReplaceKeydown">
        <button type="button" class="sheep-find-text-button" :disabled="!matches.length" @click="replaceCurrent">替换</button>
        <button type="button" class="sheep-find-text-button" :disabled="!matches.length" @click="replaceEveryMatch">全部替换</button>
      </div>
    </div>

    <div ref="host" class="sheep-milkdown-editor" />
  </div>
  </div>
</template>
