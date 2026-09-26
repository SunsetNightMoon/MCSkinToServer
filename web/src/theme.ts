import type { ThemeConfig } from 'antd';

/** 全站主题：直角矩形 + #0078d7 蓝（用户偏好：无圆角、蓝色高光、卡片式、充足留白） */
export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0078d7',
    borderRadius: 0,
    colorBorder: '#d9d9d9',
    colorBorderSecondary: '#f0f0f0',
    fontSize: 14,
  },
  components: {
    Card: { borderRadiusLG: 0 },
    Button: { borderRadius: 0, borderRadiusLG: 0, borderRadiusSM: 0 },
    Input: { borderRadius: 0 },
    Select: { borderRadius: 0 },
    Table: { borderRadius: 0, headerBorderRadius: 0 },
    Modal: { borderRadiusLG: 0 },
    Menu: { itemBorderRadius: 0 },
    Tag: { borderRadiusSM: 0 },
  },
};
