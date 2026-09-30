// ---------------------------------------------------------------------------
// 鼠标位置总线。
//
// 自定义主页运行在 iframe 沙箱里：鼠标悬停其上时，mousemove 事件被 iframe 吞掉，
// 宿主 window 收不到，跟随鼠标的「光标光晕」会定格在进入 iframe 前的位置。
//
// 沙箱 SDK 会把鼠标坐标通过 postMessage 回传，宿主转成窗口坐标后 emit 到本总线，
// CursorGlow 订阅后即可继续跟随。宿主自身的 mousemove 仍照常直接驱动光晕。
// ---------------------------------------------------------------------------

type CursorListener = (x: number, y: number) => void

const listeners = new Set<CursorListener>()

/** 订阅鼠标坐标（窗口坐标，px）；返回退订函数。 */
export function subscribeCursor(cb: CursorListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 推送一次鼠标坐标（窗口坐标，px）。 */
export function emitCursor(x: number, y: number): void {
  for (const cb of listeners) cb(x, y)
}
