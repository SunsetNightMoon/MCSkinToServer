import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getAntdTheme } from './theme';
import { useSiteStore } from './store/site';
import { App } from './App';
import './index.css';

function Root() {
  const theme = useSiteStore((s) => s.theme);
  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(theme)}>
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
