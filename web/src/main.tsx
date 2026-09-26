import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import zhTW from 'antd/locale/zh_TW';
import enUS from 'antd/locale/en_US';
import jaJP from 'antd/locale/ja_JP';
import { getAntdTheme } from './theme';
import { useSiteStore } from './store/site';
import i18n from './i18n';
import { App } from './App';
import './index.css';

const ANTD_LOCALES: Record<string, typeof zhCN> = {
  SCH: zhCN,
  TCH: zhTW,
  EN: enUS,
  JP: jaJP,
};

function Root() {
  const theme = useSiteStore((s) => s.theme);
  const [language, setLanguage] = React.useState(i18n.language || 'SCH');

  React.useEffect(() => {
    const onChange = (lng: string) => setLanguage(lng);
    i18n.on('languageChanged', onChange);
    return () => {
      i18n.off('languageChanged', onChange);
    };
  }, []);

  return (
    <ConfigProvider
      locale={ANTD_LOCALES[language] ?? zhCN}
      theme={getAntdTheme(theme)}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
