import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useApp } from '../store'

/**
 * 纯 CSS 3D 玩家模型：用皮肤贴图（64×64 PNG）分面拼出可缓慢自转的角色模型。
 *
 * 为什么不用 3D 库：本项目希望零新增依赖、体积小；CSS 3D 变换足以表现 Minecraft
 * 这种「方盒 + 贴图」的模型，观感接近游戏内的玩家预览。
 *
 * 皮肤 UV（64×64，左上为原点；与游戏一致）：
 *   头 base：x0..32,y0..16   头外层(hat)：x32..64,y0..16
 *   身 base：x16..40,y16..32  身外层(jacket)：x16..40,y32..48
 *   右臂 base：x40..56,y16..32 右臂外层：x40..56,y32..48
 *   左臂 base：x32..48,y48..64 左臂外层：x48..64,y48..64
 *   右腿 base：x0..16,y16..32  右腿外层：x0..16,y32..48
 *   左腿 base：x16..32,y48..64 左腿外层：x0..16,y48..64
 * 每个「面」都是 8×8（头）/ 4×12（四肢）等矩形，按实际像素坐标贴到 3D 盒面上。
 *
 * 仅用于正版 / 第三方账号；离线账号由调用方不渲染本组件。
 *
 * 披风：正版经 uapis.cn 玩家信息接口的 `cape_url` 获取；第三方经认证站会话服的
 * textures.CAPE.url 获取；离线不获取。披风贴图为 64×32，挂在背部（10×16×1）。
 */
export function PlayerModel3D({
  name,
  uuid,
  skinUrl,
  capeUrl,
  authType,
  yggdrasilServer,
  skinModel,
  size = 200
}: {
  name?: string
  uuid?: string
  skinUrl?: string
  /** 披风贴图地址（账号已存；缺失时按认证类型联网补全）。 */
  capeUrl?: string
  /** 账号认证类型：第三方（yggdrasil）走认证站皮肤接口，不做正版查询。 */
  authType?: 'microsoft' | 'offline' | 'yggdrasil'
  /** 第三方认证服务器地址（用于查会话服皮肤）。 */
  yggdrasilServer?: string
  /** 皮肤模型：classic（粗手臂）或 slim（Alex，细手臂）；缺省按 classic。 */
  skinModel?: 'classic' | 'slim'
  size?: number
}): JSX.Element | null {
  const { t } = useApp()
  const [remoteSkin, setRemoteSkin] = useState('')
  const [remoteCape, setRemoteCape] = useState('')
  const [failed, setFailed] = useState(false)
  // 皮肤贴图的实际高度：64 = 现代皮肤（含左臂/左腿与各部位外层）；32 = 旧版皮肤
  // （仅右臂/右腿，无各部位外层）。用于选择 UV 映射方式，避免把 64×32 皮肤纵向拉伸 2 倍。
  const [skinH, setSkinH] = useState(64)
  // 离线账号不联网获取皮肤 / 披风。
  const isOffline = authType === 'offline'

  useEffect(() => {
    setRemoteSkin('')
    setRemoteCape('')
    setFailed(false)
    setSkinH(64)
  }, [name, skinUrl, capeUrl, authType, yggdrasilServer, uuid])

  // 皮肤 / 披风补全：第三方走认证站会话服；正版走 uapis.cn；离线不获取。
  // 两者都已具备时无需联网。
  useEffect(() => {
    if (isOffline || !name) return
    if (skinUrl && capeUrl) return
    let alive = true
    const apply = (skin: string, cape: string): void => {
      if (!alive) return
      if (!skinUrl && skin) setRemoteSkin(skin)
      if (!capeUrl && cape) setRemoteCape(cape)
    }
    if (authType === 'yggdrasil') {
      if (!yggdrasilServer || !uuid) return
      void window.api.accounts
        .yggdrasilSkin(yggdrasilServer, uuid)
        .then((info) => apply(info?.skinUrl ?? '', info?.capeUrl ?? ''))
        .catch(() => undefined)
    } else {
      void window.api.minecraft
        .userinfo(name)
        .then((info) => apply(info.skinUrl, info.capeUrl))
        .catch(() => undefined)
    }
    return () => {
      alive = false
    }
  }, [isOffline, skinUrl, capeUrl, name, authType, yggdrasilServer, uuid])

  const effectiveSkin = skinUrl || remoteSkin
  const skinSrc = effectiveSkin ? effectiveSkin.replace(/^http:\/\//i, 'https://') : ''
  const effectiveCape = capeUrl || remoteCape
  const capeSrc = effectiveCape ? effectiveCape.replace(/^http:\/\//i, 'https://') : ''

  if (!skinSrc || failed) return null

  return (
    <div className="flex flex-col items-center gap-2" aria-label={name}>
      {/* 不可见探测图：加载失败则不渲染模型；加载成功读取实际高度以区分旧版 64×32 皮肤 */}
      <img
        src={skinSrc}
        alt=""
        aria-hidden
        className="hidden"
        onError={() => setFailed(true)}
        onLoad={(e) => setSkinH(e.currentTarget.naturalHeight || 64)}
      />
      {/* 兼容历史数据里可能存成大写（SLIM）的皮肤模型值 */}
      <PlayerCube3D
        skinSrc={skinSrc}
        capeSrc={capeSrc}
        skinH={skinH}
        slim={String(skinModel ?? '').toLowerCase() === 'slim'}
        size={size}
      />
      <span className="caption">{name}</span>
      <span className="caption" style={{ opacity: 0.55 }}>
        {t('home.model3d.hint')}
      </span>
    </div>
  )
}

/**
 * 单个贴图面：从皮肤 atlas 的 (x,y,w,h) 像素区域取图，映射到给定盒子尺寸。
 *
 * 关键：必须让「1 纹素 = unit 像素」——整张 atlas 横向缩放为 `64*unit`、纵向缩放为
 * `skinH*unit`（skinH = 皮肤实际高度，64 或 32），再按 `-x*unit / -y*unit` 偏移。
 * 这样每个面宽高正好是 `w*unit / h*unit`，与 3D 盒面精确吻合，纹理不被拉伸、相邻面
 * 之间也不会出现缝隙。
 *
 * 注意：旧版皮肤是 64×32（skinH=32），若仍按 64 缩放会把纹理纵向拉伸 2 倍，
 * 导致「外层较多的旧皮肤完全损坏」——故这里必须使用真实高度。
 */
function faceStyle(
  skinSrc: string,
  x: number,
  y: number,
  unit: number,
  bw: number,
  bh: number,
  skinH: number
): CSSProperties {
  return {
    position: 'absolute',
    width: bw,
    height: bh,
    backgroundImage: `url(${skinSrc})`,
    backgroundSize: `${64 * unit}px ${skinH * unit}px`,
    backgroundPosition: `${-x * unit}px ${-y * unit}px`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated',
    backfaceVisibility: 'hidden'
  }
}

/** 由 6 个面组成的方盒：尺寸 w(宽) × h(高) × d(厚)。faces 给出各面的贴图区域。 */
function Box({
  skinSrc,
  unit,
  skinH,
  w,
  h,
  d,
  faces,
  mirror = false
}: {
  skinSrc: string
  /** 1 皮肤纹素对应的像素数（整张皮肤按此缩放）。 */
  unit: number
  /** 皮肤实际高度（64 或 32），决定纵向缩放，避免旧版 64×32 皮肤被拉伸。 */
  skinH: number
  w: number
  h: number
  d: number
  /** 各面在皮肤上的像素区域（8×8 面拆成 top/bottom/side 条）。 */
  faces: {
    front: readonly [number, number, number, number]
    back: readonly [number, number, number, number]
    right: readonly [number, number, number, number]
    left: readonly [number, number, number, number]
    top: readonly [number, number, number, number]
    bottom: readonly [number, number, number, number]
  }
  /** 横向镜像贴图：旧版皮肤无左臂/左腿，用右臂/右腿镜像代替。 */
  mirror?: boolean
}): JSX.Element {
  // 关键：每个面都必须先摆到「盒子中心」，再绕中心旋转/平移。
  //
  // 因为 CSS 的 rotate 是绕元素自身中心（transform-origin: 50% 50%）进行的。若像
  // 之前那样把 6 个面都摆在盒子左上角 (0,0)，则立方体（w=h=d）恰好成立，但非立方体
  // 的顶/底面会被错位到盒子之外——例如 4×12×4 的手臂，其顶面中心会跑到 y=-4，
  // 换算到角色坐标正好落进头部（表现为「手臂贴图出现在头中间」）。
  //
  // 各面尺寸：前/后 w×h、左/右 d×h、上/下 w×d。要让中心都落在盒子中心 (w/2,h/2)：
  //   前/后：left=0,          top=0
  //   左/右：left=(w-d)/2,    top=0
  //   上/下：left=0,          top=(h-d)/2
  const f = (r: readonly [number, number, number, number], bw: number, bh: number, ox: number, oy: number): CSSProperties => ({
    ...faceStyle(skinSrc, r[0], r[1], unit, bw, bh, skinH),
    left: ox,
    top: oy
  })
  // 镜像时在每个面的旋转/平移之前加 scaleX(-1)：贴图绕自身中心翻转，位置不变。
  const m = (t: string): string => (mirror ? `scaleX(-1) ${t}` : t)
  return (
    <div style={{ position: 'absolute', width: w, height: h, transformStyle: 'preserve-3d' }}>
      {/* 前 / 后 */}
      <div style={{ ...f(faces.front, w, h, 0, 0), transform: m(`translateZ(${d / 2}px)`) }} />
      <div style={{ ...f(faces.back, w, h, 0, 0), transform: m(`rotateY(180deg) translateZ(${d / 2}px)`) }} />
      {/* 右 / 左 */}
      <div style={{ ...f(faces.right, d, h, (w - d) / 2, 0), transform: m(`rotateY(90deg) translateZ(${w / 2}px)`) }} />
      <div style={{ ...f(faces.left, d, h, (w - d) / 2, 0), transform: m(`rotateY(-90deg) translateZ(${w / 2}px)`) }} />
      {/* 上 / 下 */}
      <div
        style={{
          ...f(faces.top, w, d, 0, (h - d) / 2),
          transform: m(`rotateX(90deg) translateZ(${h / 2}px)`)
        }}
      />
      <div
        style={{
          ...f(faces.bottom, w, d, 0, (h - d) / 2),
          transform: m(`rotateX(-90deg) translateZ(${h / 2}px)`)
        }}
      />
    </div>
  )
}

/** 各部位的贴图区域（皮肤 64×64 像素坐标，区域宽高即该面的像素尺寸）。 */
const HEAD = {
  front: [8, 8, 8, 8],
  back: [24, 8, 8, 8],
  right: [0, 8, 8, 8],
  left: [16, 8, 8, 8],
  top: [8, 0, 8, 8],
  bottom: [16, 0, 8, 8]
} as const
const HAT = {
  front: [40, 8, 8, 8],
  back: [56, 8, 8, 8],
  right: [32, 8, 8, 8],
  left: [48, 8, 8, 8],
  top: [40, 0, 8, 8],
  bottom: [48, 0, 8, 8]
} as const
const TORSO = {
  front: [20, 20, 8, 12],
  back: [32, 20, 8, 12],
  right: [16, 20, 4, 12],
  left: [28, 20, 4, 12],
  top: [20, 16, 8, 4],
  bottom: [28, 16, 8, 4]
} as const
const JACKET = {
  front: [20, 36, 8, 12],
  back: [32, 36, 8, 12],
  right: [16, 36, 4, 12],
  left: [28, 36, 4, 12],
  top: [20, 32, 8, 4],
  bottom: [28, 32, 8, 4]
} as const
const R_ARM = {
  front: [44, 20, 4, 12],
  back: [52, 20, 4, 12],
  right: [40, 20, 4, 12],
  left: [48, 20, 4, 12],
  top: [44, 16, 4, 4],
  bottom: [48, 16, 4, 4]
} as const
const L_ARM = {
  front: [36, 52, 4, 12],
  back: [44, 52, 4, 12],
  right: [32, 52, 4, 12],
  left: [40, 52, 4, 12],
  top: [36, 48, 4, 4],
  bottom: [40, 48, 4, 4]
} as const
// 细手臂（Alex / slim）模型：手臂宽 3 像素（而非 4），深度仍为 4。
// 贴图坐标随之收窄：前/后/上/下面 3 宽，左/右面（深度）仍 4 宽。
// 若仍按 4 宽采样，会把旁边「未使用」的透明列（如右臂 x54-55）采进来，
// 表现为手臂背面出现缺口 / 纹理缺失。
const R_ARM_SLIM = {
  front: [44, 20, 3, 12],
  back: [51, 20, 3, 12],
  right: [40, 20, 4, 12],
  left: [47, 20, 4, 12],
  top: [44, 16, 3, 4],
  bottom: [47, 16, 3, 4]
} as const
const L_ARM_SLIM = {
  front: [36, 52, 3, 12],
  back: [43, 52, 3, 12],
  right: [32, 52, 4, 12],
  left: [39, 52, 4, 12],
  top: [36, 48, 3, 4],
  bottom: [39, 48, 3, 4]
} as const
const R_LEG = {
  front: [4, 20, 4, 12],
  back: [12, 20, 4, 12],
  right: [0, 20, 4, 12],
  left: [8, 20, 4, 12],
  top: [4, 16, 4, 4],
  bottom: [8, 16, 4, 4]
} as const
const L_LEG = {
  front: [20, 52, 4, 12],
  back: [28, 52, 4, 12],
  right: [16, 52, 4, 12],
  left: [24, 52, 4, 12],
  top: [20, 48, 4, 4],
  bottom: [24, 48, 4, 4]
} as const
// 披风：独立 64×32 贴图，模型为 10×16×1 的薄板。挂起后从背后看到的是贴图 (1,1) 处的
// 10×16「外侧面」（设计面），故映射到 Box 的 back 面（朝 -Z，即朝外）；(12,1) 为内侧（贴向身体）。
const CAPE = {
  front: [12, 1, 10, 16],
  back: [1, 1, 10, 16],
  right: [0, 1, 1, 16],
  left: [11, 1, 1, 16],
  top: [1, 0, 10, 1],
  bottom: [11, 0, 10, 1]
} as const

/** 组装完整角色：默认缓慢自转，可按住拖动自由旋转。单位：1 皮肤像素 = unit。 */
function PlayerCube3D({
  skinSrc,
  capeSrc,
  skinH,
  slim,
  size
}: {
  skinSrc: string
  /** 披风贴图（64×32）；为空则不渲染披风。 */
  capeSrc: string
  skinH: number
  /** 细手臂（Alex / slim）模型：手臂宽 3 像素、贴图坐标收窄。 */
  slim: boolean
  size: number
}): JSX.Element {
  // 模型整体高 32 像素（头 8 + 身 12 + 腿 12）；按目标尺寸换算单位。
  const unit = useMemo(() => size / 34, [size])
  const u = (n: number): number => n * unit
  // 旧版皮肤（64×32）：无左臂/左腿贴图、也无各部位外层。左臂/左腿用右臂/右腿镜像代替，
  // 并跳过外套外层（否则会采样到图片之外，显示为空/错乱）。
  const legacy = skinH === 32
  // 旧版皮肤一律按「粗手臂」处理（旧皮肤不含 slim 元数据）。
  const slimArm = slim && !legacy

  // 拖动旋转：外层「舞台」承载用户手动旋转角；内层自转动画在拖动时暂停。
  // 这样静止时自动缓慢自转，按住即可像转盘一样自由旋转到任意角度。
  const [dragging, setDragging] = useState(false)
  const [rot, setRot] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // 仅响应主键（鼠标左键 / 触摸 / 笔），右键菜单不触发旋转。
    if (e.button !== 0 && e.pointerType === 'mouse') return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效时忽略：不影响后续 move 事件（未捕获也能收到同一元素上的移动） */
    }
    dragRef.current = { x: e.clientX, y: e.clientY, rx: rot.x, ry: rot.y }
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    // 上下翻转限制在 ±89°，避免越过极点后视角翻转错乱。
    setRot({
      x: Math.max(-89, Math.min(89, d.rx - dy * 0.5)),
      y: d.ry + dx * 0.5
    })
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 释放失败忽略 */
    }
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        perspective: `${size * 4}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {/* 舞台：承载拖动交互与手动旋转角 */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: 'relative',
          width: u(16),
          height: u(32),
          transformStyle: 'preserve-3d',
          transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)`,
          cursor: dragging ? 'grabbing' : 'grab',
          // 触摸设备上禁用默认滚动手势，保证拖动旋转顺滑。
          touchAction: 'none',
          userSelect: 'none'
        }}
      >
        {/* 自转层：拖动时暂停动画（保留进度），松手后继续缓慢自转 */}
        <div
          className="player3d-spin"
          style={{
            position: 'absolute',
            inset: 0,
            transformStyle: 'preserve-3d',
            animationPlayState: dragging ? 'paused' : 'running'
          }}
        >
          {/* 头（含帽子外层）：外层比头大 1 像素，向外扩 0.5px 模拟游戏里的第二层 */}
          <div style={{ position: 'absolute', left: u(4), top: 0, transformStyle: 'preserve-3d' }}>
            <Box skinSrc={skinSrc} unit={unit} skinH={skinH} w={u(8)} h={u(8)} d={u(8)} faces={HEAD} />
            <div
              style={{
                position: 'absolute',
                left: u(-0.5),
                top: u(-0.5),
                transformStyle: 'preserve-3d'
              }}
            >
              <Box skinSrc={skinSrc} unit={unit} skinH={skinH} w={u(9)} h={u(9)} d={u(9)} faces={HAT} />
            </div>
          </div>

          {/* 身体（含外套外层）：旧版皮肤无外套外层，跳过 */}
          <div style={{ position: 'absolute', left: u(4), top: u(8), transformStyle: 'preserve-3d' }}>
            <Box skinSrc={skinSrc} unit={unit} skinH={skinH} w={u(8)} h={u(12)} d={u(4)} faces={TORSO} />
            {!legacy && (
              <div style={{ position: 'absolute', left: u(-0.25), top: u(-0.25), transformStyle: 'preserve-3d' }}>
                <Box skinSrc={skinSrc} unit={unit} skinH={skinH} w={u(8.5)} h={u(12.5)} d={u(4.5)} faces={JACKET} />
              </div>
            )}
          </div>

          {/* 右臂：slim（Alex）时宽 3 像素、贴图坐标收窄，并紧贴身体内侧 */}
          <div style={{ position: 'absolute', left: slimArm ? u(1) : u(0), top: u(8), transformStyle: 'preserve-3d' }}>
            <Box
              skinSrc={skinSrc}
              unit={unit}
              skinH={skinH}
              w={u(slimArm ? 3 : 4)}
              h={u(12)}
              d={u(4)}
              faces={slimArm ? R_ARM_SLIM : R_ARM}
            />
          </div>
          {/* 左臂：现代皮肤用专属贴图；旧版皮肤无左臂，用右臂镜像 */}
          <div style={{ position: 'absolute', left: u(12), top: u(8), transformStyle: 'preserve-3d' }}>
            <Box
              skinSrc={skinSrc}
              unit={unit}
              skinH={skinH}
              w={u(slimArm ? 3 : 4)}
              h={u(12)}
              d={u(4)}
              faces={legacy ? R_ARM : slimArm ? L_ARM_SLIM : L_ARM}
              mirror={legacy}
            />
          </div>
          {/* 右腿 */}
          <div style={{ position: 'absolute', left: u(4), top: u(20), transformStyle: 'preserve-3d' }}>
            <Box skinSrc={skinSrc} unit={unit} skinH={skinH} w={u(4)} h={u(12)} d={u(4)} faces={R_LEG} />
          </div>
          {/* 左腿：现代皮肤用专属贴图；旧版皮肤无左腿，用右腿镜像 */}
          <div style={{ position: 'absolute', left: u(8), top: u(20), transformStyle: 'preserve-3d' }}>
            <Box
              skinSrc={skinSrc}
              unit={unit}
              skinH={skinH}
              w={u(4)}
              h={u(12)}
              d={u(4)}
              faces={legacy ? R_LEG : L_LEG}
              mirror={legacy}
            />
          </div>

          {/* 披风：挂在背部（10×16×1，贴图 64×32）。置于躯干背面之后，从正面被身体遮挡 */}
          {capeSrc && (
            <div
              style={{
                position: 'absolute',
                left: u(3),
                top: u(8),
                transformStyle: 'preserve-3d',
                transform: `translateZ(${-2.5 * unit}px)`
              }}
            >
              <Box skinSrc={capeSrc} unit={unit} skinH={32} w={u(10)} h={u(16)} d={u(1)} faces={CAPE} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
