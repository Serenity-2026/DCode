import type { DCodeAPI } from '../../shared/types'

declare global {
  interface Window { dcode: DCodeAPI }
}
