<script setup lang="ts">
import { AlertTriangle, Clock3, File, Folder, FolderOpen, LoaderCircle, Search, Sparkles, Trash2, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { DraftSummary } from '../../../shared/types'
import BaseButton from './BaseButton.vue'

// 在资源管理器中显示文件所在位置（F18）
function openContainingFolder(filePath: string): void {
  void window.sheepText.showItemInFolder(filePath)
}
import IconButton from './IconButton.vue'

const props = defineProps<{
  open: boolean
  items: DraftSummary[]
  search: string
  loading: boolean
  hasMore: boolean
}>()

const emit = defineEmits<{
  'update:search': [value: string]
  select: [id: string]
  delete: [id: string]
  close: []
  loadMore: []
  hold: [value: boolean]
}>()

const localSearch = ref(props.search)
const listElement = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(500)
const pendingDelete = ref<DraftSummary | null>(null)
const itemHeight = 72
const overscan = 5
const visibleStart = computed(() => Math.max(0, Math.floor(scrollTop.value / itemHeight) - overscan))
const visibleEnd = computed(() => Math.min(props.items.length, Math.ceil((scrollTop.value + viewportHeight.value) / itemHeight) + overscan))
const visibleItems = computed(() => props.items.slice(visibleStart.value, visibleEnd.value))
const virtualHeight = computed(() => props.items.length * itemHeight)
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.search, (value) => {
  if (value !== localSearch.value) localSearch.value = value
  scrollTop.value = 0
  if (listElement.value) listElement.value.scrollTop = 0
})

watch(localSearch, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => emit('update:search', value), 260)
})

watch(() => props.open, (open) => {
  if (!open) pendingDelete.value = null
})

function onScroll(event: Event): void {
  const target = event.target as HTMLElement
  scrollTop.value = target.scrollTop
  viewportHeight.value = target.clientHeight
  if (props.loading || !props.hasMore) return
  if (target.scrollHeight - target.scrollTop - target.clientHeight < 160) emit('loadMore')
}

function requestDelete(item: DraftSummary): void {
  pendingDelete.value = item
  emit('hold', true)
}

function updateHold(value: boolean): void {
  emit('hold', value || Boolean(pendingDelete.value))
}

function cancelDelete(): void {
  pendingDelete.value = null
  emit('hold', false)
}

function confirmDelete(): void {
  if (!pendingDelete.value) return
  emit('delete', pendingDelete.value.id)
  pendingDelete.value = null
  emit('hold', false)
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function fullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <Transition name="drawer">
    <aside
      v-if="open"
      class="history-drawer"
      @mouseenter="updateHold(true)"
      @mouseleave="updateHold(false)"
      @focusin="updateHold(true)"
      @focusout="updateHold(false)"
    >
      <div class="drawer-heading">
        <div>
          <span class="eyebrow">DRAFT LIBRARY</span>
          <h2>文稿历史</h2>
        </div>
        <IconButton title="关闭历史" size="sm" @click="emit('close')"><X :size="17" /></IconButton>
      </div>

      <label class="history-search">
        <Search :size="17" />
        <input v-model="localSearch" type="search" placeholder="搜索全部正文…" autocomplete="off" />
        <span v-if="localSearch" class="search-clear" @click="localSearch = ''"><X :size="14" /></span>
      </label>

      <div ref="listElement" class="history-list" @scroll="onScroll">
        <div v-if="items.length" class="history-virtual" :style="{ height: virtualHeight + 'px' }">
          <div
            v-for="(item, virtualIndex) in visibleItems"
            :key="item.id"
            class="history-item is-virtual"
            :class="{ 'is-current': item.isCurrent }"
            :style="{ top: ((visibleStart + virtualIndex) * itemHeight) + 'px' }"
          >
            <button type="button" class="history-item-open" @click="emit('select', item.id)">
              <span class="history-item-top">
                <span class="history-badges">
                  <span v-if="item.isCurrent" class="mini-badge accent">当前</span>
                  <span v-else-if="item.openWindowId" class="mini-badge">已打开</span>
                  <span class="mini-badge">{{ item.displayMode === 'markdown' ? 'MD' : 'TXT' }}</span>
                  <span v-if="item.filePath" class="mini-badge file-badge" title="本地文件文稿"><Folder :size="11" />文件</span>
                </span>
                <span class="history-summary">{{ item.summary || '空白文稿' }}</span>
                <span class="history-delete-slot" aria-hidden="true" />
              </span>
              <span v-if="item.filePath" class="history-file-path" :title="item.filePath"><File :size="12" /><span>{{ item.filePath }}</span></span>
              <span class="history-item-bottom">
                <span class="history-meta" :title="fullTime(item.updatedAt)"><Clock3 :size="12" />{{ formatTime(item.updatedAt) }}</span>
                <span class="history-item-bottom-right">
                  <span class="history-count">{{ item.characterCount.toLocaleString('zh-CN') }} 字</span>
                  <button v-if="item.filePath" type="button" class="history-open-folder" :title="item.filePath" @click.stop="openContainingFolder(item.filePath)"><FolderOpen :size="13" />打开文件夹</button>
                </span>
              </span>
            </button>
            <IconButton class="history-delete-button" title="删除文稿" size="sm" danger @click.stop="requestDelete(item)"><Trash2 :size="15" /></IconButton>
          </div>
        </div>

        <div v-if="loading" class="history-state"><LoaderCircle :size="18" class="spin" />正在加载</div>
        <div v-else-if="!items.length" class="history-empty">
          <span class="empty-orb"><Sparkles :size="21" /></span>
          <strong>{{ search ? '没有找到相关文稿' : '历史里还没有内容' }}</strong>
          <p>{{ search ? '试试搜索其他关键词。' : '输入内容并新建文稿后，旧文稿会保留在这里。' }}</p>
        </div>
        <div v-else-if="!hasMore" class="history-end">已经到底了</div>
      </div>

    </aside>
  </Transition>

  <Teleport to="body">
    <Transition name="modal">
      <div v-if="pendingDelete" class="history-delete-backdrop" @mousedown.self="cancelDelete">
          <div class="history-delete-dialog" role="alertdialog" aria-modal="true" aria-label="删除文稿确认">
            <span class="delete-warning-icon"><AlertTriangle :size="22" /></span>
            <div>
              <h3>确定删除这篇文稿？</h3>
              <p>删除后无法恢复。{{ pendingDelete.isCurrent ? '当前窗口会自动切换到新的空白文稿。' : '' }}<strong v-if="pendingDelete.filePath" class="delete-file-warning">本地文件也将一并删除：{{ pendingDelete.filePath }}</strong></p>
            </div>
            <div class="history-delete-actions">
              <BaseButton variant="ghost" size="sm" @click="cancelDelete"><template #icon><X :size="15" /></template>取消</BaseButton>
              <BaseButton variant="danger" size="sm" @click="confirmDelete"><template #icon><Trash2 :size="15" /></template>确认删除</BaseButton>
            </div>
          </div>
      </div>
    </Transition>
  </Teleport>
</template>
