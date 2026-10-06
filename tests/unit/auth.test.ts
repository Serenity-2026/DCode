import { StateRepository } from '../../src/main/repositories/state-repository'
import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { StateService } from '../../src/main/services/state-service'
import { Auth } from '../../src/main/services/auth-service'
import { Models } from '../../src/main/services/model-service'
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
  const restored = new StateService(new StateRepository(path))
  expect(restored.snapshot().activeUserId).toBeNull()
  const auth = new Auth(restored, secrets, new Models(restored, secrets, config))
  await auth.restore()
  expect(restored.snapshot().activeUserId).toBe(store.requireUser().id)
  auth.logout()
  const loggedOut = new StateService(new StateRepository(path))
  await new Auth(loggedOut, secrets, new Models(loggedOut, secrets, config)).restore()
  expect(loggedOut.snapshot().activeUserId).toBeNull()
  expect(loggedOut.state.session).toBeNull()
})

it('invalidates tampered session tokens', async () => {
  const { store, path } = await create()
  store.state.session!.tokenHash = '0'.repeat(64); store.save()
  const restored = new StateService(new StateRepository(path))
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
  const restored = new StateService(new StateRepository(path))
  await new Auth(restored, secrets, new Models(restored, secrets, config)).restore()
  expect(restored.snapshot().activeUserId).toBeNull()
  expect(restored.state.session).toBeNull()
})
