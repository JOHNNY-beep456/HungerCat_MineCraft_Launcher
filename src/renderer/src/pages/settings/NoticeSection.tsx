import { AutoSection } from './AutoSection'

/** 「公告」板块：启动时展示公告的范围。 */
export function NoticeSection(): JSX.Element {
  return (
    <AutoSection
      section="notice"
      titleKey="settings.section.notice"
      icon="message"
      footnotes={['settings.hint.announcementDisplay']}
    />
  )
}
