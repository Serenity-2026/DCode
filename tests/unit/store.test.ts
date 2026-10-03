import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { contextMessages, Store } from '../../src/main/store'
import { create, cleanup } from './helpers'
import type { Action } from '../../src/shared/types'

afterEach(cleanup)

describe('account-owned conversations', () => {
  it('persists messages and recovers interrupted streams on restart', async () => {
    const { store, path } = await create()
    const { message } = store.begin('测试问题', false, 'test-model')
    message.content = '部分回答'
    store.save()
    const restored = new Store(path)
    expect(restored.state.conversations[0].messages[1]).toMatchObject({ content: '部分回答', status: 'stopped' })
    expect(restored.state.activeConversationId).toBe(store.state.activeConversationId)
    expect(restored.snapshot().conversations).toEqual([])
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(3)
  })

  it('isolates accounts and rejects direct user switching or cross-account access', async () => {
    const { store, auth } = await create()
    const originalUser = store.requireUser().id
    const { conversation } = store.begin('私有问题', false, 'test-model')
    auth.logout()
    await auth.register({ username: 'another', password: 'another-password' })
    expect(store.snapshot().conversations).toEqual([])
    expect(store.snapshot().providers).toEqual([])
    expect(JSON.stringify(store.snapshot())).not.toContain('private-key')
    expect(() => store.apply({ type: 'conversation:select', id: conversation.id })).toThrow('会话不存在')
    expect(() => store.apply({ type: 'user:rename', id: originalUser, name: '非法修改' })).toThrow('无权')
    expect(() => store.apply({ type: 'user:switch', id: originalUser } as unknown as Action)).toThrow('无效操作')
    auth.logout()
    await auth.login({ username: 'developer', password: 'test-password' })
    expect(store.snapshot().conversations).toHaveLength(1)
  })

  it('validates inputs and rolls back rejected mutations', async () => {
    const { store, auth } = await create()
    const before = structuredClone(store.state)
    expect(() => store.apply({ type: 'user:rename', id: store.requireUser().id, name: ' ' })).toThrow()
    expect(() => store.begin(' ', false, 'test')).toThrow()
    expect(() => store.begin('x'.repeat(32_001), false, 'test')).toThrow()
    expect(store.state).toEqual(before)
    auth.logout()
    expect(() => store.begin('未登录', false, 'test')).toThrow('请先登录')
    expect(() => store.apply({ type: 'theme', theme: 'dark' })).toThrow('请先登录')
  })

  it('deletes an owned conversation and resets active selection', async () => {
    const { store } = await create()
    const { conversation } = store.begin('删除测试', false, 'test')
    store.apply({ type: 'conversation:delete', id: conversation.id })
    expect(store.state.conversations).toHaveLength(0)
    expect(store.state.activeConversationId).toBeNull()
  })

  it('retries without duplicating questions and sends only completed previous turns', async () => {
    const { store } = await create()
    const first = store.begin('第一问', false, 'test')
    first.message.content = '完整回答'; first.message.status = 'complete'
    const second = store.begin('第二问', false, 'test')
    second.message.content = '失败的部分回答'; second.message.status = 'error'
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

  it('does not overwrite damaged data', async () => {
    const { path } = await create()
    const original = JSON.parse(readFileSync(path, 'utf8'))
    for (const broken of ['{broken', JSON.stringify({ ...original, schemaVersion: '3' })]) {
      writeFileSync(path, broken)
      expect(() => new Store(path)).toThrow('无法读取')
      expect(readFileSync(path, 'utf8')).toBe(broken)
    }
  })
})
