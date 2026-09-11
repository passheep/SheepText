<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  loading?: boolean
  title?: string
  type?: 'button' | 'submit'
}>(), {
  variant: 'secondary',
  size: 'md',
  disabled: false,
  loading: false,
  type: 'button'
})
</script>

<template>
  <button
    :type="type"
    class="base-button"
    :class="[`is-${variant}`, `is-${size}`, { 'is-loading': loading }]"
    :disabled="disabled || loading"
    :title="title"
  >
    <span v-if="loading" class="button-spinner" aria-hidden="true" />
    <span v-else-if="$slots.icon" class="button-icon"><slot name="icon" /></span>
    <span v-if="$slots.default" class="button-label"><slot /></span>
    <span v-if="$slots.trailing" class="button-trailing"><slot name="trailing" /></span>
  </button>
</template>
