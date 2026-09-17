<script setup lang="ts">
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'
import { editorViewCtx, prosePluginsCtx } from '@milkdown/kit/core'
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { callCommand, getMarkdown, replaceAll, replaceRange as replaceMarkdownRange } from '@milkdown/kit/utils'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ToastPayload } from '../../../shared/types'

const props = defineProps<{
  modelValue: string
  fontSize: number
  showLineNumbers: boolean
  draftId: string
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
}>()

type SearchMatch = {
  from: number
  to: number
  text: string
  groups: string[]
}

type LineMarker = {
  top: number
  height: number
  label: number
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
const lineMarkers = ref<LineMarker[]>([])
const hasEditorSelection = ref(false)

let crepe: Crepe | null = null
let editorView: EditorView | null = null
let searchDecorations = DecorationSet.empty
let selectionScope: { from: number; to: number } | null = null
let syncingScroll = false
let localFontSize = props.fontSize
let pendingExternalMarkdown: string | null = null
let mutationObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null
let lineUpdateFrame = 0
let cursorUpdateFrame = 0

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
    ctx.update(prosePluginsCtx, (plugins) => [keymap({ 'Mod-d': duplicateCurrentBlock }), ...plugins])
  })

  crepe.on((listener) => {
    listener.markdownUpdated((_, markdown) => {
      if (pendingExternalMarkdown !== null && markdown === pendingExternalMarkdown) {
        pendingExternalMarkdown = null
      } else if (markdown !== props.modelValue) {
        emit('update:modelValue', markdown)
      }
      updateSearchMatches()
      scheduleLineNumberUpdate()
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
    editorView.dom.addEventListener('compositionstart', onCompositionStart)
    editorView.dom.addEventListener('compositionend', onCompositionEnd)
    editorView.dom.addEventListener('click', onEditorClick)
    shell.value.addEventListener('wheel', onWheel, { passive: false })
    shell.value.addEventListener('scroll', onScroll, { passive: true })
    shell.value.addEventListener('keydown', onSearchShortcut, true)

    mutationObserver = new MutationObserver(scheduleLineNumberUpdate)
    mutationObserver.observe(host.value, { childList: true, subtree: true, attributes: true })
    resizeObserver = new ResizeObserver(scheduleLineNumberUpdate)
    resizeObserver.observe(shell.value)
    resizeObserver.observe(editorView.dom)

    emitSelection()
    scheduleLineNumberUpdate()
  } catch (error) {
    emit('toast', { type: 'error', message: `Milkdown 编辑器初始化失败：${cleanError(error)}` })
  }
})

onBeforeUnmount(() => {
  if (lineUpdateFrame) cancelAnimationFrame(lineUpdateFrame)
  if (cursorUpdateFrame) cancelAnimationFrame(cursorUpdateFrame)
  mutationObserver?.disconnect()
  resizeObserver?.disconnect()
  if (editorView) {
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
    scheduleLineNumberUpdate()
  })
})

watch(() => props.fontSize, (size) => {
  localFontSize = size
  scheduleLineNumberUpdate()
})

watch(() => props.showLineNumbers, scheduleLineNumberUpdate)
watch(() => props.readonly, (value) => crepe?.setReadonly(Boolean(value)))
watch([searchText, matchCase, wholeWord, useRegex, selectionOnly], updateSearchMatches)
watch(replaceOpen, () => nextTick(() => (replaceOpen.value ? replaceInput.value : findInput.value)?.focus({ preventScroll: true })))

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

function onCompositionStart(): void {
  emit('compositionChange', true)
}

function onCompositionEnd(): void {
  emit('compositionChange', false)
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

function keepCursorAboveBottom(): void {
  cursorUpdateFrame = 0
  if (!editorView || !shell.value || !editorView.hasFocus()) return
  const cursor = editorView.coordsAtPos(editorView.state.selection.head)
  const bounds = shell.value.getBoundingClientRect()
  const safeBottom = bounds.bottom - localFontSize * 1.78 * 8
  if (cursor.bottom > safeBottom) shell.value.scrollTop += cursor.bottom - safeBottom
}

function scheduleLineNumberUpdate(): void {
  if (lineUpdateFrame) cancelAnimationFrame(lineUpdateFrame)
  lineUpdateFrame = requestAnimationFrame(updateLineNumbers)
}

function updateLineNumbers(): void {
  lineUpdateFrame = 0
  if (!props.showLineNumbers || !editorView || !shell.value) {
    lineMarkers.value = []
    return
  }

  const shellBounds = shell.value.getBoundingClientRect()
  let label = 1
  const markers: LineMarker[] = []
  editorView.state.doc.descendants((node, position) => {
    if (!node.isTextblock) return true
    const dom = editorView?.nodeDOM(position)
    if (!(dom instanceof HTMLElement)) return true
    const bounds = dom.getBoundingClientRect()
    if (bounds.height <= 0) return true
    markers.push({
      top: bounds.top - shellBounds.top + shell.value!.scrollTop,
      height: bounds.height,
      label: label++
    })
    return true
  })
  lineMarkers.value = markers
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
  if (!editorView) return
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
    scheduleLineNumberUpdate()
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
  scheduleLineNumberUpdate()
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

defineExpose({ focus, openSearch, replaceRange, undoOnce, redoOnce, setScrollRatio })
</script>

<template>
  <div
    ref="shell"
    class="milkdown-editor-shell"
    :class="{
      'is-readonly': readonly,
      'has-line-numbers': showLineNumbers,
      'has-find-widget': searchOpen,
      'has-replace-widget': searchOpen && replaceOpen
    }"
    :style="{ '--milkdown-font-size': `${fontSize}px` }"
  >
    <div v-if="showLineNumbers" class="milkdown-line-numbers" aria-hidden="true">
      <span v-for="marker in lineMarkers" :key="`${marker.label}-${marker.top}`" :style="{ top: `${marker.top}px`, height: `${marker.height}px` }">{{ marker.label }}</span>
    </div>

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
</template>
