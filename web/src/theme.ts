import type { ThemeConfig } from 'antd';
import { theme as antdThemeUtil } from 'antd';
import type { SiteTheme } from './store/site';

/**
 * AntD 主题（沿用 plan3 设计语言）：
 * - 暗色默认：深蓝夜空 + #4a9eff 强调色 + 玻璃拟态
 * - 亮色：白底卡片 + #2563eb 强调色
 * 圆角与旧版一致（6/8px，整体观感圆角现代风）。
 */

const base = {
  fontSize: 14,
  borderRadius: 6,
};

export function getAntdTheme(theme: SiteTheme): ThemeConfig {
  if (theme === 'dark') {
    return {
      algorithm: antdThemeUtil.darkAlgorithm,
      token: {
        ...base,
        colorPrimary: '#4a9eff',
        colorInfo: '#4a9eff',
        colorBgBase: '#0d2a4a',
        colorBgContainer: 'rgba(255, 255, 255, 0.06)',
        colorBgElevated: '#13355c',
        colorBorder: 'rgba(255, 255, 255, 0.18)',
        colorBorderSecondary: 'rgba(255, 255, 255, 0.1)',
        colorText: 'rgba(255, 255, 255, 0.9)',
        colorTextSecondary: 'rgba(255, 255, 255, 0.65)',
      },
      components: {
        Card: { colorBgContainer: 'rgba(255, 255, 255, 0.06)' },
        Table: { colorBgContainer: 'transparent', headerBg: 'rgba(255, 255, 255, 0.06)' },
        Modal: { contentBg: '#0d2a4a', headerBg: 'transparent' },
        Popconfirm: { colorTextBase: 'rgba(255,255,255,0.9)' },
      },
    };
  }
  return {
    algorithm: antdThemeUtil.defaultAlgorithm,
    token: {
      ...base,
      colorPrimary: '#2563eb',
      colorInfo: '#2563eb',
      colorBgBase: '#f5f7fa',
    },
    components: {
      Table: { headerBg: 'rgba(0, 0, 0, 0.04)' },
    },
  };
}
