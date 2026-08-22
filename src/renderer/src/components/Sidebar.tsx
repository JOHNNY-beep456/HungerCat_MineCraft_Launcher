import { motion } from 'motion/react'
import { Icon, Avatar } from './ui'
import { useApp } from '../store'
import { useRuntime } from '../runtime'

export type PageId = 'home' | 'resources' | 'instances' | 'downloads' | 'accounts' | 'settings' | 'about'

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'home', label: '启动游戏', icon: 'home' },
  { id: 'resources', label: '资源下载', icon: 'cube' },
  { id: 'instances', label: '实例', icon: 'box' },
  { id: 'downloads', label: '进度', icon: 'download' },
  { id: 'accounts', label: '账号', icon: 'user' },
  { id: 'settings', label: '设置', icon: 'settings' },
  { id: 'about', label: '关于', icon: 'info' }
]

export function Sidebar({
  active,
  onNavigate
}: {
  active: PageId
  onNavigate: (p: PageId) => void
}): JSX.Element {
  const { accounts, selectedAccount, settings } = useApp()
  const { downloads } = useRuntime()
  const nav = settings.mode === 'local' ? NAV.filter((n) => n.id !== 'resources' && n.id !== 'downloads' && n.id !== 'about') : NAV

  return (
    <aside className="flex h-full flex-col gap-3 p-4 pr-1">
      <nav className="glass-strong flex-1 rounded-[26px] p-2.5">
        <div className="flex flex-col gap-1">
          {nav.map((item) => {
            const isActive = active === item.id
            return (
              <button
                key={item.id}
                id={item.id === 'downloads' ? 'nav-download' : undefined}
                onClick={() => onNavigate(item.id)}
                className="relative flex items-center gap-3 rounded-[16px] px-3.5 py-2.5 text-left no-drag"
                style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              >
                {isActive && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-[16px]"
                    style={{ background: 'var(--fill-secondary)' }}
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <span className="relative z-10">
                  <Icon name={item.icon} size={19} />
                </span>
                <span className="relative z-10 text-[14px] font-medium">{item.label}</span>
                {item.id === 'downloads' && downloads.length > 0 && (
                  <span
                    className="relative z-10 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white"
                    style={{ background: 'var(--fill-primary)' }}
                  >
                    {downloads.length}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </nav>

      {settings.mode !== 'normal' && (
        <div className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
          <Icon name="info" size={14} className="opacity-60" />
          <span className="text-[12px] font-medium opacity-80">
            {settings.mode === 'local' ? '本地模式' : '极简模式'}
          </span>
        </div>
      )}

      <button
        onClick={() => onNavigate('accounts')}
        className="glass-strong flex items-center gap-2.5 rounded-[22px] p-2.5 no-drag transition-transform active:scale-[0.97]"
      >
        <Avatar name={selectedAccount?.name} uuid={selectedAccount?.id} skinUrl={selectedAccount?.skinUrl} authType={selectedAccount?.authType} yggdrasilServer={selectedAccount?.yggdrasilServer} size={38} />
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[13px] font-semibold leading-tight">
            {selectedAccount?.name ?? '未登录'}
          </div>
          <div className="caption">{accounts.length} 个账号</div>
        </div>
      </button>
    </aside>
  )
}
