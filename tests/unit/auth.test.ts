import { afterEach, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { Store } from '../../src/main/store'
import { Auth } from '../../src/main/auth'
import { Models } from '../../src/main/models'
import { create, cleanup, config, secrets } from './helpers'

afterEach(cleanup)

it('stores salted password hashes and exposes no secrets in snapshots', async () => {
  const { store, path } = await create()
  const bytes = readFileSync(path, 'utf8')
  expect(bytes).not.toContain('test-password')
  expect(bytes).not.toContain('private-key')
  expect(store.state.users[0].passwordHash).toHaveLength(128)
  expect(store.state.users[0].passwordSalt).toHaveLength(32)
  const snapshot = JSON.stringify(store.snapshot())
  for (const field of ['passwordHash', 'passwordSalt', 'encryptedToken', 'tokenHash', 'encryptedApiKey']) expect(snapshot).not.toContain(field)
})

it('rejects wrong credentials and duplicate normalized accounts', async () => {
  const { auth } = await create()
  auth.logout()
  await expect(auth.login({ username: 'developer', password: 'wrong-password' })).rejects.toThrow('账号或密码')
  await expect(auth.register({ username: 'DEVELOPER', password: 'test-password' })).rejects.toThrow('已存在')
  await expect(auth.register({ username: 'short', password: '123' })).rejects.toThrow('8–128')
  expect((await auth.login({ username: 'Developer', password: 'test-password' })).activeUserId).toBeTruthy()
})

it('restores remembered sessions but never trusts activeUserId alone', async () => {
  const { store, path } = await create()
  const restored = new Store(path)
  expect(restored.snapshot().activeUserId).toBeNull()
  const auth = new Auth(restored, secrets, new Models(restored, secrets, config))
  await auth.restore()
  expect(restored.snapshot().activeUserId).toBe(store.requireUser().id)
  auth.logout()
  const loggedOut = new Store(path)
  await new Auth(loggedOut, secrets, new Models(loggedOut, secrets, config)).restore()
  expect(loggedOut.snapshot().activeUserId).toBeNull()
  expect(loggedOut.state.session).toBeNull()
})

it('invalidates tampered session tokens', async () => {
  const { store, path } = await create()
  store.state.session!.tokenHash = '0'.repeat(64); store.save()
  const restored = new Store(path)
  await new Auth(restored, secrets, new Models(restored, secrets, config)).restore()
  expect(restored.snapshot().activeUserId).toBeNull()
  expect(restored.state.session).toBeNull()
})

it('rejects a remembered token reassigned to another account on disk', async () => {
  const { store, auth, path } = await create()
  const previous = structuredClone(store.state.session!)
  auth.logout()
  const other = await auth.register({ username: 'another', password: 'another-password' })
  store.state.session = { ...previous, userId: other.activeUserId! }; store.save()
  const restored = new Store(path)
  await new Auth(restored, secrets, new Models(restored, secrets, config)).restore()
  expect(restored.snapshot().activeUserId).toBeNull()
  expect(restored.state.session).toBeNull()
})

it('backs up and migrates legacy conversations without assigning a password automatically', async () => {
  const { store, path } = await create()
  store.begin('旧问题', false, 'old-model')
  const legacy = { schemaVersion: 1, users: store.state.users.map(({ id, name, createdAt }) => ({ id, name, createdAt })), conversations: store.state.conversations, activeUserId: store.state.activeUserId, activeConversationId: store.state.activeConversationId, theme: 'dark' }
  writeFileSync(path, JSON.stringify(legacy))
  const migrated = new Store(path)
  expect(JSON.parse(readFileSync(`${path}.v1.backup`, 'utf8'))).toEqual(legacy)
  expect(migrated.snapshot().activeUserId).toBeNull()
  expect(migrated.snapshot().legacyUsers).toHaveLength(1)
  const auth = new Auth(migrated, secrets, new Models(migrated, secrets, config))
  const state = await auth.register({ username: 'new-account', password: 'new-password', legacyUserId: legacy.users[0].id })
  expect(state.conversations[0].messages[0].content).toBe('旧问题')
  expect(state.activeUserId).toBe(legacy.users[0].id)
  expect(state.theme).toBe('dark')
})

it('migrates schema 2 services without exposing old hand-entered model IDs as discovered models', async () => {
  const { store, path } = await create()
  store.begin('保留聊天', false, 'previous-model')
  const previous = { ...store.state, schemaVersion: 2, users: store.state.users.map(({ providers, activeProviderId, selectedModel: _selection, fastMode: _fast, ...user }) => ({
    ...user, models: providers.map(({ availableModels: _catalog, ...provider }) => ({ ...provider, model: 'hand-entered' })), activeModelId: activeProviderId
  })) }
  writeFileSync(path, JSON.stringify(previous))
  const migrated = new Store(path)
  expect(JSON.parse(readFileSync(`${path}.v2.backup`, 'utf8'))).toEqual(previous)
  await new Auth(migrated, secrets, new Models(migrated, secrets, config)).restore()
  expect(migrated.snapshot()).toMatchObject({ providers: [{ availableModels: [] }], selectedModel: null, fastMode: false })
  expect(migrated.snapshot().conversations[0].messages[0].content).toBe('保留聊天')
  expect(migrated.requireUser().passwordHash).toBe(store.requireUser().passwordHash)
})
