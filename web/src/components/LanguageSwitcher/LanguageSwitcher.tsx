import React from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from 'antd'
import { useI18nStore } from '../../store/i18nStore'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import type { SelectProps } from 'antd'

const LanguageSwitcher: React.FC<SelectProps> = (props) => {
  const { i18n } = useTranslation()
  const { setLanguage } = useI18nStore()

  const handleChange = (value: string) => {
    setLanguage(value)
  }

  return (
    <Select
      value={i18n.language}
      onChange={handleChange}
      style={{ minWidth: 120 }}
      options={SUPPORTED_LANGUAGES.map((lang) => ({
        value: lang.code,
        label: lang.name,
      }))}
      {...props}
    />
  )
}

export default LanguageSwitcher
