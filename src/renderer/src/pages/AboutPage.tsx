import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AboutGroup, AboutPerson } from '@shared/types'
import { Button, Icon, LoadingState } from '../components/ui'

export function AboutPage(): JSX.Element {
  const [groups, setGroups] = useState<AboutGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkPerson, setLinkPerson] = useState<AboutPerson | null>(null)

  const load = async (): Promise<void> => {
    setError(null)
    try {
      setGroups(await window.api.about.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const openUrl = (url: string): void => {
    void window.api.shell.openExternal(url)
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">关于</h1>
          <p className="caption mt-1">Hunger Cat 启动器 · 制作团队与相关链接</p>
        </div>
        <Button icon="refresh" onClick={() => void load()}>
          刷新
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {error && (
          <div className="glass mb-4 rounded-2xl p-4 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
            获取关于信息失败：{error}
          </div>
        )}

        {groups === null && !error ? (
          <LoadingState text="正在获取关于信息…" />
        ) : !Array.isArray(groups) || groups.length === 0 ? (
          <div className="glass rounded-[24px] p-8 text-center text-[13px] opacity-60">
            暂无关于信息
          </div>
        ) : (
          <div className="space-y-6 pb-4">
            {groups.map((group) => (
              <div key={group.id}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="title">{group.name}</span>
                  <span className="chip">{(group.people ?? []).length}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {(group.people ?? []).map((person) => (
                    <PersonCard key={person.id} person={person} onMore={() => setLinkPerson(person)} onOpen={openUrl} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 多链接弹窗：询问去哪个链接（都写名，不直接展示 URL） */}
      <AnimatePresence>
        {linkPerson && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              onClick={() => setLinkPerson(null)}
            />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="title">{linkPerson.name}</span>
                <button className="no-drag opacity-60 hover:opacity-100" onClick={() => setLinkPerson(null)}>
                  <Icon name="xmark" size={18} />
                </button>
              </div>
              <p className="caption mb-4">选择一个链接前往：</p>
              <div className="space-y-2">
                {linkPerson.links.map((link) => (
                  <button
                    key={link.url}
                    className="glass-soft flex w-full items-center justify-between rounded-xl px-4 py-3 no-drag transition-transform active:scale-[0.98]"
                    onClick={() => {
                      openUrl(link.url)
                      setLinkPerson(null)
                    }}
                  >
                    <span className="text-[14px] font-medium">{link.name}</span>
                    <Icon name="link" size={16} className="opacity-60" />
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function PersonCard({
  person,
  onMore,
  onOpen
}: {
  person: AboutPerson
  onMore: () => void
  onOpen: (url: string) => void
}): JSX.Element {
  const links = Array.isArray(person.links) ? person.links : []
  const single = links.length === 1
  const multiple = links.length > 1
  return (
    <div className="glass flex items-center gap-3 rounded-[20px] p-4">
      <PersonAvatar person={person} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold">{person.name}</div>
        {person.role && <div className="caption truncate">{person.role}</div>}
      </div>
      <div className="shrink-0">
        {single && (
          <Button size="sm" icon="link" onClick={() => onOpen(links[0].url)}>
            {links[0].name}
          </Button>
        )}
        {multiple && (
          <Button size="sm" icon="link" onClick={onMore}>
            更多…
          </Button>
        )}
      </div>
    </div>
  )
}

function PersonAvatar({ person }: { person: AboutPerson }): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [person.avatar])
  if (person.avatar && !failed) {
    return (
      <img
        src={person.avatar}
        alt={person.name}
        width={40}
        height={40}
        className="h-10 w-10 shrink-0 rounded-xl object-cover"
        draggable={false}
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[18px] font-bold text-white"
      style={{ background: 'var(--fill-primary)' }}
    >
      {person.name.charAt(0).toUpperCase()}
    </div>
  )
}
