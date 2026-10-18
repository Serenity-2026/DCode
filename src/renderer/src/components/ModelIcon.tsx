import { RobotOutlined } from '@ant-design/icons'
import openai from '@lobehub/icons-static-svg/icons/openai.svg'
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg'
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import glm from '@lobehub/icons-static-svg/icons/zhipu-color.svg'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import doubao from '@lobehub/icons-static-svg/icons/doubao-color.svg'
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg'
import grok from '@lobehub/icons-static-svg/icons/grok.svg'
import mimo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg'

const brands = [
  { name: 'mimo', pattern: /mimo|xiaomi|小米/i, src: mimo, color: '#ffeadb' },
  { name: 'claude', pattern: /claude|anthropic/i, src: claude, color: '#f8e9e2' },
  { name: 'deepseek', pattern: /deepseek/i, src: deepseek, color: '#e9efff' },
  { name: 'gemini', pattern: /gemini|google/i, src: gemini, color: '#edf2ff' },
  { name: 'glm', pattern: /glm|zhipu|bigmodel|智谱|z\.ai/i, src: glm, color: '#e8efff' },
  { name: 'qwen', pattern: /qwen|通义|千问|dashscope/i, src: qwen, color: '#f0eaff' },
  { name: 'doubao', pattern: /doubao|豆包|volcengine|火山/i, src: doubao, color: '#f7ecff' },
  { name: 'kimi', pattern: /kimi|moonshot|月之暗面/i, src: kimi, color: '#e9f6ee' },
  { name: 'mistral', pattern: /mistral|mixtral|codestral/i, src: mistral, color: '#fff1df' },
  { name: 'grok', pattern: /grok|x\.ai/i, src: grok, color: '#e9edf1' },
  { name: 'openai', pattern: /gpt|openai|codex|\bo[134](?:\b|-)/i, src: openai, color: '#e3f3eb' }
]

/** 先识别模型，再回退到服务名称；图标只影响展示，不推断模型能力。 */
export function ModelIcon({ model = '', provider = '', size = 20 }: { model?: string; provider?: string; size?: number }) {
  const brand = brands.find(item => item.pattern.test(model)) || brands.find(item => item.pattern.test(provider))
  return <span className="model-brand-icon" data-brand={brand?.name || 'custom'} aria-hidden="true" style={{ width: size, height: size, background: brand?.color || '#edf0f3' }}>
    {brand ? <img src={brand.src} alt="" draggable={false} /> : <RobotOutlined />}
  </span>
}
