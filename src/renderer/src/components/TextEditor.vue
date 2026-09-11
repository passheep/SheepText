<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel,
  replaceAll, replaceNext, search, searchKeymap, selectMatches, setSearchQuery
} from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { Compartment, EditorSelection, EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration, EditorView, keymap, lineNumbers, placeholder, ViewPlugin, WidgetType,
  type DecorationSet, type Panel, type ViewUpdate
} from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DisplayMode, MarkdownViewMode, ToastPayload } from '../../../shared/types'

const props = defineProps<{
  modelValue: string
  displayMode: DisplayMode
  markdownView: MarkdownViewMode
  fontSize: number
  showLineNumbers: boolean
  draftId: string
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

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
let syncingScroll = false
let localFontSize = props.fontSize
const languageCompartment = new Compartment()
const fontCompartment = new Compartment()
const gutterCompartment = new Compartment()
const livePreviewCompartment = new Compartment()

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--md-heading)', fontWeight: '800' },
  { tag: [tags.heading2, tags.heading3, tags.heading4], color: 'var(--md-heading)', fontWeight: '700' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--md-marker)' },
  { tag: tags.punctuation, color: 'var(--text-primary)' },
  { tag: [tags.list, tags.quote], color: 'var(--text-primary)' },
  { tag: [tags.monospace, tags.string], color: 'var(--md-code)' },
  { tag: [tags.link, tags.url], color: 'var(--md-link)', textDecoration: 'underline' },
  { tag: tags.emphasis, color: 'var(--text-primary)', fontStyle: 'italic' },
  { tag: tags.strong, color: 'var(--text-primary)', fontWeight: '750' },
  { tag: tags.comment, color: 'var(--text-tertiary)' }
])

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text-primary)' },
  '.cm-scroller': { fontFamily: 'var(--font-editor)', lineHeight: 'var(--editor-line-height, 30.26px)', overflow: 'auto', padding: '28px 34px calc(1.78em * 8 + 72px)' },
  '.cm-content': { caretColor: 'var(--primary)', minHeight: '100%', maxWidth: '980px', margin: '0 auto' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-gutters': { border: '0', backgroundColor: 'transparent', color: 'var(--text-tertiary)' },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '34px', padding: '0 9px 0 4px', fontSize: '11px',
    lineHeight: 'var(--editor-line-height, 30.26px)', fontVariantNumeric: 'tabular-nums'
  },
  '.cm-placeholder': { color: 'var(--text-tertiary)', fontStyle: 'normal' }
})

class ListMarkerWidget extends WidgetType {
  constructor(private readonly label: string, private readonly ordered: boolean) { super() }
  eq(other: ListMarkerWidget): boolean { return other.label === this.label && other.ordered === this.ordered }
  toDOM(): HTMLElement {
    const marker = document.createElement('span')
    marker.className = this.ordered ? 'cm-live-list-marker is-ordered' : 'cm-live-list-marker'
    marker.textContent = this.ordered ? `${this.label}. ` : '• '
    return marker
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) { super() }
  eq(other: TaskCheckboxWidget): boolean { return other.checked === this.checked }
  toDOM(): HTMLElement {
    const checkbox = document.createElement('span')
    checkbox.className = `cm-live-task-checkbox${this.checked ? ' is-checked' : ''}`
    checkbox.setAttribute('aria-hidden', 'true')
    checkbox.textContent = this.checked ? '✓' : ''
    return checkbox
  }
}

class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'cm-live-horizontal-rule'
    return rule
  }
}

class TablePipeWidget extends WidgetType {
  toDOM(): HTMLElement {
    const divider = document.createElement('span')
    divider.className = 'cm-live-table-divider'
    divider.setAttribute('aria-hidden', 'true')
    return divider
  }
}

class BlockMenuWidget extends WidgetType {
  constructor(private readonly editorView: EditorView, private readonly lineFrom: number) { super() }
  eq(other: BlockMenuWidget): boolean { return other.lineFrom === this.lineFrom }
  toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-live-block-menu'
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'cm-live-block-trigger'
    trigger.setAttribute('aria-label', '插入 Markdown 块')
    trigger.title = '插入 Markdown 块'
    trigger.textContent = '+'
    const options = document.createElement('div')
    options.className = 'cm-live-block-options'
    const commands = [
      ['h1', '标题 1', '# '],
      ['h2', '标题 2', '## '],
      ['bullet', '项目列表', '- '],
      ['ordered', '编号列表', '1. '],
      ['quote', '引用', '> '],
      ['code', '代码块', '```\n\n```'],
      ['divider', '分隔线', '---']
    ] as const
    trigger.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      root.classList.toggle('is-open')
    })
    for (const [action, label, insert] of commands) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'cm-live-block-option'
      option.dataset.action = action
      option.textContent = label
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      option.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const state = this.editorView.state
        if (this.lineFrom > state.doc.length) return
        const line = state.doc.lineAt(this.lineFrom)
        if (line.text.trim()) return
        const cursorOffset = action === 'code' ? 4 : insert.length
        this.editorView.dispatch({
          changes: { from: line.from, to: line.to, insert },
          selection: EditorSelection.cursor(line.from + Math.min(cursorOffset, insert.length)),
          scrollIntoView: true
        })
        this.editorView.focus()
      })
      options.appendChild(option)
    }
    root.append(trigger, options)
    return root
  }
  ignoreEvent(): boolean { return false }
}

class InlineImageWidget extends WidgetType {
  constructor(private readonly source: string, private readonly alt: string) { super() }
  eq(other: InlineImageWidget): boolean { return other.source === this.source && other.alt === this.alt }
  toDOM(): HTMLElement {
    const figure = document.createElement('figure')
    figure.className = 'cm-live-image'
    const image = document.createElement('img')
    image.src = this.source
    image.alt = this.alt || 'Markdown 图片'
    image.draggable = false
    figure.appendChild(image)
    if (this.alt) {
      const caption = document.createElement('figcaption')
      caption.textContent = this.alt
      figure.appendChild(caption)
    }
    return figure
  }
  ignoreEvent(): boolean { return false }
}

function isLivePreview(): boolean {
  return props.displayMode === 'markdown' && props.markdownView === 'preview'
}

function buildLiveDecorations(editorView: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const state = editorView.state
  const activeLine = state.doc.lineAt(state.selection.main.head)
  const activeIntersects = (from: number, to: number): boolean => from <= activeLine.to && to >= activeLine.from
  const visible = (from: number, to: number): boolean => editorView.visibleRanges.some((range) => to >= range.from && from <= range.to)

  for (const viewport of editorView.visibleRanges) {
    let line = state.doc.lineAt(viewport.from)
    while (line.from <= viewport.to) {
      const source = line.text
      const isActive = line.number === activeLine.number
      const heading = source.match(/^(\s{0,3})(#{1,6})\s+/)
      const ordered = source.match(/^(\s*)(\d+)[.)]\s+/)
      const task = source.match(/^(\s*)[-+*]\s+\[([ xX])\]\s+/)
      const bullet = source.match(/^(\s*)[-+*]\s+/)
      const quote = source.match(/^(\s*)>\s?/)
      const horizontalRule = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(source)
      const tableSeparator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(source)
      const tableRow = /^\s*\|?.+\|.+\|?\s*$/.test(source)
      if (isLivePreview() && !source.trim() && line.number === activeLine.number) {
        ranges.push(Decoration.widget({ widget: new BlockMenuWidget(editorView, line.from), side: -1 }).range(line.from))
      }
      if (heading) {
        ranges.push(Decoration.line({ class: `cm-live-heading cm-live-heading-${heading[2].length}` }).range(line.from))
        if (!isActive) ranges.push(Decoration.replace({}).range(line.from + heading[1].length, line.from + heading[0].length))
      } else if (horizontalRule) {
        ranges.push(Decoration.line({ class: 'cm-live-divider-line' }).range(line.from))
        if (!isActive && line.from < line.to) ranges.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(line.from, line.to))
      } else if (task) {
        ranges.push(Decoration.line({ class: 'cm-live-task-line cm-live-list-line' }).range(line.from))
        if (!isActive) {
          const markerStart = line.from + task[1].length + task[0].indexOf('[')
          ranges.push(Decoration.replace({ widget: new TaskCheckboxWidget(task[2].toLowerCase() === 'x') }).range(markerStart, markerStart + 3))
        }
      } else if (ordered) {
        ranges.push(Decoration.line({ class: 'cm-live-list-line' }).range(line.from))
        if (!isActive) ranges.push(Decoration.replace({ widget: new ListMarkerWidget(ordered[2], true) }).range(line.from + ordered[1].length, line.from + ordered[0].length))
      } else if (bullet) {
        ranges.push(Decoration.line({ class: 'cm-live-list-line' }).range(line.from))
        if (!isActive) ranges.push(Decoration.replace({ widget: new ListMarkerWidget('', false) }).range(line.from + bullet[1].length, line.from + bullet[0].length))
      } else if (quote) {
        ranges.push(Decoration.line({ class: 'cm-live-quote-line' }).range(line.from))
        if (!isActive) ranges.push(Decoration.replace({}).range(line.from + quote[1].length, line.from + quote[0].length))
      } else if (tableSeparator) {
        ranges.push(Decoration.line({ class: 'cm-live-table-separator' }).range(line.from))
        if (!isActive && line.from < line.to) ranges.push(Decoration.replace({}).range(line.from, line.to))
      } else if (tableRow) {
        ranges.push(Decoration.line({ class: 'cm-live-table-row' }).range(line.from))
        if (!isActive) {
          for (let index = line.from; index < line.to; index += 1) {
            if (state.sliceDoc(index, index + 1) === '|') ranges.push(Decoration.replace({ widget: new TablePipeWidget() }).range(index, index + 1))
          }
        }
      }
      if (line.to >= state.doc.length) break
      line = state.doc.line(line.number + 1)
    }
  }

  syntaxTree(state).iterate({
    enter(node) {
      if (!visible(node.from, node.to)) return false
      const raw = state.sliceDoc(node.from, node.to)
      const inactive = !activeIntersects(node.from, node.to)
      if (node.name === 'Image') {
        const match = raw.match(/^!\[([^\]]*)\]\((sheeptext-asset:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)$/)
        if (inactive && match) ranges.push(Decoration.replace({ widget: new InlineImageWidget(match[2], match[1]), inclusive: false }).range(node.from, node.to))
        return false
      }
      if (node.name === 'Link') {
        const separator = raw.indexOf('](')
        if (inactive && raw.startsWith('[') && separator > 1 && raw.endsWith(')')) {
          ranges.push(Decoration.replace({}).range(node.from, node.from + 1))
          ranges.push(Decoration.mark({ class: 'cm-live-link' }).range(node.from + 1, node.from + separator))
          ranges.push(Decoration.replace({}).range(node.from + separator, node.to))
        }
        return false
      }
      if (node.name === 'StrongEmphasis' && inactive && raw.length >= 4) {
        ranges.push(Decoration.replace({}).range(node.from, node.from + 2))
        ranges.push(Decoration.mark({ class: 'cm-live-strong' }).range(node.from + 2, node.to - 2))
        ranges.push(Decoration.replace({}).range(node.to - 2, node.to))
        return false
      }
      if (node.name === 'Emphasis' && inactive && raw.length >= 2) {
        ranges.push(Decoration.replace({}).range(node.from, node.from + 1))
        ranges.push(Decoration.mark({ class: 'cm-live-emphasis' }).range(node.from + 1, node.to - 1))
        ranges.push(Decoration.replace({}).range(node.to - 1, node.to))
        return false
      }
      if (node.name === 'Strikethrough' && inactive && raw.length >= 4) {
        ranges.push(Decoration.replace({}).range(node.from, node.from + 2))
        ranges.push(Decoration.mark({ class: 'cm-live-strike' }).range(node.from + 2, node.to - 2))
        ranges.push(Decoration.replace({}).range(node.to - 2, node.to))
        return false
      }
      if (node.name === 'InlineCode' && inactive) {
        const markerLength = raw.match(/^`+/)?.[0].length ?? 1
        if (raw.length > markerLength * 2) {
          ranges.push(Decoration.replace({}).range(node.from, node.from + markerLength))
          ranges.push(Decoration.mark({ class: 'cm-live-inline-code' }).range(node.from + markerLength, node.to - markerLength))
          ranges.push(Decoration.replace({}).range(node.to - markerLength, node.to))
        }
        return false
      }
      if (node.name === 'FencedCode') {
        let line = state.doc.lineAt(node.from)
        const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
        while (line.number <= last) {
          ranges.push(Decoration.line({ class: 'cm-live-code-line' }).range(line.from))
          const fence = /^\s*(```+|~~~+)/.test(line.text)
          if (fence && line.number !== activeLine.number && line.from < line.to) ranges.push(Decoration.replace({}).range(line.from, line.to))
          if (line.number >= last || line.to >= state.doc.length) break
          line = state.doc.line(line.number + 1)
        }
        return false
      }
      return true
    }
  })
  return Decoration.set(ranges, true)
}

const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(editorView: EditorView) { this.decorations = buildLiveDecorations(editorView) }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildLiveDecorations(update.view)
  }
}, { decorations: (plugin) => plugin.decorations })

type LiveFormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'link'
type MarkupMatch = {
  kind: 'external' | 'included'
  openFrom: number
  openTo: number
  closeFrom: number
  closeTo: number
  innerText: string
}

function countCharacterBefore(state: EditorState, position: number, character: string): number {
  let count = 0
  while (position - count > 0 && state.sliceDoc(position - count - 1, position - count) === character) count += 1
  return count
}

function countCharacterAfter(state: EditorState, position: number, character: string): number {
  let count = 0
  while (position + count < state.doc.length && state.sliceDoc(position + count, position + count + 1) === character) count += 1
  return count
}

function findStarMarkup(state: EditorState, action: 'bold' | 'italic'): MarkupMatch | null {
  const selection = state.selection.main
  if (selection.empty) return null
  const removeLength = action === 'bold' ? 2 : 1
  const beforeCount = countCharacterBefore(state, selection.from, '*')
  const afterCount = countCharacterAfter(state, selection.to, '*')
  const externalActive = action === 'bold'
    ? beforeCount >= 2 && afterCount >= 2
    : beforeCount % 2 === 1 && afterCount % 2 === 1

  if (externalActive) {
    return {
      kind: 'external',
      openFrom: selection.from - removeLength,
      openTo: selection.from,
      closeFrom: selection.to,
      closeTo: selection.to + removeLength,
      innerText: state.sliceDoc(selection.from, selection.to)
    }
  }

  const selectedText = state.sliceDoc(selection.from, selection.to)
  const leadingCount = selectedText.match(/^\*+/)?.[0].length ?? 0
  const trailingCount = selectedText.match(/\*+$/)?.[0].length ?? 0
  const includedActive = action === 'bold'
    ? leadingCount >= 2 && trailingCount >= 2
    : leadingCount % 2 === 1 && trailingCount % 2 === 1
  if (!includedActive || selectedText.length <= removeLength * 2) return null

  return {
    kind: 'included',
    openFrom: selection.from,
    openTo: selection.from + removeLength,
    closeFrom: selection.to - removeLength,
    closeTo: selection.to,
    innerText: selectedText.slice(removeLength, -removeLength)
  }
}

function findSimpleMarkup(state: EditorState, marker: string): MarkupMatch | null {
  const selection = state.selection.main
  if (selection.empty) return null
  const selectedText = state.sliceDoc(selection.from, selection.to)
  if (
    selection.from >= marker.length
    && selection.to + marker.length <= state.doc.length
    && state.sliceDoc(selection.from - marker.length, selection.from) === marker
    && state.sliceDoc(selection.to, selection.to + marker.length) === marker
  ) {
    return {
      kind: 'external',
      openFrom: selection.from - marker.length,
      openTo: selection.from,
      closeFrom: selection.to,
      closeTo: selection.to + marker.length,
      innerText: selectedText
    }
  }
  if (selectedText.startsWith(marker) && selectedText.endsWith(marker) && selectedText.length > marker.length * 2) {
    return {
      kind: 'included',
      openFrom: selection.from,
      openTo: selection.from + marker.length,
      closeFrom: selection.to - marker.length,
      closeTo: selection.to,
      innerText: selectedText.slice(marker.length, -marker.length)
    }
  }
  return null
}

function findLinkMarkup(state: EditorState): MarkupMatch | null {
  const selection = state.selection.main
  if (selection.empty) return null
  const selectedText = state.sliceDoc(selection.from, selection.to)
  const included = selectedText.match(/^\[([\s\S]+)\]\(([^\n)]*)\)$/)
  if (included) {
    return {
      kind: 'included',
      openFrom: selection.from,
      openTo: selection.from + 1,
      closeFrom: selection.from + 1 + included[1].length,
      closeTo: selection.to,
      innerText: included[1]
    }
  }
  if (selection.from < 1 || state.sliceDoc(selection.from - 1, selection.from) !== '[' || state.sliceDoc(selection.to, selection.to + 2) !== '](') return null
  const line = state.doc.lineAt(selection.to)
  const closeOffset = state.sliceDoc(selection.to + 2, line.to).indexOf(')')
  if (closeOffset < 0) return null
  return {
    kind: 'external',
    openFrom: selection.from - 1,
    openTo: selection.from,
    closeFrom: selection.to,
    closeTo: selection.to + closeOffset + 3,
    innerText: selectedText
  }
}

function findSelectionMarkup(state: EditorState, action: LiveFormatAction): MarkupMatch | null {
  if (action === 'bold' || action === 'italic') return findStarMarkup(state, action)
  if (action === 'strike') return findSimpleMarkup(state, '~~')
  if (action === 'code') return findSimpleMarkup(state, '`')
  return findLinkMarkup(state)
}

function applySelectionMarkup(editorView: EditorView, action: LiveFormatAction): boolean {
  const selection = editorView.state.selection.main
  const marker = action === 'bold' ? '**' : action === 'italic' ? '*' : action === 'strike' ? '~~' : action === 'code' ? '`' : ''
  const match = selection.empty ? null : findSelectionMarkup(editorView.state, action)

  if (match) {
    const newFrom = match.kind === 'external' ? selection.from - (match.openTo - match.openFrom) : selection.from
    editorView.dispatch({
      changes: [
        { from: match.openFrom, to: match.openTo, insert: '' },
        { from: match.closeFrom, to: match.closeTo, insert: '' }
      ],
      selection: EditorSelection.range(newFrom, newFrom + match.innerText.length),
      scrollIntoView: true
    })
    editorView.focus()
    return true
  }

  if (action === 'link') {
    if (!selection.empty && editorView.state.sliceDoc(selection.from, selection.to).includes('\n')) return false
    const label = selection.empty ? '链接文字' : editorView.state.sliceDoc(selection.from, selection.to)
    const replacement = `[${label}](https://)`
    editorView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: replacement },
      selection: EditorSelection.range(selection.from + 1, selection.from + 1 + label.length),
      scrollIntoView: true
    })
    editorView.focus()
    return true
  }

  if (selection.empty) {
    editorView.dispatch({
      changes: { from: selection.from, insert: marker + marker },
      selection: EditorSelection.cursor(selection.from + marker.length),
      scrollIntoView: true
    })
  } else {
    editorView.dispatch({
      changes: [
        { from: selection.from, insert: marker },
        { from: selection.to, insert: marker }
      ],
      selection: EditorSelection.range(selection.from + marker.length, selection.to + marker.length),
      scrollIntoView: true
    })
  }
  editorView.focus()
  return true
}

class LiveSelectionToolbar {
  readonly dom: HTMLElement
  private readonly buttons = new Map<LiveFormatAction, HTMLButtonElement>()
  private refreshFrame = 0
  private readonly onViewportChange = (): void => this.scheduleRefresh()

  constructor(private readonly editorView: EditorView) {
    const toolbar = document.createElement('div')
    toolbar.className = 'cm-live-selection-toolbar'
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', 'Markdown 格式工具栏')
    this.dom = toolbar

    const actions: Array<[LiveFormatAction, string, string]> = [
      ['bold', 'B', '粗体（Ctrl + B）'],
      ['italic', 'I', '斜体（Ctrl + I）'],
      ['strike', 'S', '删除线'],
      ['code', '</>', '行内代码'],
      ['link', '↗', '插入链接（Ctrl + K）']
    ]
    actions.forEach(([action, label, title], index) => {
      if (index === actions.length - 1) {
        const divider = document.createElement('span')
        divider.className = 'cm-live-format-divider'
        toolbar.appendChild(divider)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `cm-live-format-button is-${action}`
      button.textContent = label
      button.title = title
      button.setAttribute('aria-label', title)
      button.setAttribute('aria-pressed', 'false')
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', (event) => {
        event.preventDefault()
        applySelectionMarkup(this.editorView, action)
        this.scheduleRefresh()
      })
      toolbar.appendChild(button)
      this.buttons.set(action, button)
    })

    editorView.dom.appendChild(toolbar)
    editorView.scrollDOM.addEventListener('scroll', this.onViewportChange, { passive: true })
    window.addEventListener('resize', this.onViewportChange, { passive: true })
    this.scheduleRefresh()
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.focusChanged) this.scheduleRefresh()
  }

  destroy(): void {
    if (this.refreshFrame) cancelAnimationFrame(this.refreshFrame)
    this.editorView.scrollDOM.removeEventListener('scroll', this.onViewportChange)
    window.removeEventListener('resize', this.onViewportChange)
    this.dom.remove()
  }

  private scheduleRefresh(): void {
    if (this.refreshFrame) cancelAnimationFrame(this.refreshFrame)
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = 0
      this.refresh()
    })
  }

  private refresh(): void {
    const selection = this.editorView.state.selection.main
    const selectedText = selection.empty ? '' : this.editorView.state.sliceDoc(selection.from, selection.to)
    const shouldShow = this.editorView.hasFocus && !selection.empty
    this.dom.classList.toggle('is-visible', shouldShow)
    this.dom.setAttribute('aria-hidden', shouldShow ? 'false' : 'true')
    if (!shouldShow) return

    this.buttons.forEach((button, action) => {
      const active = Boolean(findSelectionMarkup(this.editorView.state, action))
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
      button.disabled = action === 'link' && selectedText.includes('\n')
    })

    const start = this.editorView.coordsAtPos(selection.from)
    const end = this.editorView.coordsAtPos(selection.to)
    if (!start || !end) {
      this.dom.classList.remove('is-visible')
      return
    }
    const editorRect = this.editorView.dom.getBoundingClientRect()
    const toolbarRect = this.dom.getBoundingClientRect()
    const selectionLeft = Math.min(start.left, end.left)
    const selectionRight = Math.max(start.right, end.right)
    const desiredLeft = (selectionLeft + selectionRight) / 2 - editorRect.left - toolbarRect.width / 2
    const maximumLeft = Math.max(8, editorRect.width - toolbarRect.width - 8)
    const left = Math.max(8, Math.min(maximumLeft, desiredLeft))
    const selectionTop = Math.min(start.top, end.top) - editorRect.top
    const selectionBottom = Math.max(start.bottom, end.bottom) - editorRect.top
    const above = selectionTop - toolbarRect.height - 8
    const top = above >= 8 ? above : Math.min(editorRect.height - toolbarRect.height - 8, selectionBottom + 8)
    this.dom.style.left = `${Math.round(left)}px`
    this.dom.style.top = `${Math.max(8, Math.round(top))}px`
  }
}

const liveSelectionToolbarPlugin = ViewPlugin.fromClass(LiveSelectionToolbar)
const livePreviewFormatKeymap = keymap.of([
  { key: 'Mod-b', preventDefault: true, run: (editorView) => applySelectionMarkup(editorView, 'bold') },
  { key: 'Mod-i', preventDefault: true, run: (editorView) => applySelectionMarkup(editorView, 'italic') },
  { key: 'Mod-k', preventDefault: true, run: (editorView) => applySelectionMarkup(editorView, 'link') }
])

function fontExtension(size: number): Extension {
  const lineHeight = size * 1.78
  return EditorView.theme({
    '&': { '--editor-font-size': `${size}px`, '--editor-line-height': `${lineHeight}px` },
    '.cm-scroller': { fontSize: `${size}px`, lineHeight: `${lineHeight}px` }
  })
}
function languageExtension(mode: DisplayMode): Extension { return mode === 'markdown' ? markdown() : [] }
function gutterExtension(show: boolean): Extension { return show ? lineNumbers() : [] }
function previewExtension(): Extension {
  return isLivePreview()
    ? [livePreviewPlugin, liveSelectionToolbarPlugin, livePreviewFormatKeymap, EditorView.editorAttributes.of({ class: 'cm-live-preview cm-milkdown-editor' })]
    : []
}

type FindRange = { from: number; to: number }
const findHistory: string[] = []

function createFindButton(label: string, title: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  return button
}

class SheepFindPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private readonly searchInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly searchField: HTMLElement
  private readonly onWindowResize = (): void => this.syncInputWidth()
  private readonly countLabel: HTMLElement
  private readonly replaceRow: HTMLElement
  private readonly expandButton: HTMLButtonElement
  private readonly caseButton: HTMLButtonElement
  private readonly wordButton: HTMLButtonElement
  private readonly regexpButton: HTMLButtonElement
  private readonly selectionButton: HTMLButtonElement
  private readonly initialSelection: FindRange | null
  private selectionRange: FindRange | null = null
  private replaceExpanded = false
  private historyIndex = -1
  private refreshFrame = 0
  private lastQuery: SearchQuery

  constructor(private readonly editorView: EditorView) {
    const query = getSearchQuery(editorView.state)
    const initial = editorView.state.selection.main
    this.initialSelection = initial.empty ? null : { from: initial.from, to: initial.to }
    this.lastQuery = query

    const form = document.createElement('form')
    form.className = 'sheep-find-widget'
    form.addEventListener('submit', (event) => event.preventDefault())
    this.dom = form

    const searchRow = document.createElement('div')
    searchRow.className = 'sheep-find-row sheep-find-search-row'
    this.expandButton = createFindButton('›', '展开替换', 'sheep-find-expand')
    this.expandButton.addEventListener('click', () => this.toggleReplace())
    searchRow.appendChild(this.expandButton)

    const searchField = document.createElement('div')
    searchField.className = 'sheep-find-field'
    this.searchField = searchField
    this.searchInput = document.createElement('input')
    this.searchInput.name = 'search'
    this.searchInput.type = 'text'
    this.searchInput.placeholder = '查找'
    this.searchInput.autocomplete = 'off'
    this.searchInput.spellcheck = false
    this.searchInput.setAttribute('main-field', 'true')
    this.searchInput.addEventListener('input', () => this.applyQuery(true))
    this.searchInput.addEventListener('keydown', (event) => this.onSearchKeydown(event))
    searchField.appendChild(this.searchInput)

    const optionGroup = document.createElement('span')
    optionGroup.className = 'sheep-find-options'
    this.caseButton = createFindButton('Aa', '区分大小写', 'sheep-find-option')
    this.wordButton = createFindButton('ab', '全字匹配', 'sheep-find-option')
    this.regexpButton = createFindButton('.*', '使用正则表达式', 'sheep-find-option')
    this.caseButton.addEventListener('click', () => this.toggleOption('case'))
    this.wordButton.addEventListener('click', () => this.toggleOption('word'))
    this.regexpButton.addEventListener('click', () => this.toggleOption('regexp'))
    optionGroup.append(this.caseButton, this.wordButton, this.regexpButton)
    searchField.appendChild(optionGroup)
    searchRow.appendChild(searchField)

    this.selectionButton = createFindButton('▣', '仅在初始选区中查找', 'sheep-find-icon-button')
    this.selectionButton.disabled = !this.initialSelection
    this.selectionButton.addEventListener('click', () => this.toggleSelectionSearch())
    searchRow.appendChild(this.selectionButton)

    this.countLabel = document.createElement('span')
    this.countLabel.className = 'sheep-find-count'
    searchRow.appendChild(this.countLabel)

    const previousButton = createFindButton('↑', '上一个匹配项（Shift + Enter）', 'sheep-find-icon-button')
    previousButton.addEventListener('click', () => this.navigate(false))
    const nextButton = createFindButton('↓', '下一个匹配项（Enter）', 'sheep-find-icon-button')
    nextButton.addEventListener('click', () => this.navigate(true))
    const selectAllButton = createFindButton('≡', '选择所有匹配项（Alt + Enter）', 'sheep-find-icon-button')
    selectAllButton.addEventListener('click', () => { this.recordSearch(); selectMatches(this.editorView) })
    const closeButton = createFindButton('×', '关闭查找（Esc）', 'sheep-find-icon-button sheep-find-close')
    closeButton.addEventListener('click', () => this.close())
    searchRow.append(previousButton, nextButton, selectAllButton, closeButton)

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'sheep-find-row sheep-find-replace-row'
    const replaceSpacer = document.createElement('span')
    replaceSpacer.className = 'sheep-find-spacer'
    this.replaceInput = document.createElement('input')
    this.replaceInput.name = 'replace'
    this.replaceInput.type = 'text'
    this.replaceInput.placeholder = '替换'
    this.replaceInput.autocomplete = 'off'
    this.replaceInput.spellcheck = false
    this.replaceInput.addEventListener('input', () => this.applyQuery(false))
    this.replaceInput.addEventListener('keydown', (event) => this.onReplaceKeydown(event))
    const replaceButton = createFindButton('替换', '替换当前匹配项', 'sheep-find-text-button')
    replaceButton.addEventListener('click', () => { this.recordSearch(); replaceNext(this.editorView); this.scheduleCount() })
    const replaceAllButton = createFindButton('全部替换', '替换所有匹配项', 'sheep-find-text-button')
    replaceAllButton.addEventListener('click', () => { this.recordSearch(); replaceAll(this.editorView); this.scheduleCount() })
    this.replaceRow.append(replaceSpacer, this.replaceInput, replaceButton, replaceAllButton)

    form.append(searchRow, this.replaceRow)
    this.syncFromQuery(query)
  }

  mount(): void {
    this.editorView.dom.classList.add('has-find-widget')
    window.addEventListener('resize', this.onWindowResize, { passive: true })
    requestAnimationFrame(() => {
      this.syncInputWidth()
      this.syncPanelMetrics()
    })
    this.scheduleCount()
  }

  update(update: ViewUpdate): void {
    const query = getSearchQuery(update.state)
    if (!query.eq(this.lastQuery)) this.syncFromQuery(query)
    if (update.docChanged || update.selectionSet) this.scheduleCount()
  }

  destroy(): void {
    if (this.refreshFrame) cancelAnimationFrame(this.refreshFrame)
    window.removeEventListener('resize', this.onWindowResize)
    this.editorView.scrollDOM.style.removeProperty('--sheep-find-inset')
    this.editorView.dom.classList.remove('has-find-widget', 'has-replace-widget')
  }

  private syncInputWidth(): void {
    if (!this.searchField.isConnected) return
    const width = Math.floor(this.searchField.getBoundingClientRect().width)
    if (width > 0) {
      this.dom.style.setProperty('--find-field-width', `${width}px`)
      this.replaceInput.style.width = `${width}px`
      this.replaceInput.style.flex = `0 0 ${width}px`
      this.syncPanelMetrics()
    }
  }

  private syncPanelMetrics(): void {
    if (!this.dom.isConnected) return
    const height = Math.ceil(this.dom.getBoundingClientRect().height)
    if (height > 0) this.editorView.scrollDOM.style.setProperty('--sheep-find-inset', `${height + 20}px`)
  }

  private toggleReplace(force?: boolean): void {
    this.replaceExpanded = force ?? !this.replaceExpanded
    this.dom.classList.toggle('is-replacing', this.replaceExpanded)
    this.expandButton.classList.toggle('is-expanded', this.replaceExpanded)
    this.expandButton.title = this.replaceExpanded ? '收起替换' : '展开替换'
    this.editorView.dom.classList.toggle('has-replace-widget', this.replaceExpanded)
    this.syncInputWidth()
    requestAnimationFrame(() => {
      this.syncPanelMetrics()
      if (this.replaceExpanded) this.replaceInput.focus()
    })
  }

  private toggleOption(option: 'case' | 'word' | 'regexp'): void {
    const query = getSearchQuery(this.editorView.state)
    const next = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: option === 'case' ? !query.caseSensitive : query.caseSensitive,
      wholeWord: option === 'word' ? !query.wholeWord : query.wholeWord,
      regexp: option === 'regexp' ? !query.regexp : query.regexp,
      literal: query.literal,
      test: this.createSelectionFilter()
    })
    this.setQuery(next, true)
  }

  private toggleSelectionSearch(): void {
    if (this.selectionRange) this.selectionRange = null
    else if (this.initialSelection) this.selectionRange = { ...this.initialSelection }
    this.selectionButton.classList.toggle('is-active', Boolean(this.selectionRange))
    this.applyQuery(true)
  }

  private createSelectionFilter(): SearchQuery['test'] {
    if (!this.selectionRange) return undefined
    const range = { ...this.selectionRange }
    return (_match, _state, from, to) => from >= range.from && to <= range.to
  }

  private applyQuery(navigateToMatch: boolean): void {
    const current = getSearchQuery(this.editorView.state)
    const query = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: current.caseSensitive,
      wholeWord: current.wholeWord,
      regexp: current.regexp,
      literal: current.literal,
      test: this.createSelectionFilter()
    })
    this.setQuery(query, navigateToMatch)
  }

  private setQuery(query: SearchQuery, navigateToMatch: boolean): void {
    this.lastQuery = query
    this.editorView.dispatch({ effects: setSearchQuery.of(query) })
    this.syncOptionButtons(query)
    if (navigateToMatch && query.search && query.valid) findNext(this.editorView)
    this.scheduleCount()
  }

  private syncFromQuery(query: SearchQuery): void {
    this.lastQuery = query
    if (this.searchInput.value !== query.search) this.searchInput.value = query.search
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace
    this.syncOptionButtons(query)
    this.scheduleCount()
  }

  private syncOptionButtons(query: SearchQuery): void {
    this.caseButton.classList.toggle('is-active', query.caseSensitive)
    this.wordButton.classList.toggle('is-active', query.wholeWord)
    this.regexpButton.classList.toggle('is-active', query.regexp)
    this.selectionButton.classList.toggle('is-active', Boolean(this.selectionRange))
  }

  private navigate(forward: boolean): void {
    this.recordSearch()
    if (forward) findNext(this.editorView)
    else findPrevious(this.editorView)
    this.scheduleCount()
  }

  private onSearchKeydown(event: KeyboardEvent): void {
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault()
      this.recordSearch()
      selectMatches(this.editorView)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.navigate(!event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'r' || event.key.toLowerCase() === 'h')) {
      event.preventDefault()
      this.toggleReplace(true)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      this.recallHistory(event)
    }
  }

  private onReplaceKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      this.recordSearch()
      if (event.ctrlKey || event.metaKey) replaceAll(this.editorView)
      else replaceNext(this.editorView)
      this.scheduleCount()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
  }

  private recallHistory(event: KeyboardEvent): void {
    if (!findHistory.length) return
    event.preventDefault()
    if (event.key === 'ArrowUp') this.historyIndex = Math.min(findHistory.length - 1, this.historyIndex + 1)
    else this.historyIndex = Math.max(-1, this.historyIndex - 1)
    this.searchInput.value = this.historyIndex < 0 ? '' : findHistory[this.historyIndex]
    this.applyQuery(true)
  }

  private recordSearch(): void {
    const value = this.searchInput.value.trim()
    if (!value) return
    const existing = findHistory.indexOf(value)
    if (existing >= 0) findHistory.splice(existing, 1)
    findHistory.unshift(value)
    if (findHistory.length > 30) findHistory.length = 30
    this.historyIndex = -1
  }

  private scheduleCount(): void {
    if (this.refreshFrame) cancelAnimationFrame(this.refreshFrame)
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = 0
      this.refreshCount()
    })
  }

  private refreshCount(): void {
    const query = getSearchQuery(this.editorView.state)
    this.searchInput.classList.toggle('has-error', Boolean(query.search) && !query.valid)
    if (!query.search) {
      this.countLabel.textContent = '0/0'
      this.countLabel.classList.remove('is-empty')
      return
    }
    if (!query.valid) {
      this.countLabel.textContent = '表达式错误'
      this.countLabel.classList.add('is-empty')
      return
    }

    const selection = this.editorView.state.selection.main
    let total = 0
    let current = 0
    const cursor = query.getCursor(this.editorView.state)
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      total += 1
      const match = result.value
      if (match.from === selection.from && match.to === selection.to) current = total
      if (total >= 10000) break
    }
    this.countLabel.textContent = total ? `${current || 1}/${total >= 10000 ? '10000+' : total}` : '无结果'
    this.countLabel.classList.toggle('is-empty', total === 0)
  }

  private close(): void {
    this.recordSearch()
    closeSearchPanel(this.editorView)
    this.editorView.focus()
  }
}

function createFindPanel(editorView: EditorView): Panel {
  return new SheepFindPanel(editorView)
}

onMounted(() => {
  if (!host.value) return
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      EditorState.phrases.of({
        Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部',
        'match case': '区分大小写', regexp: '正则表达式', 'by word': '全字匹配',
        replace: '替换', 'replace all': '全部替换', close: '关闭'
      }),
      history(), search({ top: true, createPanel: createFindPanel }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.lineWrapping,
      placeholder('在这里输入、粘贴和整理文字……'),
      editorTheme,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(markdownHighlightStyle),
      languageCompartment.of(languageExtension(props.displayMode)),
      fontCompartment.of(fontExtension(props.fontSize)),
      gutterCompartment.of(gutterExtension(props.showLineNumbers)),
      livePreviewCompartment.of(previewExtension()),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
        if (update.docChanged || update.selectionSet) emitSelection(update.state)
        if (update.docChanged) requestAnimationFrame(() => keepCursorAboveBottom(update.view))
      }),
      EditorView.domEventHandlers({
        wheel(event) {
          if (!event.ctrlKey) return false
          event.preventDefault()
          const nextSize = Math.max(13, Math.min(26, localFontSize + (event.deltaY < 0 ? 1 : -1)))
          if (nextSize !== localFontSize) { localFontSize = nextSize; emit('fontSizeChange', nextSize) }
          return true
        },
        scroll(_event, editorView) {
          if (syncingScroll) return false
          const scroller = editorView.scrollDOM
          const maximum = scroller.scrollHeight - scroller.clientHeight
          emit('scrollChange', maximum > 0 ? scroller.scrollTop / maximum : 0)
          return false
        },
        click(event, editorView) {
          const target = event.target as HTMLElement
          if (!target.closest('.cm-live-task-checkbox')) return false
          const position = editorView.posAtCoords({ x: event.clientX, y: event.clientY })
          if (position === null) return false
          const line = editorView.state.doc.lineAt(position)
          const task = line.text.match(/^(\s*[-+*]\s+)\[([ xX])\](\s+)/)
          if (!task) return false
          const markerStart = line.from + task[1].length
          const checked = task[2].toLowerCase() === 'x'
          editorView.dispatch({
            changes: { from: markerStart, to: markerStart + 3, insert: checked ? '[ ]' : '[x]' },
            selection: EditorSelection.cursor(Math.min(editorView.state.selection.main.head, editorView.state.doc.length)),
          })
          return true
        },
        paste(event, editorView) {
          const image = props.displayMode === 'markdown'
            ? Array.from(event.clipboardData?.items ?? []).find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
            : null
          if (image) { event.preventDefault(); void pasteImage(image, editorView); return true }
          const text = event.clipboardData?.getData('text/plain')
          if (text === undefined) return false
          event.preventDefault()
          editorView.dispatch(editorView.state.replaceSelection(text))
          return true
        },
        focus() { emit('focusChange', true); return false },
        blur() { emit('focusChange', false); return false },
        compositionstart() { emit('compositionChange', true); return false },
        compositionend() { emit('compositionChange', false); return false }
      })
    ]
  })
  view = new EditorView({ state, parent: host.value })
  emitSelection(state)
})

onBeforeUnmount(() => view?.destroy())
watch(() => props.modelValue, (value) => {
  if (!view || value === view.state.doc.toString()) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: EditorSelection.cursor(Math.min(value.length, view.state.selection.main.head)) })
})
watch(() => props.displayMode, (mode) => {
  view?.dispatch({ effects: [languageCompartment.reconfigure(languageExtension(mode)), livePreviewCompartment.reconfigure(previewExtension())] })
})
watch(() => props.markdownView, () => { view?.dispatch({ effects: livePreviewCompartment.reconfigure(previewExtension()) }) })
watch(() => props.fontSize, (size) => { localFontSize = size; view?.dispatch({ effects: fontCompartment.reconfigure(fontExtension(size)) }) })
watch(() => props.showLineNumbers, (show) => { view?.dispatch({ effects: gutterCompartment.reconfigure(gutterExtension(show)) }) })

async function pasteImage(image: File, editorView: EditorView): Promise<void> {
  try {
    const bytes = new Uint8Array(await image.arrayBuffer())
    const result = await window.sheepText.savePastedImage(props.draftId, { mimeType: image.type, bytes })
    const selection = editorView.state.selection.main
    const before = selection.from > 0 ? editorView.state.sliceDoc(selection.from - 1, selection.from) : '\n'
    const after = selection.to < editorView.state.doc.length ? editorView.state.sliceDoc(selection.to, selection.to + 1) : '\n'
    const insertion = `${before === '\n' ? '' : '\n'}${result.markdown}${after === '\n' ? '' : '\n'}`
    editorView.dispatch({ changes: { from: selection.from, to: selection.to, insert: insertion }, selection: EditorSelection.cursor(selection.from + insertion.length), scrollIntoView: true })
    editorView.focus()
    emit('toast', { type: 'success', message: '图片已复制到当前文稿的独立资源目录' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit('toast', { type: 'error', message: '图片粘贴失败：' + message.replace(/^Error invoking remote method '[^']+': Error: /, '') })
  }
}

function keepCursorAboveBottom(editorView: EditorView): void {
  const cursor = editorView.coordsAtPos(editorView.state.selection.main.head)
  if (!cursor) return
  const scrollerRect = editorView.scrollDOM.getBoundingClientRect()
  const lineHeight = localFontSize * 1.78
  const safeBottom = scrollerRect.bottom - lineHeight * 8
  if (cursor.bottom > safeBottom) editorView.scrollDOM.scrollTop += cursor.bottom - safeBottom
}
function setScrollRatio(ratio: number): void {
  if (!view) return
  const scroller = view.scrollDOM
  const maximum = scroller.scrollHeight - scroller.clientHeight
  syncingScroll = true
  scroller.scrollTop = Math.max(0, Math.min(1, ratio)) * Math.max(0, maximum)
  requestAnimationFrame(() => { syncingScroll = false })
}
function emitSelection(state: EditorState): void {
  const range = state.selection.main
  emit('selectionChange', { from: range.from, to: range.to, text: state.sliceDoc(range.from, range.to) })
}
function focus(): void { view?.focus() }
function openSearch(): void { if (view) { view.focus(); openSearchPanel(view) } }
function replaceRange(from: number, to: number, text: string): void {
  if (!view) return
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), scrollIntoView: true })
  view.focus()
}
function undoOnce(): boolean { return view ? undo(view) : false }
function redoOnce(): boolean { return view ? redo(view) : false }

defineExpose({ focus, openSearch, replaceRange, undoOnce, redoOnce, setScrollRatio })
</script>

<template>
  <div ref="host" class="text-editor" />
</template>
