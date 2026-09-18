<script setup lang="ts">
import { Code2, FileText, X } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import type { WindowTab } from '../../../shared/types'

const props = defineProps<{
  tabs: WindowTab[]
  activeDraftId: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  select: [draftId: string]
  close: [draftId: string]
  reorder: [orderedDraftIds: string[]]
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

function selectTab(draftId: string): void {
  if (draftId !== props.activeDraftId) emit('select', draftId)
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
        'is-dragging': draggingIndex === index,
        'is-drop-before': draggingIndex >= 0 && dropIndex === index && !dropAfter && draggingIndex !== index,
        'is-drop-after': draggingIndex >= 0 && dropIndex === index && dropAfter && draggingIndex !== index
      }"
      :data-draft-id="tab.draftId"
      role="tab"
      :aria-selected="tab.draftId === activeDraftId"
      :title="tab.filePath ?? tab.title"
      draggable="true"
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
      <span class="tab-title">{{ tab.title }}</span>
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