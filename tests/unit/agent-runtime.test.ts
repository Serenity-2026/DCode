import { afterEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/main/domain/agent'
import type { LlmMessage } from '../../src/main/domain/llm'
import { createAgent, config } from './helpers'
import { echoTool, openAIResponse, testCall } from './llm-fixtures'

afterEach(() => vi.unstubAllGlobals())

it('reduces lifecycle events before notifying observers and settles after terminal observers finish', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('准备', [testCall('a')], '计划')).mockResolvedValueOnce(openAIResponse('完成')))
  const agent = createAgent([echoTool])
  const events: AgentEvent[] = []
  let saved = false
  agent.subscribe(event => {
    events.push(event)
    const state = agent.state
    if (event.type === 'message_update') expect(state.streamingMessage?.content.length).toBeGreaterThan(0)
    if (event.type === 'message_end') expect(state.messages.at(-1)).toEqual(event.message)
    if (event.type === 'tool_execution_start') expect(state.pendingToolCalls).toEqual(['a'])
    if (event.type === 'tool_execution_end') expect(state.pendingToolCalls).toEqual([])
    if (event.type === 'agent_end') { expect(agent.busy).toBe(true); saved = true }
  })
  const running = agent.prompt(config, { role: 'user', content: '问题' })
  expect(agent.busy).toBe(true)
  expect(agent.state.isStreaming).toBe(true)
  expect(agent.waitForIdle()).toBe(running)
  await running
  expect(saved).toBe(true)
  expect(agent.busy).toBe(false)
  expect(agent.state).toMatchObject({ isStreaming: false, pendingToolCalls: [], outcome: 'complete' })
  expect(agent.state.streamingMessage).toBeUndefined()
  expect(agent.state.model).not.toHaveProperty('apiKey')
  expect(JSON.stringify(events)).not.toContain(config.apiKey)
  expect(events.filter(event => event.type !== 'message_update').map(event => event.type)).toEqual([
    'agent_start', 'turn_start', 'message_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'message_end', 'turn_end',
    'turn_start', 'message_start', 'message_end', 'turn_end', 'agent_end'
  ])
})

it('retains full tool context across standalone prompts without any session or storage', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('第一答')).mockResolvedValueOnce(openAIResponse('第二答'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([echoTool])
  agent.replaceMessages([{ role: 'system', content: '提示' }])
  await agent.prompt(config, { role: 'user', content: '第一问' })
  await agent.prompt(config, { role: 'user', content: '第二问' })
  const request = JSON.parse(fetchMock.mock.calls[2][1].body)
  expect(request.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
  expect(request.messages[3]).toMatchObject({ tool_call_id: 'a', content: '结果:测试' })
  expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: 'text', text: '第二答' }] })
})

it('isolates imported messages, state snapshots and each subscriber from model context', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('完成'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([echoTool])
  const context: LlmMessage[] = [{ role: 'system', content: '原始提示' }]
  agent.replaceMessages(context)
  context[0].content = '被修改的提示'
  const snapshot = agent.state
  snapshot.messages.length = 0
  snapshot.tools[0].name = 'changed'
  agent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') event.message.content.length = 0
    if (event.type === 'tool_execution_end') event.result.content = '篡改结果'
  })
  const observed: AgentEvent[] = []
  const unsubscribe = agent.subscribe(event => observed.push(event))
  await agent.prompt(config, { role: 'user', content: '问题' })
  const messages = JSON.parse(fetchMock.mock.calls[1][1].body).messages
  expect(messages[0].content).toBe('原始提示')
  expect(messages.at(-1).content).toBe('结果:测试')
  expect(messages.at(-2).tool_calls[0].function.name).toBe('echo')
  expect(observed.find(event => event.type === 'tool_execution_end')).toMatchObject({ result: { content: '结果:测试' } })
  unsubscribe()
  vi.mocked(fetch).mockResolvedValueOnce(openAIResponse('再答'))
  const count = observed.length
  await agent.prompt(config, { role: 'user', content: '再问' })
  expect(observed).toHaveLength(count)
})

it('rejects reentry and context replacement, and cancels before the first model request', async () => {
  vi.stubGlobal('fetch', vi.fn())
  const agent = createAgent()
  const events: AgentEvent[] = []
  agent.subscribe(event => events.push(event))
  const running = agent.prompt(config, { role: 'user', content: '问题' })
  expect(() => agent.prompt(config, { role: 'user', content: '重复' })).toThrow('先停止')
  expect(() => agent.replaceMessages([])).toThrow('先停止')
  agent.abort()
  await running
  expect(fetch).not.toHaveBeenCalled()
  expect(events.map(event => event.type)).toEqual(['agent_start', 'agent_end'])
  expect(agent.state).toMatchObject({ outcome: 'stopped', isStreaming: false })
  agent.abort()
  await agent.waitForIdle()
})

it('reports failures once, releases the run and permits a fresh context after failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')).mockResolvedValueOnce(openAIResponse('恢复')))
  const agent = createAgent()
  const endings: AgentEvent[] = []
  agent.subscribe(event => { if (event.type === 'agent_end') endings.push(event) })
  await agent.prompt(config, { role: 'user', content: '问题' })
  expect(agent.state).toMatchObject({ outcome: 'error', isStreaming: false })
  expect(agent.state.errorMessage).toContain('连接中断')
  expect(endings).toHaveLength(1)
  agent.replaceMessages([])
  await agent.prompt(config, { role: 'user', content: '重试' })
  expect(agent.state.outcome).toBe('complete')
  expect(agent.state.errorMessage).toBeUndefined()
  expect(agent.state.messages).toHaveLength(2)
})

it('notifies terminal observers and clears busy even when a subscriber fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('回答')))
  const agent = createAgent()
  agent.subscribe(event => { if (event.type === 'message_update' || event.type === 'agent_end') throw new Error('订阅者失败') })
  const endings: AgentEvent[] = []
  agent.subscribe(event => { if (event.type === 'agent_end') endings.push(event) })
  const running = agent.prompt(config, { role: 'user', content: '问题' })
  await expect(running).rejects.toThrow('订阅者失败')
  expect(endings).toEqual([{ type: 'agent_end', outcome: 'error', error: '订阅者失败' }])
  expect(agent.busy).toBe(false)
  expect(agent.state.isStreaming).toBe(false)
  await agent.waitForIdle()
})
