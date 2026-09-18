<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export type SelectOption = {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string | null
  options: SelectOption[]
  label?: string
  placeholder?: string
  compact?: boolean
  disabled?: boolean
  /** 选项较多时（如系统字体列表）开启搜索过滤 */
  searchable?: boolean
  searchPlaceholder?: string
}>(), {
  placeholder: '请选择',
  compact: false,
  disabled: false,
  searchable: false,
  searchPlaceholder: '输入关键字筛选'
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  open: [value: boolean]
}>()

const root = ref<HTMLElement | null>(null)
const popover = ref<HTMLElement | null>(null)
const open = ref(false)
const opensUp = ref(false)
const selected = computed(() => props.options.find((option) => option.value === props.modelValue))
const keyword = ref('')
const filteredOptions = computed(() => {
  if (!props.searchable) return props.options
  const needle = keyword.value.trim().toLowerCase()
  if (!needle) return props.options
  return props.options.filter((option) =>
    option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle)
  )
})
const searchInput = ref<HTMLInputElement | null>(null)

function onSearchKeydown(event: KeyboardEvent): void {
  // 回车选中当前唯一可见项，方便键盘快速确认
  if (event.key === 'Enter' && filteredOptions.value.length === 1) {
    event.preventDefault()
    select(filteredOptions.value[0])
  }
}

function closePopover(): void {
  open.value = false
  opensUp.value = false
  keyword.value = ''
  emit('open', false)
}

async function openPopover(): Promise<void> {
  open.value = true
  opensUp.value = false
  emit('open', true)
  await nextTick()

  const rootElement = root.value
  const popoverElement = popover.value
  const scrollHost = rootElement?.closest<HTMLElement>('.settings-scroll, .model-form-scroll')
  if (!rootElement || !popoverElement || !scrollHost) return

  const edgeGap = 12
  const popupHeight = Math.min(popoverElement.scrollHeight, 290)
  let hostRect = scrollHost.getBoundingClientRect()
  let triggerRect = rootElement.getBoundingClientRect()
  const missingBelow = popupHeight + 7 - (hostRect.bottom - triggerRect.bottom - edgeGap)
  const scrollRemaining = scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight

  if (missingBelow > 0 && scrollRemaining > 0) {
    scrollHost.scrollTop += Math.min(missingBelow + 8, scrollRemaining)
    hostRect = scrollHost.getBoundingClientRect()
    triggerRect = rootElement.getBoundingClientRect()
  }

  const spaceBelow = hostRect.bottom - triggerRect.bottom - edgeGap
  const spaceAbove = triggerRect.top - hostRect.top - edgeGap
  opensUp.value = spaceBelow < popupHeight + 7 && spaceAbove > spaceBelow
  await nextTick()
  popoverElement.querySelector<HTMLElement>('.select-option.is-selected')?.scrollIntoView({ block: 'nearest' })
}

function toggle(): void {
  if (props.disabled) return
  if (open.value) closePopover()
  else void openPopover()
}

function select(option: SelectOption): void {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  closePopover()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) {
    closePopover()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    closePopover()
  }
}

// 开启搜索时，弹出后自动聚焦筛选框
watch(open, async (value) => {
  if (!value || !props.searchable) return
  await nextTick()
  searchInput.value?.focus()
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="base-select" :class="{ 'is-open': open, 'is-compact': compact, 'opens-up': opensUp }">
    <button
      type="button"
      class="select-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <span v-if="label" class="select-prefix">{{ label }}</span>
      <span class="select-value" :class="{ 'is-placeholder': !selected }">{{ selected?.label || placeholder }}</span>
      <ChevronDown :size="15" class="select-chevron" />
    </button>
    <Transition name="popover">
      <div v-if="open" ref="popover" class="select-popover" role="listbox">
        <div v-if="searchable" class="select-search">
          <input
            ref="searchInput"
            v-model="keyword"
            type="text"
            :placeholder="searchPlaceholder"
            spellcheck="false"
            @keydown="onSearchKeydown"
          >
        </div>
        <button
          v-for="option in filteredOptions"
          :key="option.value"
          type="button"
          class="select-option"
          :class="{ 'is-selected': option.value === modelValue }"
          :disabled="option.disabled"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="select(option)"
        >
          <span class="option-copy">
            <strong>{{ option.label }}</strong>
            <small v-if="option.description">{{ option.description }}</small>
          </span>
          <Check v-if="option.value === modelValue" :size="16" />
        </button>
        <p v-if="searchable && !filteredOptions.length" class="select-empty">没有匹配的选项</p>
        <slot name="footer" />
      </div>
    </Transition>
  </div>
</template>
