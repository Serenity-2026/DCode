/** 校验并去除文本两端空白，供 StateService 的用户名称、会话标题和问题输入共用。 */
export function textInput(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`请输入 1–${max} 个字符。`)
  }
  return value.trim()
}
