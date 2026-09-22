/**
 * 文件夹面板：列出当前本地文件文稿所在目录的同级 TXT / Markdown 文件，
 * 点击即在当前窗口作为新标签打开，交互参考 Typora 的左侧文件区。
 * 只做展示与选择，打开后的标签状态由 App.vue 维护。
 */
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { FileText, Folder, RefreshCw, X } from '@lucide/vue'
import type { LocalFileEntry } from '../../../shared/types'

const props = defineProps<{
  /** 当前文稿 ID；主进程据此定位文件所在目录 */
  draftId: string
}>()

const emit = defineEmits<{
  close: []
  select: [path: string]
}>()

const loading = ref(false)
const directory = ref('')
const entries = ref<LocalFileEntry[]>([])
const errorMessage = ref('')

/** 标题只显示最后一级目录名，完整路径放在 title 里。 */
const directoryName = computed(() => {
  const parts = directory.value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? '文件夹'
})

async function load(): Promise<void> {
  if (!props.draftId) return
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await window.sheepText.listDirectoryFiles(props.draftId)
    directory.value = result.directory
    entries.value = result.entries
  } catch (error) {
    directory.value = ''
    entries.value = []
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)

// 切换文稿时原地刷新列表（不重建组件）：目录可能已经变了，
// 重建会走 Transition 动画，旧面板会在 DOM 里残留一小段时间。
watch(() => props.draftId, () => { void load() })

// 面板已展开时再次悬停（例如刚在资源管理器里新建了文件）也能重新读目录
defineExpose({ refresh: load })
</script>

<template>
  <div class="folder-panel" :data-draft-id="draftId">
    <header class="folder-panel-header">
      <Folder :size="13" />
      <span class="folder-panel-title" :title="directory || '未读取到目录'">{{ directoryName }}</span>
      <button type="button" class="folder-panel-icon" title="刷新列表" :disabled="loading" @click="load"><RefreshCw :size="12" /></button>
      <button type="button" class="folder-panel-icon" title="关闭（Esc）" @click="emit('close')"><X :size="13" /></button>
    </header>
    <div class="folder-panel-body">
      <p v-if="loading && !entries.length" class="folder-panel-empty">正在读取目录…</p>
      <p v-else-if="errorMessage" class="folder-panel-empty">{{ errorMessage }}</p>
      <p v-else-if="!entries.length" class="folder-panel-empty">该目录下没有 TXT / Markdown 文件</p>
      <button
        v-for="entry in entries"
        :key="entry.path"
        type="button"
        class="folder-panel-item"
        :class="{ 'is-current': entry.isCurrent }"
        :disabled="entry.isCurrent"
        :title="entry.isCurrent ? entry.path + '（当前文稿）' : entry.path"
        @click="emit('select', entry.path)"
      >
        <FileText :size="13" />
        <span class="folder-panel-name">{{ entry.name }}</span>
      </button>
    </div>
  </div>
</template>