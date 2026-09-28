import { Dropdown } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import { useI18nStore } from '../../store/i18nStore'

/**
 * 语言切换的唯一实现：四语言列表、当前语言高亮、写入方式都在这里。
 *
 * 切换必须走 `useI18nStore.setLanguage` 而不是直接写 localStorage —— 站点默认语言
 * 只在访客没主动选过语言时生效（见 i18nStore 的 `userChosen`），绕过 store 的话
 * `userChosen` 永远是 false，访客自己挑的语言下次进站就被站点默认盖掉。
 *
 * 样式靠外部传入的类名复用现有两套外观（认证页右上角按钮 / 顶栏图标按钮），
 * 因此这里只管行为与列表，不带自己的 CSS。
 */
export function LanguageSwitcher({
  buttonClassName,
  wrapperClassName,
  overlayClassName,
}: {
  buttonClassName: string
  /** 认证页需要一个绝对定位的外层容器，顶栏在 flex 里不需要 */
  wrapperClassName?: string
  overlayClassName?: string
}) {
  const { t, i18n } = useTranslation()
  const setLanguage = useI18nStore((state) => state.setLanguage)

  const dropdown = (
    <Dropdown
      placement="bottomRight"
      overlayClassName={overlayClassName}
      menu={{
        items: SUPPORTED_LANGUAGES.map((lang) => ({
          key: lang.code,
          label: <span>{lang.name}</span>,
        })),
        selectedKeys: [i18n.language],
        onClick: ({ key }) => setLanguage(key),
      }}
    >
      <button type="button" className={buttonClassName} title={t('common.language')}>
        <GlobalOutlined />
      </button>
    </Dropdown>
  )

  return wrapperClassName ? <div className={wrapperClassName}>{dropdown}</div> : dropdown
}
