import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextMessages, Store } from '../../src/main/store'

const directories: string[] = []
function create(): { store: Store; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'dcode-store-'))
  directories.push(directory)
  const path = join(directory, 'state.json')
  return { store: new Store(path), path }
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('local users and conversations', () => {
  it('persists messages and recovers interrupted streams on restart', () => {
    const { store, path } = create()
    const { message } = store.begin('测试问题', false, 'test-model')
    message.content = '部分回答'
    store.save()
    const restored = new Store(path)
    expect(restored.state.conversations[0].messages[1]).toMatchObject({ content: '部分回答', status: 'stopped' })
    expect(restored.state.activeConversationId).toBe(store.state.activeConversationId)
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1)
  })

  it('isolates users and rejects accessing another user conversation', () => {
    const { store } = create()
    const originalUser = store.state.activeUserId
    const { conversation } = store.begin('私有问题', false, 'test-model')
    store.apply({ type: 'user:create', name: '第二位用户' })
    const config = { baseUrl: 'https://example.com', model: 'test', apiKey: 'secret' }
    expect(store.snapshot(config).conversations).toEqual([])
    expect(JSON.stringify(store.snapshot(config))).not.toContain('secret')
    expect(() => store.apply({ type: 'conversation:select', id: conversation.id })).toThrow('会话不存在')
    store.apply({ type: 'user:switch', id: originalUser })
    expect(store.snapshot(config).conversations).toHaveLength(1)
  })

  it('validates inputs and preserves state when a mutation is rejected', () => {
    const { store } = create()
    const before = structuredClone(store.state)
    expect(() => store.apply({ type: 'user:create', name: ' ' })).toThrow()
    expect(() => store.begin(' '.repeat(12), false, 'test')).toThrow()
    expect(() => store.begin('x'.repeat(32_001), false, 'test')).toThrow()
    expect(() => store.apply({ type: 'user:delete', id: store.state.activeUserId })).toThrow('至少保留')
    expect(store.state).toEqual(before)
  })

  it('deletes a user together with conversations and resets active selection', () => {
    const { store } = create()
    store.apply({ type: 'user:create', name: '临时用户' })
    const userId = store.state.activeUserId
    store.begin('删除测试', false, 'test')
    store.apply({ type: 'user:delete', id: userId })
    expect(store.state.users).toHaveLength(1)
    expect(store.state.conversations).toHaveLength(0)
    expect(store.state.activeConversationId).toBeNull()
  })

  it('retries without duplicating questions and sends only completed previous turns', () => {
    const { store } = create()
    const first = store.begin('第一问', false, 'test')
    first.message.content = '完整回答'
    first.message.status = 'complete'
    const second = store.begin('第二问', false, 'test')
    second.message.content = '失败的部分回答'
    second.message.status = 'error'
    const third = store.begin('第三问', false, 'test')
    const context = contextMessages(third.conversation)
    expect(context.slice(1)).toEqual([
      { role: 'user', content: '第一问' }, { role: 'assistant', content: '完整回答' }, { role: 'user', content: '第三问' }
    ])
    const retry = store.begin('', true, 'test')
    expect(retry.conversation.messages).toHaveLength(6)
    expect(contextMessages(retry.conversation)).toEqual(context)
    expect(retry.message.id).not.toBe(third.message.id)
  })

  it('does not overwrite damaged data', () => {
    const { path } = create()
    writeFileSync(path, '{broken')
    expect(() => new Store(path)).toThrow('无法读取')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})
