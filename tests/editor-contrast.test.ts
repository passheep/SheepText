import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 编辑背景配色对比度守护测试。
 *
 * 背景：界面主题（浅/深）与编辑背景可以自由组合，每套编辑背景都自带一组文字色，
 * 一旦有人改了底色却忘了同步文字色，就会出现低对比度（例如浅色底配灰白字）。
 * 这里直接解析 styles.css 的真实取值，按 WCAG 相对亮度校验，避免靠肉眼发现。
 *
 * 门槛取值依据：
 * - 正文：7:1（WCAG AAA 常规字号）
 * - 次要 / 链接 / 行内代码：4.5:1（WCAG AA 常规字号）
 * - 标题：4.5:1（标题为大字号，AA 只要 3:1，这里取 AAA 大字号门槛）
 * - 弱化：3.5:1（查找计数、大纲层级等 9-10px 提示小字，在 AA 最低线 3:1 之上留出余量）
 */

const CSS_PATH = join(process.cwd(), 'src/renderer/src/styles.css')

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const value = hex.trim().replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb
}

function relativeLuminance([r, g, b]: Rgb): number {
  const [rl, gl, bl] = [r, g, b].map((v) => {
    const channel = v / 255
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(hexToRgb(foreground))
  const b = relativeLuminance(hexToRgb(background))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// 解析 color-mix(in srgb, A p%, B)，A 占 p 比例
function mixColors(colorA: string, colorB: string, weight: number): string {
  const a = hexToRgb(colorA)
  const b = hexToRgb(colorB)
  return (
    '#' +
    a
      .map((channel, i) => Math.round(weight * channel + (1 - weight) * b[i]).toString(16).padStart(2, '0'))
      .join('')
  )
}

function parseDeclarations(body: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const part of body.split(';')) {
    const index = part.indexOf(':')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name.startsWith('--') && value) vars[name] = value
  }
  return vars
}

// 同名变量可能被拆在多块里重复定义（如浅色主题的 --md-* 在后面的覆盖块），按出现顺序合并，后者覆盖前者
function mergeBlocks(css: string, pattern: RegExp): Record<string, string> {
  const merged: Record<string, string> = {}
  let matched = false
  for (const match of css.matchAll(pattern)) {
    Object.assign(merged, parseDeclarations(match[1]))
    matched = true
  }
  if (!matched) throw new Error('styles.css 中未找到规则：' + pattern.source)
  return merged
}

// --editor-base 可能是十六进制、var(--x) 或 color-mix(...)，统一解析成十六进制
function resolveEditorBase(value: string, vars: Record<string, string>): string {
  const raw = value.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw
  const plainVar = raw.match(/^var\((--[\w-]+)\)$/)
  if (plainVar) return vars[plainVar[1]]
  const mix = raw.match(/^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+([\d.]+)%,\s*var\((--[\w-]+)\)\)$/)
  if (mix) return mixColors(vars[mix[1]], vars[mix[3]], Number(mix[2]) / 100)
  throw new Error('无法解析的 --editor-base：' + raw)
}

const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const themes: Record<string, Record<string, string>> = {
  light: mergeBlocks(css, /:root,\[data-theme='light'\]\{([^}]*)\}/g),
  dark: mergeBlocks(css, /\[data-theme='dark'\]\{([^}]*)\}/g)
}

const backgrounds = new Map<string, Record<string, string>>()
for (const match of css.matchAll(/\.workspace\.editor-bg-([a-z-]+)\{([^}]*)\}/g)) {
  backgrounds.set(match[1], parseDeclarations(match[2]))
}

// 各角色的门槛与说明
const roles: Array<{ key: string; label: string; min: number }> = [
  { key: '--text-primary', label: '正文', min: 7 },
  { key: '--text-secondary', label: '次要文字', min: 4.5 },
  { key: '--text-tertiary', label: '弱化提示', min: 3.5 },
  { key: '--md-heading', label: '标题', min: 4.5 },
  { key: '--md-code', label: '行内代码', min: 4.5 },
  { key: '--md-link', label: '链接', min: 4.5 }
]

describe('编辑背景配色对比度', () => {
  it('styles.css 中能找到全部编辑背景定义', () => {
    expect([...backgrounds.keys()].sort()).toEqual(['auto', 'black', 'blend', 'eye-care', 'kraft', 'paper', 'white'])
  })

  for (const [themeName, themeVars] of Object.entries(themes)) {
    for (const [bgName, overrides] of backgrounds) {
      it(`${themeName} 主题 + ${bgName} 背景的各级文字对比度达标`, () => {
        // 背景自带变量覆盖主题变量
        const vars = { ...themeVars, ...overrides }
        const base = resolveEditorBase(vars['--editor-base'], vars)
        const failures: string[] = []
        for (const role of roles) {
          const color = vars[role.key]
          if (!color) {
            failures.push(`${role.label} 缺少 ${role.key}`)
            continue
          }
          const ratio = contrastRatio(color, base)
          if (ratio < role.min) {
            failures.push(`${role.label} ${color} 对底色 ${base} 仅 ${ratio.toFixed(2)}:1（要求 ≥ ${role.min}:1）`)
          }
        }
        expect(failures, `${themeName}/${bgName} 配色不达标：\n` + failures.join('\n')).toEqual([])
      })
    }
  }
})