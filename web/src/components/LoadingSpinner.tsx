import { useTranslation } from 'react-i18next';

/** 简单加载占位（plan3 同款组件移植） */
export function LoadingSpinner() {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '200px',
      }}
    >
      <div>{t('common.loading')}</div>
    </div>
  );
}
