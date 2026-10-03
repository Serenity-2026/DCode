import type { DCodeAPI } from '../../shared/types'

declare global {
  /** 为 preload 注入的桌面桥接对象补充类型；运行时实现位于 src/preload/index.ts。 */
  interface Window { dcode: DCodeAPI }
}
