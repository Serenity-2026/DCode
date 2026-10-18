import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { ProviderDraft } from '../../shared/types'
import { Models } from '../services/model-service'

/** 模型接口，依赖 Models 测试服务并刷新目录，不在控制器中请求 HTTP。*/
export function registerModelController(router: IpcRouter, models: Models): void {
  //将来收到 channels.saveProvider 通道上的请求，就把请求参数交给 models.testAndSave()。
  router.handle<ProviderDraft>(channels.saveProvider, input => router.exclusive(() => models.testAndSave(input)))
  router.handle(channels.refreshModels, () => router.exclusive(() => models.refresh()))
}
