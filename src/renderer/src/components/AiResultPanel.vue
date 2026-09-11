<script setup lang="ts">
import { AlertTriangle, Check, Clipboard, LoaderCircle, RefreshCw, Sparkles, X } from '@lucide/vue'
import type { DisplayMode } from '../../../shared/types'
import BaseButton from './BaseButton.vue'
import IconButton from './IconButton.vue'
import MarkdownPreview from './MarkdownPreview.vue'

defineProps<{
  open: boolean
  loading: boolean
  result: string
  error: string
  conflict: boolean
  rangeLabel: string
  modelName: string
  durationMs: number
  displayMode: DisplayMode
}>()

const emit = defineEmits<{
  adopt: []
  regenerate: []
  copy: []
  discard: []
  cancel: []
}>()
</script>

<template>
  <Transition name="result-panel">
    <section v-if="open" class="ai-result-panel">
      <div class="result-grip" />
      <header class="result-header">
        <div class="result-title">
          <span class="result-icon"><Sparkles :size="18" /></span>
          <div>
            <strong>{{ loading ? 'AI 正在整理文字' : error ? '本次生成未完成' : '改写结果已就绪' }}</strong>
            <span>{{ rangeLabel }}<template v-if="modelName"> · {{ modelName }}</template><template v-if="durationMs"> · {{ (durationMs / 1000).toFixed(1) }} 秒</template></span>
          </div>
        </div>
        <IconButton title="关闭结果" size="sm" @click="emit('discard')"><X :size="17" /></IconButton>
      </header>

      <div v-if="loading" class="result-loading">
        <span class="ai-pulse"><LoaderCircle :size="25" class="spin" /></span>
        <div><strong>正在生成更清晰的表达…</strong><p>原文会保持不变，完成后由你决定是否采用。</p></div>
      </div>

      <div v-else-if="error" class="result-error">
        <AlertTriangle :size="20" />
        <div><strong>没有改动原文</strong><p>{{ error }}</p></div>
      </div>

      <template v-else>
        <div v-if="conflict" class="conflict-banner">
          <AlertTriangle :size="17" />
          <span>生成期间文稿已发生变化。为避免覆盖新内容，本结果只能复制，或基于当前内容重新生成。</span>
        </div>
        <div class="result-content">
          <MarkdownPreview v-if="displayMode === 'markdown'" :content="result" empty-text="模型没有返回内容" />
          <pre v-else>{{ result }}</pre>
        </div>
      </template>

      <footer class="result-actions">
        <BaseButton v-if="loading" variant="ghost" @click="emit('cancel')"><template #icon><X :size="16" /></template>取消请求</BaseButton>
        <template v-else>
          <BaseButton v-if="!error" variant="primary" :disabled="conflict" @click="emit('adopt')"><template #icon><Check :size="16" /></template>采用</BaseButton>
          <BaseButton variant="secondary" @click="emit('regenerate')"><template #icon><RefreshCw :size="16" /></template>{{ conflict ? '基于当前重试' : '再生成' }}</BaseButton>
          <BaseButton v-if="!error" variant="ghost" @click="emit('copy')"><template #icon><Clipboard :size="16" /></template>复制结果</BaseButton>
          <BaseButton variant="ghost" @click="emit('discard')">放弃</BaseButton>
        </template>
      </footer>
    </section>
  </Transition>
</template>
