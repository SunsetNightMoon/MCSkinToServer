import { useTranslation } from 'react-i18next';

export function LoadingSpinner() {
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '200px',
    }}>
      <div>{t('common.loading', 'Loading...')}</div>
    </div>
  );
}
