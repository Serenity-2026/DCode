import { expect, it } from 'vitest'
import { findProviderPreset } from '../../src/renderer/src/features/settings/provider-presets'

it('recognizes official base URL aliases without rewriting custom proxy paths', () => {
  expect(findProviderPreset('https://api.deepseek.com')?.urls['anthropic-messages']).toBe('https://api.deepseek.com/anthropic')
  expect(findProviderPreset('https://api.moonshot.cn/anthropic/v1/')?.urls['openai-completions']).toBe('https://api.moonshot.cn/v1')
  expect(findProviderPreset('https://api.anthropic.com/v1')?.urls['openai-completions']).toBeUndefined()
  expect(findProviderPreset('https://dashscope.aliyuncs.com/compatible-mode/v1')?.urls['anthropic-messages']).toBe('https://dashscope.aliyuncs.com/apps/anthropic')
  expect(findProviderPreset('https://dashscope.aliyuncs.com/apps/anthropic/v1/')?.name).toBe('Qwen')
  for (const url of ['https://proxy.example/v1', 'https://api.deepseek.com/custom/v1', 'https://api.deepseek.com.evil.example/v1', '']) {
    expect(findProviderPreset(url)).toBeUndefined()
  }
})
