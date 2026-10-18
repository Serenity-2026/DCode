import type { ModelApi } from '../../../../shared/types'

/** 仅提供官方地址，不推断自定义代理路径；来源见 doc/SPEC-settings.md。 */
export const providerPresets: { name: string; urls: Partial<Record<ModelApi, string>> }[] = [
  { name: 'DeepSeek', urls: { 'openai-completions': 'https://api.deepseek.com/v1', 'anthropic-messages': 'https://api.deepseek.com/anthropic' } },
  { name: 'Kimi', urls: { 'openai-completions': 'https://api.moonshot.cn/v1', 'anthropic-messages': 'https://api.moonshot.cn/anthropic' } },
  { name: 'GLM', urls: { 'openai-completions': 'https://open.bigmodel.cn/api/paas/v4', 'anthropic-messages': 'https://open.bigmodel.cn/api/anthropic' } },
  { name: 'MiMo', urls: { 'openai-completions': 'https://api.xiaomimimo.com/v1', 'anthropic-messages': 'https://api.xiaomimimo.com/anthropic' } },
  { name: 'OpenAI / ChatGPT', urls: { 'openai-completions': 'https://api.openai.com/v1' } },
  { name: 'Claude', urls: { 'anthropic-messages': 'https://api.anthropic.com' } }
]

export function findProviderPreset(baseUrl: string) {
  const normalize = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  return providerPresets.find(preset => Object.values(preset.urls).some(url => normalize(url) === normalize(baseUrl)))
}
