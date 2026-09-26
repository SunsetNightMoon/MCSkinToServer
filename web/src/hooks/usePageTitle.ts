import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/** 页面标题（plan3 同款）：null 表示使用默认标题 */
export function usePageTitle(title: string | null) {
  const { t } = useTranslation()

  useEffect(() => {
    document.title = title ? `${title} - MSCTS` : 'MSCTS'
  }, [title, t])
}
