import { useEffect, useState } from 'react'
import { useApp } from '../../store'
import { Button } from '../../components/ui'
import { Row } from './parts'

/** 原生组件管理：安装成功后才能打开；不把旧网页皮肤当作下载失败的替代品。 */
export function Pccl2ComponentRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const [url, setUrl] = useState(settings.pccl2ManifestUrl)
  const [installed, setInstalled] = useState(false)
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [percent, setPercent] = useState<number | null>(null)
  const [supported, setSupported] = useState(window.api.platform === 'win32')
  const refresh = async (): Promise<void> => {
    const status = await window.api.pccl2.status()
    setSupported(status.supported)
    setInstalled(status.installed)
    setVersion(status.version ?? '')
  }
  useEffect(() => { void refresh().catch((e) => setError(String(e))) }, [])
  useEffect(() => window.api.pccl2.onProgress((p) => {
    setPercent(p.total && p.total > 0 ? Math.min(100, Math.max(0, Math.round((p.received ?? 0) * 100 / p.total))) : null)
  }), [])
  const run = async (install: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (install) {
        const parsed = new URL(url.trim())
        if (parsed.protocol !== 'https:') throw new Error(t('pccl2.component.https'))
        await updateSettings({ pccl2ManifestUrl: parsed.href })
        await window.api.pccl2.install()
        await refresh()
      } else {
        await window.api.pccl2.open()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="glass-soft space-y-3 rounded-xl p-3">
      <Row label={t('pccl2.component.title')} desc={t('pccl2.component.description')}>
        <span className="caption">{supported ? (installed ? version : t('pccl2.component.missing')) : t('pccl2.component.windows')}</span>
      </Row>
      <label className="block text-[13px]">
        {t('pccl2.component.url')}
        <input className="input mt-1 w-full" type="url" value={url} disabled={!supported || busy}
          placeholder="https://example.com/PCCL2-PAK/manifest.json"
          onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!supported || busy || !url.trim() || settings.mode === 'local'} onClick={() => void run(true)}>
          {busy ? t('pccl2.component.working') : t('pccl2.component.install')}
        </Button>
        <Button disabled={!supported || busy || !installed} onClick={() => void run(false)}>{t('pccl2.component.open')}</Button>
      </div>
      {busy && percent !== null && <progress className="w-full" max={100} value={percent} aria-label={t('pccl2.component.working')} />}
      {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--fill-danger)' }}>{error}</p>}
    </div>
  )
}
