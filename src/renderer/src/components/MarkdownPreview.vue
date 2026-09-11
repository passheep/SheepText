<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, ref } from 'vue'

const props = defineProps<{ content: string; emptyText?: string }>()
const emit = defineEmits<{ scrollChange: [ratio: number]; taskToggle: [index: number] }>()
const preview = ref<HTMLElement | null>(null)
let syncingScroll = false

const html = computed(() => {
  const renderer = new marked.Renderer()
  let taskIndex = 0
  renderer.checkbox = ({ checked }) => {
    const index = taskIndex++
    return `<span class="md-task-checkbox${checked ? ' is-checked' : ''}" data-task-index="${index}" role="checkbox" aria-checked="${Boolean(checked)}">${checked ? '✓' : ''}</span>`
  }
  renderer.image = ({ href, title, text }) => {
    if (!href.startsWith('sheeptext-asset://local/')) return `<span class="blocked-image">[已阻止外部图片：${escapeHtml(text || '图片')}]</span>`
    const safeHref = escapeHtml(href)
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${safeHref}" alt="${escapeHtml(text || 'Markdown 图片')}"${safeTitle}>`
  }
  const parsed = marked.parse(props.content || '', { gfm: true, breaks: true, async: false, renderer }) as string
  return DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|sheeptext-asset:|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
  })
})

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] ?? character)
}

function handleScroll(): void {
  if (!preview.value || syncingScroll) return
  const maximum = preview.value.scrollHeight - preview.value.clientHeight
  emit('scrollChange', maximum > 0 ? preview.value.scrollTop / maximum : 0)
}

function setScrollRatio(ratio: number): void {
  if (!preview.value) return
  const maximum = preview.value.scrollHeight - preview.value.clientHeight
  syncingScroll = true
  preview.value.scrollTop = Math.max(0, Math.min(1, ratio)) * Math.max(0, maximum)
  requestAnimationFrame(() => { syncingScroll = false })
}

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  const task = target.closest<HTMLElement>('.md-task-checkbox')
  if (task) {
    event.preventDefault()
    const index = Number(task.dataset.taskIndex)
    if (Number.isInteger(index) && index >= 0) emit('taskToggle', index)
    return
  }
  const link = target.closest('a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href')
  if (href && /^https?:\/\//i.test(href)) void window.sheepText.openExternal(href)
}
defineExpose({ setScrollRatio })
</script>

<template>
  <article ref="preview" class="markdown-preview prose" @click="handleClick" @scroll="handleScroll">
    <div v-if="content.trim()" v-html="html" />
    <div v-else class="preview-empty">{{ emptyText || '开始输入后，这里会显示 Markdown 预览。' }}</div>
  </article>
</template>
