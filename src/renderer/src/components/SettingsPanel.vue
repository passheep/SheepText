<script setup lang="ts">
import {
  Archive, Bot, CheckCircle2, CircleHelp, Database, Download, HardDrive, Keyboard,
  KeyRound, MonitorCog, Palette, Plus, RotateCcw, Save, ShieldCheck, SlidersHorizontal,
  Sparkles, Trash2, X
} from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'
import type { AppSettings, ModelConfigInput, ModelConfigPublic, StorageInfo, ToastPayload } from '../../../shared/types'
import BaseButton from './BaseButton.vue'
import BaseSelect, { type SelectOption } from './BaseSelect.vue'
import IconButton from './IconButton.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import appIcon from '../assets/app-icon.png'

type SettingsTab = 'general' | 'models' | 'shortcuts' | 'storage' | 'about'

const props = defineProps<{
  open: boolean
  settings: AppSettings
  models: ModelConfigPublic[]
  appVersion: string
  encryptionAvailable: boolean
  windowId: string
  initialTab?: SettingsTab
}>()

const emit = defineEmits<{
  close: []
  settingsChanged: [settings: AppSettings]
  modelsChanged: [models: ModelConfigPublic[]]
  toast: [payload: ToastPayload]
}>()

const activeTab = ref<SettingsTab>('general')
const settingsDraft = reactive<AppSettings>({ ...props.settings })
const modelsDraft = ref<ModelConfigPublic[]>([...props.models])
const selectedModelId = ref<string | null>(null)
const editingModel = ref<ModelConfigInput | null>(null)
const savingSettings = ref(false)
const savingModel = ref(false)
const testKind = ref<'connection' | 'generation' | null>(null)
const testMessage = ref('')
const pendingDeleteId = ref<string | null>(null)
const storageInfo = ref<StorageInfo | null>(null)
const storageLoading = ref(false)
const storageAction = ref<'backup' | 'export' | null>(null)

const themeOptions: SelectOption[] = [
  { value: 'system', label: '跟随系统', description: '自动匹配 Windows 明暗主题' },
  { value: 'light', label: '浅色', description: '明亮、舒适的纸张质感' },
  { value: 'dark', label: '深色', description: '低亮度环境下更舒适' }
]
const themeColorPresets = [
  { value: '#6958cf', label: '薰衣草紫' }, { value: '#1f56f5', label: '晴空蓝' },
  { value: '#0f9f8f', label: '薄荷青' }, { value: '#e67e22', label: '暖橙' },
  { value: '#d14d72', label: '玫瑰红' }, { value: '#5b6b8c', label: '雾霾蓝' }
]
const displayModeOptions: SelectOption[] = [
  { value: 'txt', label: 'TXT', description: '纯文本格式，兼容性最好' },
  { value: 'markdown', label: 'Markdown', description: '支持标题、列表和代码块' }
]
const editorBackgroundOptions: SelectOption[] = [
  { value: 'auto', label: '跟随界面', description: '自动匹配当前明暗主题' },
  { value: 'white', label: '纯白', description: '干净明亮的白色画布' },
  { value: 'black', label: '纯黑', description: '低亮度的黑色沉浸画布' },
  { value: 'eye-care', label: '护眼绿', description: '柔和低饱和绿色' },
  { value: 'paper', label: '纸张', description: '温暖自然的米白纸张' },
  { value: 'kraft', label: '牛皮纸', description: '复古温暖的棕黄色纸面' }
]
const editorPatternOptions: SelectOption[] = [
  { value: 'none', label: '无纹理', description: '保持纯色背景' },
  { value: 'grid-large', label: '大方格', description: '适合结构化草稿' },
  { value: 'grid-small', label: '小方格', description: '更细密的网格辅助' },
  { value: 'lines', label: '横线', description: '接近横格纸的书写感' },
  { value: 'waves', label: '波浪线', description: '柔和的装饰性纹理' }
]
const sceneOptions: SelectOption[] = [
  { value: 'general', label: '通用', description: '日常说明、计划与对话' },
  { value: 'coding', label: '编程', description: '需求、错误描述与代码任务' },
  { value: 'image', label: '生图', description: '主体、构图、光线与风格' }
]
const providerOptions: SelectOption[] = [
  { value: 'deepseek', label: 'DeepSeek' }, { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI 兼容服务' }
]
const protocolOptions: SelectOption[] = [
  { value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses API' }
]
const reasoningOptions: SelectOption[] = [
  { value: 'off', label: '关闭 / 默认' }, { value: 'low', label: '低' },
  { value: 'medium', label: '中' }, { value: 'high', label: '高' }
]
const defaultModelOptions = computed<SelectOption[]>(() => [
  { value: '__none__', label: '不设默认模型' },
  ...modelsDraft.value.map((model) => ({ value: model.id, label: model.name, description: model.modelId }))
])

watch(() => props.open, (open) => {
  if (!open) return
  Object.assign(settingsDraft, props.settings)
  modelsDraft.value = [...props.models]
  setActiveTab(props.initialTab ?? 'general')
})
watch(() => props.models, (models) => { modelsDraft.value = [...models] }, { deep: true })
watch(() => props.settings, (settings) => Object.assign(settingsDraft, settings), { deep: true })

function setActiveTab(tab: SettingsTab): void {
  activeTab.value = tab
  if (tab === 'models' && !editingModel.value) {
    if (modelsDraft.value[0]) selectModel(modelsDraft.value[0].id)
    else newModel()
  }
  if (tab === 'storage') void loadStorageInfo()
}

function selectModel(id: string): void {
  const model = modelsDraft.value.find((item) => item.id === id)
  if (!model) return
  selectedModelId.value = id
  editingModel.value = { ...model, apiKey: '' }
  testMessage.value = ''
  pendingDeleteId.value = null
}

function newModel(): void {
  selectedModelId.value = null
  editingModel.value = {
    id: '', name: 'DeepSeek 日常', provider: 'deepseek', apiProtocol: 'chat-completions',
    baseUrl: 'https://api.deepseek.com', apiKey: '', modelId: 'deepseek-v4-flash',
    timeoutMs: 60_000, maxTokens: 12800, temperature: null, reasoningEffort: 'off',
    isDefault: modelsDraft.value.length === 0
  }
  testMessage.value = ''
}

function applyProviderPreset(value: string): void {
  if (!editingModel.value) return
  editingModel.value.provider = value as ModelConfigInput['provider']
  if (value === 'deepseek') {
    editingModel.value.baseUrl = 'https://api.deepseek.com'
    editingModel.value.apiProtocol = 'chat-completions'
    if (!editingModel.value.modelId || editingModel.value.modelId.startsWith('gpt-')) editingModel.value.modelId = 'deepseek-v4-flash'
  } else if (value === 'openai') {
    editingModel.value.baseUrl = 'https://api.openai.com/v1'
    editingModel.value.apiProtocol = 'responses'
    if (!editingModel.value.modelId || editingModel.value.modelId.startsWith('deepseek-')) editingModel.value.modelId = 'gpt-5-mini'
  }
}

function createModelSnapshot(): ModelConfigInput {
  const source = editingModel.value
  if (!source) throw new Error('请先选择一个模型配置')
  return {
    id: String(source.id ?? ''), name: String(source.name ?? ''), provider: source.provider,
    apiProtocol: source.apiProtocol, baseUrl: String(source.baseUrl ?? ''), apiKey: source.apiKey ?? '',
    modelId: String(source.modelId ?? ''), timeoutMs: Number(source.timeoutMs), maxTokens: Number(source.maxTokens),
    temperature: source.temperature === null || source.temperature === undefined ? null : Number(source.temperature),
    reasoningEffort: source.reasoningEffort, isDefault: Boolean(source.isDefault)
  }
}

async function saveSettings(): Promise<void> {
  savingSettings.value = true
  try {
    const payload = { ...settingsDraft, hideAfterCopy: false, defaultModelConfigId: settingsDraft.defaultModelConfigId === '__none__' ? null : settingsDraft.defaultModelConfigId }
    const saved = await window.sheepText.saveSettings(payload)
    Object.assign(settingsDraft, saved)
    emit('settingsChanged', saved)
    emit('toast', { type: 'success', message: '偏好设置已保存并立即生效' })
  } catch (error) { emit('toast', { type: 'error', message: cleanError(error) }) }
  finally { savingSettings.value = false }
}

async function saveModel(): Promise<void> {
  if (!editingModel.value) return
  if (!editingModel.value.name.trim() || !editingModel.value.baseUrl.trim() || !editingModel.value.modelId.trim()) {
    emit('toast', { type: 'warning', message: '请填写配置名称、Base URL 和 Model ID' }); return
  }
  savingModel.value = true
  try {
    const models = await window.sheepText.saveModel(createModelSnapshot())
    modelsDraft.value = models; emit('modelsChanged', models)
    const selected = models.find((item) => item.id === editingModel.value?.id)
      ?? models.find((item) => item.name === editingModel.value?.name && item.modelId === editingModel.value?.modelId) ?? models[0]
    if (selected) selectModel(selected.id)
    emit('toast', { type: 'success', message: '模型配置已安全保存' })
  } catch (error) { emit('toast', { type: 'error', message: cleanError(error) }) }
  finally { savingModel.value = false }
}

async function testModel(kind: 'connection' | 'generation'): Promise<void> {
  if (!editingModel.value) return
  testKind.value = kind; testMessage.value = ''
  try {
    const result = await window.sheepText.testModel(createModelSnapshot(), kind)
    testMessage.value = `${result.message} · ${result.durationMs} ms`
  } catch (error) { testMessage.value = cleanError(error) }
  finally { testKind.value = null }
}

async function deleteModel(id: string): Promise<void> {
  try {
    const models = await window.sheepText.deleteModel(id)
    modelsDraft.value = models; emit('modelsChanged', models); pendingDeleteId.value = null
    if (models[0]) selectModel(models[0].id)
    else { selectedModelId.value = null; editingModel.value = null }
    emit('toast', { type: 'success', message: '模型配置已移除，文稿内容未受影响' })
  } catch (error) { emit('toast', { type: 'error', message: cleanError(error) }) }
}

async function loadStorageInfo(): Promise<void> {
  storageLoading.value = true
  try { storageInfo.value = await window.sheepText.getStorageInfo() }
  catch (error) { emit('toast', { type: 'error', message: '读取存储信息失败：' + cleanError(error) }) }
  finally { storageLoading.value = false }
}

async function backupData(): Promise<void> {
  storageAction.value = 'backup'
  try {
    const result = await window.sheepText.backupData()
    if (!result.canceled) emit('toast', { type: 'success', message: `备份已保存到 ${result.filePath}` })
  } catch (error) { emit('toast', { type: 'error', message: '备份失败：' + cleanError(error) }) }
  finally { storageAction.value = null }
}

async function exportData(): Promise<void> {
  storageAction.value = 'export'
  try {
    const result = await window.sheepText.exportData()
    if (!result.canceled) emit('toast', { type: 'success', message: `数据已导出到 ${result.filePath}` })
  } catch (error) { emit('toast', { type: 'error', message: '导出失败：' + cleanError(error) }) }
  finally { storageAction.value = null }
}

async function resetWindowSize(): Promise<void> {
  await window.sheepText.windowAction(props.windowId, 'reset-size')
  emit('toast', { type: 'success', message: '窗口已恢复为当前屏幕的合适大小' })
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  if (/could not be cloned|DataCloneError|structured clone/i.test(cleaned)) return '配置内容无法提交，请检查输入项后再试。'
  return cleaned
}
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="settings-backdrop" @mousedown.self="emit('close')">
      <section class="settings-panel" role="dialog" aria-modal="true" aria-label="SheepText 设置">
        <header class="settings-header">
          <div><span class="eyebrow">SETTINGS</span><h2>让 SheepText 更顺手</h2></div>
          <IconButton title="关闭设置" @click="emit('close')"><X :size="18" /></IconButton>
        </header>

        <div class="settings-layout">
          <nav class="settings-nav">
            <button :class="{ active: activeTab === 'general' }" @click="setActiveTab('general')"><SlidersHorizontal :size="18" /><span>外观与行为</span></button>
            <button :class="{ active: activeTab === 'models' }" @click="setActiveTab('models')"><Bot :size="18" /><span>模型配置</span><b>{{ modelsDraft.length }}</b></button>
            <button :class="{ active: activeTab === 'shortcuts' }" @click="setActiveTab('shortcuts')"><Keyboard :size="18" /><span>快捷键</span></button>
            <button :class="{ active: activeTab === 'storage' }" @click="setActiveTab('storage')"><Database :size="18" /><span>数据存储</span></button>
            <button :class="{ active: activeTab === 'about' }" @click="setActiveTab('about')"><CircleHelp :size="18" /><span>关于</span></button>
          </nav>

          <div class="settings-content">
            <div v-if="activeTab === 'general'" class="settings-page">
              <div class="settings-scroll">
                <section class="settings-section compact-section">
                  <div class="section-title"><SlidersHorizontal :size="19" /><div><h3>默认设置</h3><p>新建文稿时自动采用以下场景、模型和编辑格式。</p></div></div>
                  <div class="settings-grid">
                    <label class="field-block"><span>默认 AI 场景</span><BaseSelect v-model="settingsDraft.defaultScene" :options="sceneOptions" /></label>
                    <label class="field-block"><span>默认模型</span><BaseSelect v-model="settingsDraft.defaultModelConfigId" :options="defaultModelOptions" placeholder="不设默认模型" /></label>
                    <label class="field-block"><span>新建文稿默认格式</span><BaseSelect v-model="settingsDraft.defaultDisplayMode" :options="displayModeOptions" /></label>
                  </div>
                </section>

                <section class="settings-section">
                  <div class="section-title"><Palette :size="19" /><div><h3>外观</h3><p>保持舒适的阅读节奏和清晰的信息层级。</p></div></div>
                  <div class="settings-grid">
                    <label class="field-block"><span>界面主题</span><BaseSelect v-model="settingsDraft.theme" :options="themeOptions" /></label>
                    <label class="field-block"><span>编辑字号</span><div class="range-field"><input v-model.number="settingsDraft.fontSize" type="range" min="13" max="26" /><strong>{{ settingsDraft.fontSize }} px</strong></div></label>
                    <label class="field-block"><span>编辑背景</span><BaseSelect v-model="settingsDraft.editorBackground" :options="editorBackgroundOptions" /></label>
                    <label class="field-block"><span>背景纹理</span><BaseSelect v-model="settingsDraft.editorPattern" :options="editorPatternOptions" /></label>
                    <div class="field-block full"><span>主题色</span><div class="theme-color-picker">
                      <button v-for="color in themeColorPresets" :key="color.value" type="button" class="theme-swatch" :class="{ active: settingsDraft.themeColor === color.value }" :title="color.label" :style="{ backgroundColor: color.value }" @click="settingsDraft.themeColor = color.value" />
                      <label class="custom-color-swatch" title="自定义主题色"><input v-model="settingsDraft.themeColor" type="color" /><span>自定义</span></label><code>{{ settingsDraft.themeColor }}</code>
                    </div></div>
                  </div>
                </section>

                <section class="settings-section">
                  <div class="section-title"><MonitorCog :size="19" /><div><h3>桌面行为</h3><p>应用始终保留托盘入口，窗口行为由你决定。</p></div></div>
                  <div class="setting-rows">
                    <label class="setting-row"><span><strong>开机自启</strong><small>默认静默进入托盘，不抢占当前应用焦点</small></span><ToggleSwitch v-model="settingsDraft.autoLaunch" /></label>
                    <label class="setting-row"><span><strong>关闭最后窗口后保留托盘</strong><small>可从托盘恢复最近文稿或新建窗口</small></span><ToggleSwitch v-model="settingsDraft.closeToTray" /></label>
                    <label class="setting-row"><span><strong>保留任务栏按钮</strong><small>关闭后从任务栏隐藏，但托盘入口仍会保留</small></span><ToggleSwitch v-model="settingsDraft.keepTaskbarButton" /></label>
                    <label class="setting-row"><span><strong>贴边收起</strong><small>任务栏所在侧不会触发，移动到固定提示条即可展开</small></span><ToggleSwitch v-model="settingsDraft.dockEnabled" /></label>
                    <label v-if="settingsDraft.keepTaskbarButton && settingsDraft.dockEnabled" class="setting-row nested-setting-row"><span><strong>贴边收起时隐藏任务栏按钮</strong><small>窗口展开后自动恢复任务栏入口</small></span><ToggleSwitch v-model="settingsDraft.hideTaskbarWhenDocked" /></label>
                    <div class="setting-row"><span><strong>重置窗口大小</strong><small>将窗口移回当前屏幕中央并恢复合适尺寸</small></span><BaseButton variant="secondary" size="sm" @click="resetWindowSize"><template #icon><RotateCcw :size="15" /></template>立即重置</BaseButton></div>
                  </div>
                </section>
              </div>
              <div class="settings-footer"><BaseButton variant="primary" :loading="savingSettings" @click="saveSettings"><template #icon><Save :size="16" /></template>保存偏好</BaseButton></div>
            </div>

            <div v-else-if="activeTab === 'models'" class="settings-page model-page">
              <div class="model-workspace">
                <aside class="model-list">
                  <div class="model-list-head"><strong>请求入口</strong><IconButton title="新增模型" size="sm" @click="newModel"><Plus :size="17" /></IconButton></div>
                  <button v-for="model in modelsDraft" :key="model.id" :class="{ active: selectedModelId === model.id }" @click="selectModel(model.id)">
                    <span class="provider-mark">{{ model.provider === 'deepseek' ? 'D' : model.provider === 'openai' ? 'O' : 'C' }}</span>
                    <span><strong>{{ model.name }}</strong><small>{{ model.modelId }}</small></span><span v-if="model.isDefault" class="mini-badge accent">默认</span>
                  </button>
                  <BaseButton variant="ghost" size="sm" class="add-model-button" @click="newModel"><template #icon><Plus :size="15" /></template>新增配置</BaseButton>
                </aside>
                <div v-if="editingModel" class="model-form">
                  <div class="model-form-title"><div><span class="eyebrow">MODEL ENDPOINT</span><h3>{{ editingModel.id ? '编辑模型配置' : '新增模型配置' }}</h3></div><span class="secure-chip" :class="{ warning: !encryptionAvailable }"><ShieldCheck :size="14" />{{ encryptionAvailable ? '系统加密保存' : '系统加密不可用' }}</span></div>
                  <div class="model-form-scroll">
                    <div class="form-grid">
                      <label class="field-block full"><span>配置名称</span><input v-model="editingModel.name" class="text-field" placeholder="如：DeepSeek 日常" /></label>
                      <label class="field-block"><span>供应商</span><BaseSelect :model-value="editingModel.provider" :options="providerOptions" @update:model-value="applyProviderPreset" /></label>
                      <label class="field-block"><span>API 协议</span><BaseSelect v-model="editingModel.apiProtocol" :options="protocolOptions" /></label>
                      <label class="field-block full"><span>Base URL</span><input v-model="editingModel.baseUrl" class="text-field mono" placeholder="https://api.example.com/v1" /></label>
                      <label class="field-block full"><span>API Key <small>{{ editingModel.id ? '留空则保持原密钥' : '' }}</small></span><input v-model="editingModel.apiKey" class="text-field mono" type="password" autocomplete="new-password" placeholder="sk-••••••••" /></label>
                      <label class="field-block full"><span>Model ID</span><input v-model="editingModel.modelId" class="text-field mono" placeholder="deepseek-chat" /></label>
                      <label class="field-block"><span>超时时间（秒）</span><input :value="editingModel.timeoutMs / 1000" class="text-field" type="number" min="5" max="300" @input="editingModel.timeoutMs = Number(($event.target as HTMLInputElement).value) * 1000" /></label>
                      <label class="field-block"><span>最大输出 Tokens</span><input v-model.number="editingModel.maxTokens" class="text-field" type="number" min="128" max="128000" /></label>
                      <label class="field-block"><span>温度（可选）</span><input v-model.number="editingModel.temperature" class="text-field" type="number" min="0" max="2" step="0.1" placeholder="使用服务默认值" /></label>
                      <label class="field-block"><span>思考强度</span><BaseSelect v-model="editingModel.reasoningEffort" :options="reasoningOptions" /></label>
                    </div>
                    <label class="setting-row inline-default"><span><strong>设为默认模型</strong><small>仅影响新建文稿，不改变其他窗口当前选择</small></span><ToggleSwitch v-model="editingModel.isDefault" /></label>
                    <div v-if="testMessage" class="test-message"><CheckCircle2 :size="16" />{{ testMessage }}</div>
                    <div v-if="pendingDeleteId === editingModel.id" class="delete-confirm"><span>确定移除此配置？文稿不会被删除。</span><BaseButton variant="danger" size="sm" @click="deleteModel(editingModel.id)">确认移除</BaseButton><BaseButton variant="ghost" size="sm" @click="pendingDeleteId = null">取消</BaseButton></div>
                  </div>
                  <div class="model-actions"><BaseButton variant="primary" :loading="savingModel" @click="saveModel"><template #icon><Save :size="16" /></template>保存配置</BaseButton><BaseButton variant="secondary" :loading="testKind === 'connection'" @click="testModel('connection')"><template #icon><KeyRound :size="15" /></template>检查认证</BaseButton><BaseButton variant="secondary" :loading="testKind === 'generation'" @click="testModel('generation')"><template #icon><Sparkles :size="15" /></template>真实生成测试</BaseButton><IconButton v-if="editingModel.id" title="移除配置" danger @click="pendingDeleteId = editingModel.id"><Trash2 :size="17" /></IconButton></div>
                </div>
                <div v-else class="model-form-empty"><Bot :size="28" /><h3>选择或新增模型配置</h3><p>没有模型时，SheepText 仍可正常编辑、保存和复制。</p><BaseButton variant="primary" @click="newModel"><template #icon><Plus :size="16" /></template>新增模型</BaseButton></div>
              </div>
            </div>

            <div v-else-if="activeTab === 'shortcuts'" class="settings-page info-page"><div class="settings-scroll"><div class="info-hero"><Keyboard :size="24" /><div><h3>键盘快捷键</h3><p>在编辑窗口内随时使用，减少鼠标操作。</p></div></div><div class="shortcut-list"><div><span>新建文稿</span><kbd>Ctrl</kbd><b>+</b><kbd>N</kbd></div><div><span>新建窗口</span><kbd>Ctrl</kbd><b>+</b><kbd>Shift</kbd><b>+</b><kbd>N</kbd></div><div><span>搜索当前文本</span><kbd>Ctrl</kbd><b>+</b><kbd>F</kbd></div><div><span>复制本行到下一行</span><kbd>Ctrl</kbd><b>+</b><kbd>D</kbd></div><div><span>撤销 / 重做</span><kbd>Ctrl</kbd><b>+</b><kbd>Z</kbd><em>/</em><kbd>Ctrl</kbd><b>+</b><kbd>Y</kbd></div><div><span>调整编辑字号</span><kbd>Ctrl</kbd><b>+</b><span>鼠标滚轮</span></div></div></div></div>

            <div v-else-if="activeTab === 'storage'" class="settings-page info-page"><div class="settings-scroll"><div class="info-hero"><HardDrive :size="24" /><div><h3>数据存储</h3><p>草稿与设置保存在本机，可随时制作备份或导出可读数据。</p></div></div><div class="storage-grid"><div class="storage-card"><span>本地存储占用</span><strong>{{ storageLoading ? '正在计算…' : storageInfo?.formattedSize ?? '—' }}</strong></div><div class="storage-card full"><span>存储位置</span><code :title="storageInfo?.path">{{ storageInfo?.path ?? '正在读取…' }}</code></div></div><div class="storage-actions"><BaseButton variant="secondary" :loading="storageAction === 'backup'" @click="backupData"><template #icon><Archive :size="16" /></template>手动备份数据库</BaseButton><BaseButton variant="secondary" :loading="storageAction === 'export'" @click="exportData"><template #icon><Download :size="16" /></template>导出数据（JSON）</BaseButton></div><p class="storage-note">数据库备份适合完整迁移；JSON 导出不包含 API Key 明文，可用于查看和长期留存。</p></div></div>

            <div v-else class="settings-page about-page"><div class="about-hero"><span class="about-logo"><img :src="appIcon" alt="SheepText" /></span><div><span class="eyebrow">SHEEPTEXT</span><h3>随手写，安心改。</h3><p>现代化的 Windows 长文本草稿与 AI 改写工具。</p></div></div><div class="about-details"><div><span>软件版本</span><strong>{{ appVersion }}</strong></div><div><span>联系 QQ</span><strong>903081605</strong></div></div></div>
          </div>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style>
.settings-content{display:flex;overflow:hidden}.settings-page{display:flex;flex-direction:column;width:100%;min-width:0;min-height:0;overflow:hidden}.settings-scroll{min-height:0;flex:1 1 auto;overflow:auto;padding:22px}.settings-footer{flex:0 0 auto;margin:0;padding:12px 20px 18px;border-top:1px solid var(--border);background:var(--surface-solid)}
.model-page{padding:0}.model-workspace{width:100%;height:100%;min-height:0;flex:1 1 auto;overflow:hidden}.model-form{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:20px}.model-form-scroll{min-height:0;flex:1 1 auto;overflow:auto;padding-right:4px}.model-actions{flex:0 0 auto;margin-top:12px;padding:12px 0 0;border-top:1px solid var(--border);background:var(--surface-solid)}
.info-page,.about-page{font-size:13px}.info-hero{display:flex;align-items:center;gap:13px;padding:16px 18px;border:1px solid var(--border);border-radius:15px;background:var(--surface)}.info-hero>svg{color:var(--primary)}.info-hero h3{margin:0 0 4px;font-size:15px}.info-hero p{margin:0;color:var(--text-secondary);font-size:12px;line-height:1.55}
.shortcut-list{display:grid;gap:9px;margin-top:16px}.shortcut-list>div{display:flex;align-items:center;gap:6px;min-height:48px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.shortcut-list>div>span:first-child{margin-right:auto;color:var(--text-primary);font-weight:650}.shortcut-list kbd{min-width:30px;padding:5px 8px;border:1px solid var(--border-strong);border-bottom-width:3px;border-radius:7px;background:var(--surface-elevated);text-align:center;font:600 11px var(--font-ui)}.shortcut-list b,.shortcut-list em{color:var(--text-tertiary);font-style:normal;font-weight:500}
.storage-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.storage-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--border);border-radius:13px;background:var(--surface)}.storage-card.full{grid-column:1/-1}.storage-card span{color:var(--text-secondary);font-size:12px}.storage-card strong{font-size:22px}.storage-card code{overflow:hidden;color:var(--text-primary);font:12px/1.5 Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.storage-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}.storage-note{color:var(--text-tertiary);font-size:11px;line-height:1.65}
.about-page{overflow:auto;padding:24px}.about-details{display:grid;gap:10px;margin-top:18px}.about-details>div{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.about-details span{color:var(--text-secondary)}.about-details strong{font-size:14px}.about-logo img{width:46px;height:46px;object-fit:contain}
.settings-panel{font-size:14px}.settings-header h2{font-size:20px}.settings-nav button{font-size:13px}.section-title h3{font-size:15px}.setting-row strong,.field-block>span{font-size:13px}.setting-row small,.section-title p{font-size:12px;line-height:1.55}.appearance-toggle{margin-top:2px}.settings-grid>.setting-row.full{grid-column:1/-1}
@media(max-width:820px){.settings-layout{grid-template-columns:60px minmax(0,1fr)}.settings-nav{align-items:center;padding-inline:8px}.settings-nav button{grid-template-columns:1fr;place-items:center;width:42px;padding:0}.settings-nav button svg{margin:0}.settings-nav button span,.settings-nav button b{display:none}}
@media(max-width:650px){.settings-scroll,.about-page{padding:14px}.settings-footer{padding:10px 14px 14px}.model-form{padding:14px}.storage-grid{grid-template-columns:1fr}}
</style>
