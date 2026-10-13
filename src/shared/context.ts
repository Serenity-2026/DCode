import type { Attachment, Conversation, ModelDetails, ProviderProfile, ReasoningEffort } from './types'

/** 推理档位白名单供 Models 解析元数据、StateService 校验输入、界面生成滑块共用。 */
export const reasoningEfforts: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
/** 独立文件附件文本上限；文件夹不计入此限额，读取、IPC 与草稿校验共用。 */
export const attachmentByteLimit = 512 * 1024

/** 按标准强度顺序展示模型实际返回的档位，未知或明确不支持时不猜测档位。 */
export function modelEfforts(detail?: ModelDetails): ReasoningEffort[] {
  return reasoningEfforts.filter(level => detail?.reasoningEfforts?.includes(level))
}

/** StateService 的档位校验与默认选择规则：保留受支持值，失效值取最近档位，缺省采用服务默认值。 */
export function resolveEffort(value: ReasoningEffort | null | undefined, detail?: ModelDetails): ReasoningEffort | null {
  const levels = modelEfforts(detail)
  if (!levels.length) return null
  if (value && levels.includes(value)) return value
  if (!value && detail?.defaultEffort && levels.includes(detail.defaultEffort)) return detail.defaultEffort
  return levels.find(level => reasoningEfforts.indexOf(level) >= reasoningEfforts.indexOf(value || 'medium')) || levels.at(-1)!
}

/** StateService 快照与 Models 请求共用每模型选择，保证界面档位就是实际发送的参数。 */
export function selectedEffort(provider: ProviderProfile | undefined, model: string | null): ReasoningEffort | null {
  return model ? resolveEffort(Object.hasOwn(provider?.selectedEfforts || {}, model) ? provider?.selectedEfforts?.[model] : undefined, provider?.modelDetails?.[model]) : null
}

/** 校验附件结构；仅独立文件受数量与大小限额约束，StateService 同样用于验证磁盘消息。 */
export function validateAttachments(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('附件内容无效。')
  let bytes = 0
  let files = 0
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 80 || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 || !['file', 'folder'].includes(item.kind) || !Number.isSafeInteger(item.fileCount) || item.fileCount < 0 || typeof item.content !== 'string') throw new Error('附件内容无效。')
    if (item.path !== undefined && (item.kind !== 'folder' || typeof item.path !== 'string' || !item.path.trim() || item.path.includes('\0'))) throw new Error('附件目录无效。')
    if (item.fileCount === 0 ? item.kind !== 'folder' || item.content !== '' : !item.content.trim()) throw new Error('附件内容无效。')
    if (item.kind === 'file') {
      if (item.fileCount > 50) throw new Error('附件内容无效。')
      if (++files > 10) throw new Error('每条消息最多添加 10 个独立文件附件。')
      bytes += new TextEncoder().encode(item.content).length
    }
  }
  if (bytes > attachmentByteLimit) throw new Error('附件文本总计不能超过 512 KiB，请减少附件。')
  if (new Set(value.map(item => item.id)).size !== value.length) throw new Error('不能重复添加同一附件。')
  return value as Attachment[]
}

/** 将明确附加的文件文本拼入用户消息，供请求与预估共用，不读取磁盘。 */
export function messageContent(content: string, attachments: Attachment[] = []): string {
  return [content, ...attachments.map(item => `\n<attachment name=${JSON.stringify(item.name)}>\n${item.content}\n</attachment>`)].filter(Boolean).join('\n')
}

/** 当前会话最近一次目录选择；旧附件缺少路径时不沿用此前目录。 */
export function conversationDirectory(conversation: Pick<Conversation, 'messages'>): string | undefined {
  for (const message of [...conversation.messages].reverse()) {
    if (message.role !== 'user') continue
    const folder = message.attachments?.find(item => item.kind === 'folder')
    if (folder) return folder.path
  }
  return undefined
}

/** 构建真实请求上下文；只保留成功历史轮次和需要回答的问题，排除失败历史与推理文本。 */
export function contextMessages(conversation: Pick<Conversation, 'messages'>, includePending = true, draftAttachments: Attachment[] = []): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const result: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: '你是 DCode，一位严谨、简洁的编程助手。使用用户的语言回答，代码使用带语言标记的 Markdown 代码块。只有工具结果明确证明操作成功时，才可声称已经执行代码或访问文件。' }
  ]
  const draftFolder = draftAttachments.find(item => item.kind === 'folder')
  const directory = draftFolder ? draftFolder.path : conversationDirectory(conversation)
  result[0].content += directory ? `\n当前工作目录：${JSON.stringify(directory)}。read 用于检查文件，edit 用于局部替换，write 用于新建或完整覆盖，bash 用于执行命令。操作前检查目录中的 AGENTS.md。附件是选择时的快照，磁盘当前内容以工具结果为准。` : '\n尚未选择工作目录；需要文件或命令操作时，请用户先选择文件夹。'
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
  const messages = contextMessages(conversation || { messages: [] }, generating, generating ? [] : attachments)
  if (!generating && (draft.trim() || attachments.length)) messages.push({ role: 'user', content: messageContent(draft.trim(), attachments) })
  return messages.reduce((total, message) => total + Math.ceil(new TextEncoder().encode(message.content).length / 3) + 4, 3)
}
