import { useState, type ReactNode } from 'react'
import { Button } from 'antd'

/** 欢迎页云朵终端，依赖 Ant Design Button 与 CSS 的光标闪烁、漂浮动画；点击累加旋转角度，减少动画时保持静态。 */
export function WelcomeCloud(): ReactNode {
  const [turns, setTurns] = useState(0)
  return <Button className="welcome-cloud" type="text" aria-label="旋转云朵" onClick={() => setTurns(value => value + 1)}>
    <span className="welcome-cloud-float">
      <span className="welcome-cloud-turn" style={{ transform: `rotate(${turns * 360}deg)` }}>
        <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M39 12C32 4 21 7 18 17C7 18 4 31 12 38C8 49 19 58 29 54C39 61 51 54 51 44C63 40 62 26 53 21C55 9 44 6 39 12Z" />
          <path d="m23 25 5 8-5 8" />
          <path className="welcome-cloud-cursor" d="M37 41h10" />
        </svg>
      </span>
    </span>
    {turns > 0 && <span key={turns} className="welcome-cloud-ripple" aria-hidden="true" />}
  </Button>
}
