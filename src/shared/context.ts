import type { Attachment, Conversation, ModelDetails, ReasoningEffort } from './types'

/** 推理档位白名单供 Models 解析元数据、Store 校验输入、界面生成滑块共用。 */
export const reasoningEfforts: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
/** 界面固定五档；旧的 minimal / xhigh 仅保留在磁盘与服务元数据兼容白名单中。 */
export const strengthLevels = ['low', 'medium', 'high', 'max', 'ultra'] as const
export type Strength = typeof strengthLevels[number]
/** 附件文本总量上限，在文件读取、IPC 校验及界面添加时使用同一限制。 */
export const attachmentByteLimit = 512 * 1024

/** Store 和界面共用旧账号档位迁移规则，缺省使用 medium。 */
export function normalizeEffort(value: ReasoningEffort | null | undefined): Strength {
  return value === 'minimal' ? 'low' : value === 'xhigh' ? 'max' : value || 'medium'
}

/** Models 与界面共用请求映射：优先实际元数据，避免把五档偏好当成服务都支持的参数。 */
export function resolveEffort(value: ReasoningEffort | null | undefined, detail?: ModelDetails): ReasoningEffort | null {
  const requested = normalizeEffort(value)
  const supported = detail?.reasoningEfforts
  if (!supported) return requested === 'ultra' ? 'max' : requested
  if (supported.includes(requested)) return requested
  const ranked = [...supported].sort((a, b) => strengthLevels.indexOf(normalizeEffort(a)) - strengthLevels.indexOf(normalizeEffort(b)))
  return ranked.find(level => strengthLevels.indexOf(normalizeEffort(level)) >= strengthLevels.indexOf(requested)) || ranked.at(-1) || null
}

/** 校验附件快照，拒绝无效或超量 IPC 输入；Store 同样用于验证磁盘消息。 */
export function validateAttachments(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10) throw new Error('每条消息最多添加 10 个附件。')
  let bytes = 0
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 80 || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 || !['file', 'folder'].includes(item.kind) || !Number.isInteger(item.fileCount) || item.fileCount < 1 || item.fileCount > 50 || typeof item.content !== 'string' || !item.content.trim()) throw new Error('附件内容无效。')
    bytes += new TextEncoder().encode(item.content).length
  }
  if (bytes > attachmentByteLimit) throw new Error('附件文本总计不能超过 512 KiB，请减少附件。')
  if (new Set(value.map(item => item.id)).size !== value.length) throw new Error('不能重复添加同一附件。')
  return value as Attachment[]
}

/** 将明确附加的文件文本拼入用户消息，供请求与预估共用，不读取磁盘。 */
export function messageContent(content: string, attachments: Attachment[] = []): string {
  return [content, ...attachments.map(item => `\n<attachment name=${JSON.stringify(item.name)}>\n${item.content}\n</attachment>`)].filter(Boolean).join('\n')
}

/** 构建真实请求上下文；只保留成功历史轮次和需要回答的问题，排除失败历史与推理文本。 */
export function contextMessages(conversation: Pick<Conversation, 'messages'>, includePending = true): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const result: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: '你是 DCode，一位严谨、简洁的编程助手。使用用户的语言回答，代码使用带语言标记的 Markdown 代码块。不要声称已经执行代码或访问文件。' }
  ]
  for (let i = 0; i < conversation.messages.length; i += 2) {
    const user = conversation.messages[i]
    const assistant = conversation.messages[i + 1]
    if (!user || user.role !== 'user') continue
    if (assistant?.status === 'complete' && assistant.content) {
      result.push({ role: 'user', content: messageContent(user.content, user.attachments) }, { role: 'assistant', content: assistant.content })
    } else if (includePending && i === conversation.messages.length - 2) result.push({ role: 'user', content: messageContent(user.content, user.attachments) })
  }
  return result
}

/** 预估下一次输入 token：与请求共用上下文，加入草稿和附件，数值明确为近似值。 */
export function estimateContext(conversation: Conversation | undefined, draft: string, attachments: Attachment[], generating = false): number {
  const messages = contextMessages(conversation || { messages: [] }, generating)
  if (!generating && (draft.trim() || attachments.length)) messages.push({ role: 'user', content: messageContent(draft.trim(), attachments) })
  return messages.reduce((total, message) => total + Math.ceil(new TextEncoder().encode(message.content).length / 3) + 4, 3)
}
