import { cfFetch } from '../curseforge'
import { defaultCurseforgeKey } from '../curseforge-key'
import { netRequest } from '../broker'

/** 只提供社区资源元数据；下载与本地安装仍由 HCMCL 的安装器处理。 */
export async function nativeResourceMetadata(params: { url?: unknown; method?: unknown; content?: unknown }): Promise<unknown> {
  if (typeof params.url !== 'string' || params.url.length > 16384) throw new Error('invalid metadata URL')
  const url = new URL(params.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('invalid metadata origin')
  const method = params.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') throw new Error('metadata method not allowed')
  if (url.hostname === 'api.curseforge.com') {
    // search 必须单独匹配，不能被当成 mods/{项目 ID}。
    const get = /^\/v1\/(?:mods\/search|mods\/\d+(?:\/files(?:\/\d+)?)?|categories)$/.test(url.pathname)
    const post = /^\/v1\/mods(?:\/files)?$/.test(url.pathname)
    if ((method === 'GET' && !get) || (method === 'POST' && !post)) throw new Error('CurseForge metadata path not allowed')
    const key = defaultCurseforgeKey()
    if (!key) throw new Error('尚未配置 CurseForge API Key，请在 HCMCL 设置中配置；也可将来源切换为 Modrinth')
    let body: unknown
    if (method === 'POST') {
      if (typeof params.content !== 'string' || params.content.length > 65536) throw new Error('invalid metadata body')
      body = JSON.parse(params.content)
      const ids = (body as any)?.[url.pathname.endsWith('/files') ? 'fileIds' : 'modIds']
      if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('invalid CurseForge ids')
    }
    return cfFetch(key, url.pathname.slice(3) + url.search, method === 'POST' ? { method, body } : undefined)
  }
  if (url.hostname === 'api.modrinth.com') {
    if (method !== 'GET' || !/^\/v2\/(?:search|project\/[A-Za-z0-9_.+-]+(?:\/version)?|version\/[A-Za-z0-9_.+-]+|projects|versions|tag\/[a-z_]+)$/.test(url.pathname)) throw new Error('Modrinth metadata path not allowed')
    return netRequest('net:fetchJson', { url: url.href })
  }
  throw new Error('metadata host not allowed')
}
