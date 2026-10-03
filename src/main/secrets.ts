import { safeStorage } from 'electron'

/** Auth 与 Models 共用的秘密存储契约；测试可注入独立实现，不改变生产安全策略。 */
export interface SecretCodec {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

/** 使用 Electron safeStorage 的 OS 密钥保护模型密钥与会话令牌，只在主进程调用。 */
export class Secrets implements SecretCodec {
  /** 拒绝不可用的系统密钥库及 Linux basic_text，避免悄悄退回明文存储。 */
  private async check(): Promise<void> {
    if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('系统安全存储不可用，无法保存登录状态或 API 密钥。')
    }
  }

  /** 加密为可写入 JSON 的 base64 密文，调用方仍需通过 Store 原子保存。 */
  async encrypt(value: string): Promise<string> {
    await this.check()
    return (await safeStorage.encryptStringAsync(value)).toString('base64')
  }

  /** 使用 OS 密钥恢复秘密，仅返回主进程业务类，不向 renderer 回显。 */
  async decrypt(value: string): Promise<string> {
    await this.check()
    return (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result
  }
}
