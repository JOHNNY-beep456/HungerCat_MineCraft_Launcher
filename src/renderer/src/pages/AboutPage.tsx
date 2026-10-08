import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AboutGroup, AboutPerson } from '@shared/types'
import { useApp } from '../store'
import { useAutoTranslate } from '../translate'
import { Button, Icon, LoadingState } from '../components/ui'

export function AboutPage(): JSX.Element {
  const { t } = useApp()
  const [groups, setGroups] = useState<AboutGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkPerson, setLinkPerson] = useState<AboutPerson | null>(null)

  // 「关于」文案自动翻译：仅收集**可译文本**——分组名、职位描述、链接名。
  // 人名（person.name）是专有名词，**始终不翻译**，故不纳入待译集合；语言检测后
  // 已是设置语言的条目会自动跳过（不发起请求）。
  const translatables = useMemo(() => {
    const list: string[] = []
    for (const g of groups ?? []) {
      list.push(g.name)
      for (const p of g.people ?? []) {
        if (p.role) list.push(p.role)
        for (const l of p.links ?? []) list.push(l.name)
      }
    }
    return list
  }, [groups])
  const tr = useAutoTranslate(translatables)

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
          <h1 className="display">{t('about.title')}</h1>
          <p className="caption mt-1">{t('about.subtitle')}</p>
        </div>
        <Button icon="refresh" onClick={() => void load()}>
          {t('about.refresh')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {error && (
          <div className="glass mb-4 rounded-2xl p-4 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
            {t('about.loadError', { msg: error })}
          </div>
        )}

        {groups === null && !error ? (
          <LoadingState text={t('about.loading')} />
        ) : !Array.isArray(groups) || groups.length === 0 ? (
          <div className="glass rounded-[24px] p-8 text-center text-[13px] opacity-60">
            {t('about.empty')}
          </div>
        ) : (
          <div className="space-y-6 pb-4">
            {groups.map((group) => (
              <div key={group.id}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="title">{tr(group.name)}</span>
                  <span className="chip">{(group.people ?? []).length}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {(group.people ?? []).map((person, i) => (
                    <motion.div
                      key={person.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ type: 'spring', bounce: 0, duration: 0.3, delay: Math.min(i * 0.03, 0.2) }}
                    >
                      <PersonCard person={person} tr={tr} onMore={() => setLinkPerson(person)} onOpen={openUrl} />
                    </motion.div>
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
                {/* 人名始终原文。 */}
                <span className="title">{linkPerson.name}</span>
                <button className="no-drag opacity-60 hover:opacity-100" onClick={() => setLinkPerson(null)}>
                  <Icon name="xmark" size={18} />
                </button>
              </div>
              <p className="caption mb-4">{t('about.chooseLink')}</p>
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
                    <span className="text-[14px] font-medium">{tr(link.name)}</span>
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
  tr,
  onMore,
  onOpen
}: {
  person: AboutPerson
  tr: (text: string | undefined) => string
  onMore: () => void
  onOpen: (url: string) => void
}): JSX.Element {
  const { t } = useApp()
  const links = Array.isArray(person.links) ? person.links : []
  const single = links.length === 1
  const multiple = links.length > 1
  return (
    <div className="glass flex items-center gap-3 rounded-[20px] p-4">
      <PersonAvatar person={person} />
      <div className="min-w-0 flex-1">
        {/* 人名是专有名词，始终显示原文、不翻译。 */}
        <div className="truncate text-[14px] font-semibold">{person.name}</div>
        {person.role && <div className="caption truncate">{tr(person.role)}</div>}
      </div>
      <div className="shrink-0">
        {single && (
          <Button size="sm" icon="link" onClick={() => onOpen(links[0].url)}>
            {tr(links[0].name)}
          </Button>
        )}
        {multiple && (
          <Button size="sm" icon="link" onClick={onMore}>
            {t('about.more')}
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
