import type { ReactNode } from 'react'
import icon from '../../../build/icon.svg'

/** 应用内的统一品牌图标，依赖桌面图标的 SVG 源资产，供侧栏、登录页、欢迎页与模型头像共用。 */
export function BrandMark(): ReactNode {
  return <img className="brand-icon" src={icon} alt="" aria-hidden="true" draggable={false} />
}
