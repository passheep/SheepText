<script setup lang="ts">
import { Code2, FileText, Loader2, Sparkles, X } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import { DRAFT_TITLE_MAX_LENGTH, sanitizeDraftTitle } from '../../../shared/draft-title'
import type { WindowTab } from '../../../shared/types'

const props = defineProps<{
  tabs: WindowTab[]
  activeDraftId: string
  readonly?: boolean
  /** AI 正在生成本窗口的文稿标题 */
  titleGenerating?: boolean
}>()

const emit = defineEmits<{
  select: [draftId: string]
  close: [draftId: string]
  reorder: [orderedDraftIds: string[]]
  /** 重命名普通文稿；title 为空串表示改回未命名 */
  rename: [draftId: string, title: string]
  /** 请父组件用 AI 为指定文稿生成标题 */
  generateTitle: [draftId: string]
  /** 拖拽开始/结束，用于主进程登记来源 */
  dragStart: [draftId: string]
  dragEnd: [dropped: boolean, screenX: number, screenY: number]
  /** 其他窗口的标签落到本窗口标签栏，position 为插入下标 */
  crossDrop: [position: number | null]
}>()

const listElement = ref<HTMLElement | null>(null)
// 拖动排序状态：记录被拖标签与当前落点，落点用左右指示线提示
const draggingIndex = ref(-1)
const dropIndex = ref(-1)
const dropAfter = ref(false)
// 标签重命名：仅普通文稿可用，编辑中的标签渲染成输入框
const editingDraftId = ref('')
const titleDraft = ref('')
// 输入框在 v-for 内，必须用函数式 ref：普通 ref 会被 Vue 收集成数组，focus() 会静默失效
const titleInput = ref<HTMLInputElement | null>(null)
function bindTitleInput(el: unknown): void {
  titleInput.value = (el as HTMLInputElement | null) ?? null
}

function selectTab(draftId: string): void {
  if (draftId !== props.activeDraftId) {
    emit('select', draftId)
    return
  }
  // 已选中的标签再次点击才进入重命名；未选中时这一次点击先切过去。
  // 拖动不会产生 click，所以这里天然不会与拖拽排序冲突。
  beginRename(draftId)
}

/** 普通文稿才能改名字：文件文稿的名称跟随文件名。 */
function beginRename(draftId: string): void {
  if (props.readonly || editingDraftId.value) return
  const tab = props.tabs.find((item) => item.draftId === draftId)
  if (!tab || tab.filePath) return
  editingDraftId.value = draftId
  // 初值取用户看到的那个名字，改不改都能直接提交
  titleDraft.value = tab.customTitle ?? tab.title
  void nextTick(() => {
    titleInput.value?.focus()
    titleInput.value?.select()
  })
}

/** 回车或失焦提交；标题没变就不往主进程发请求。 */
function commitTitle(): void {
  const draftId = editingDraftId.value
  if (!draftId) return
  editingDraftId.value = ''
  const tab = props.tabs.find((item) => item.draftId === draftId)
  if (!tab) return
  const next = sanitizeDraftTitle(titleDraft.value)
  const original = sanitizeDraftTitle(tab.customTitle ?? '')
  if (next === original) return
  emit('rename', draftId, next)
}

function cancelTitle(): void {
  editingDraftId.value = ''
}

function requestAiTitle(draftId: string): void {
  if (props.readonly || props.titleGenerating) return
  emit('generateTitle', draftId)
}

function closeTab(draftId: string, event?: Event): void {
  event?.stopPropagation()
  if (props.readonly) return
  emit('close', draftId)
}

// 中键关闭是标签栏的通用操作习惯
function onTabMouseDown(draftId: string, event: MouseEvent): void {
  if (event.button === 1) {
    event.preventDefault()
    closeTab(draftId)
  }
}

function onDragStart(index: number, event: DragEvent): void {
  if (props.readonly) {
    event.preventDefault()
    return
  }
  draggingIndex.value = index
  dropIndex.value = index
  dropAfter.value = false
  emit('dragStart', props.tabs[index].draftId)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 只写自定义类型：避免被其他程序当普通文本接收，从而影响“拖出成新窗口”的判定
    event.dataTransfer.setData('application/x-sheeptext-tab', props.tabs[index].draftId)
  }
}

function onDragOver(index: number, event: DragEvent): void {
  if (draggingIndex.value < 0) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const target = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropIndex.value = index
  dropAfter.value = event.clientX > target.left + target.width / 2
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  // 没有本窗口拖动来源，说明是其他窗口拖过来的标签；阻止冒泡以免正文区域再处理一次
  if (draggingIndex.value < 0) {
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const index = props.tabs.findIndex((tab) => tab.draftId === target.dataset.draftId)
    emit('crossDrop', index < 0 ? null : (event.clientX > rect.left + rect.width / 2 ? index + 1 : index))
    return
  }
  const from = draggingIndex.value
  const target = dropIndex.value
  const after = dropAfter.value
  resetDrag()
  if (from < 0 || target < 0 || from === target) return
  const order = props.tabs.map((tab) => tab.draftId)
  const [moved] = order.splice(from, 1)
  // 目标索引在移除拖动项后需要修正
  let insertAt = target + (after ? 1 : 0)
  if (from < insertAt) insertAt -= 1
  if (insertAt === from) return
  order.splice(insertAt, 0, moved)
  emit('reorder', order)
}

function resetDrag(): void {
  draggingIndex.value = -1
  dropIndex.value = -1
  dropAfter.value = false
}

// 拖拽结束：由外层判断是否落在窗口内，未落在任何窗口时拖出成新窗口
function onDragEnd(event: DragEvent): void {
  const wasLocal = draggingIndex.value >= 0
  resetDrag()
  if (!wasLocal) return
  const dropped = event.dataTransfer?.dropEffect !== 'none'
  emit('dragEnd', dropped, event.screenX, event.screenY)
}

// 标签较多时保持当前标签可见
watch(() => props.activeDraftId, async (draftId) => {
  await nextTick()
  const active = listElement.value?.querySelector<HTMLElement>('.editor-tab.is-active')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}, { immediate: true })

defineExpose({
  /** 让标签栏可以主动把当前标签滚入视野（新建标签后调用） */
  revealActive: async (): Promise<void> => {
    await nextTick()
    listElement.value?.querySelector<HTMLElement>('.editor-tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
  /** 把 AI 生成的标题填进正在编辑的输入框，由用户确认后再提交 */
  setTitleDraft: (value: string): void => {
    if (!editingDraftId.value) return
    titleDraft.value = value
    void nextTick(() => titleInput.value?.select())
  }
})
</script>

<template>
  <div ref="listElement" class="editor-tabs no-drag" role="tablist" aria-label="打开的文稿">
    <div
      v-for="(tab, index) in tabs"
      :key="tab.draftId"
      class="editor-tab"
      :class="{
        'is-active': tab.draftId === activeDraftId,
        'is-editing': editingDraftId === tab.draftId,
        'is-dragging': draggingIndex === index,
        'is-drop-before': draggingIndex >= 0 && dropIndex === index && !dropAfter && draggingIndex !== index,
        'is-drop-after': draggingIndex >= 0 && dropIndex === index && dropAfter && draggingIndex !== index
      }"
      :data-draft-id="tab.draftId"
      role="tab"
      :aria-selected="tab.draftId === activeDraftId"
      :title="tab.filePath ?? tab.title"
      :draggable="editingDraftId === tab.draftId ? 'false' : 'true'"
      @click="selectTab(tab.draftId)"
      @mousedown="onTabMouseDown(tab.draftId, $event)"
      @dragstart="onDragStart(index, $event)"
      @dragover="onDragOver(index, $event)"
      @drop="onDrop"
      @dragend="onDragEnd"
    >
      <span class="tab-icon">
        <FileText v-if="tab.filePath" :size="13" />
        <Code2 v-else-if="tab.displayMode === 'markdown'" :size="13" />
        <FileText v-else :size="13" />
      </span>
      <template v-if="editingDraftId === tab.draftId">
        <input
          :ref="bindTitleInput"
          v-model="titleDraft"
          class="tab-title-input"
          type="text"
          :maxlength="DRAFT_TITLE_MAX_LENGTH"
          placeholder="文稿名称"
          spellcheck="false"
          @click.stop
          @mousedown.stop
          @keydown.enter.prevent="commitTitle"
          @keydown.esc.prevent="cancelTitle"
          @blur="commitTitle"
        >
        <button
          class="tab-title-ai"
          type="button"
          :disabled="titleGenerating"
          title="用 AI 根据文稿内容生成名称"
          :aria-label="`用 AI 为 ${tab.title} 生成名称`"
          @click.stop="requestAiTitle(tab.draftId)"
          @mousedown.stop
        ><Loader2 v-if="titleGenerating" class="tab-title-spin" :size="12" /><Sparkles v-else :size="12" /></button>
      </template>
      <span v-else class="tab-title">{{ tab.title }}</span>
      <button
        v-if="!readonly"
        class="tab-close"
        type="button"
        :title="`关闭 ${tab.title}`"
        :aria-label="`关闭 ${tab.title}`"
        @click="closeTab(tab.draftId, $event)"
        @mousedown.stop
      ><X :size="12" /></button>
    </div>
  </div>
</template>