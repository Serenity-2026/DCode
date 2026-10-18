/** 字体使用本机字体栈，无需下载；代码块继续使用等宽字体。 */
export const fontFamilies = {
  system: { label: '系统默认', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif' },
  sans: { label: '无衬线', value: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif' },
  serif: { label: '衬线', value: 'Georgia, "Songti SC", SimSun, serif' },
  mono: { label: '等宽', value: 'ui-monospace, "SFMono-Regular", Consolas, "PingFang SC", monospace' }
}
export const fontSizes = [12, 14, 16, 18]
export interface Typography { fontFamily: keyof typeof fontFamilies; fontSize: number }
export const defaultTypography: Typography = { fontFamily: 'system', fontSize: 14 }

export function isTypography(value: unknown): value is Typography {
  if (!value || typeof value !== 'object') return false
  const typography = value as Typography
  return Object.hasOwn(fontFamilies, typography.fontFamily) && fontSizes.includes(typography.fontSize)
}
