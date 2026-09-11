<script setup lang="ts">
withDefaults(defineProps<{
  active?: boolean
  danger?: boolean
  disabled?: boolean
  title: string
  size?: 'sm' | 'md'
}>(), {
  active: false,
  danger: false,
  disabled: false,
  size: 'md'
})
</script>

<template>
  <button
    type="button"
    class="icon-button"
    :class="[`is-${size}`, { 'is-active': active, 'is-danger': danger }]"
    :disabled="disabled"
    :title="title"
    :aria-label="title"
  >
    <slot />
  </button>
</template>
