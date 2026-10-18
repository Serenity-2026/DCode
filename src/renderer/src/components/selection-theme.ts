import type { ThemeConfig } from 'antd'
import type { Theme } from '../../../shared/types'

/** 设置下拉框和聊天模型菜单共用颜色与无缩放动画的交互。 */
export function selectionTheme(theme: Theme): ThemeConfig {
  const dark = theme === 'dark'
  const colors = {
    colorBgElevated: dark ? '#292c28' : '#ffffff', colorText: dark ? '#edf0eb' : '#292e2a',
    colorTextDescription: dark ? '#abb5ab' : '#687268', colorPrimary: dark ? '#e1eee4' : '#303b33',
    controlItemBgHover: dark ? '#353b35' : '#f4f6f3', controlItemBgActive: dark ? '#3b4a3f' : '#eaf0e9',
    controlItemBgActiveHover: dark ? '#435448' : '#dfe8de', borderRadiusLG: 14
  }
  return { token: { motion: false }, components: {
    Dropdown: colors,
    Select: { ...colors, optionActiveBg: colors.controlItemBgHover, optionSelectedBg: colors.controlItemBgActive, optionSelectedColor: colors.colorText }
  } }
}
