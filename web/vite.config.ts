import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// 后端地址：dev 与 preview 都需要代理 /api 等前缀（否则生产构建无法本地联调）
const BACKEND = 'http://localhost:3000';
const proxy = {
  '/api': BACKEND,
  '/uploads': BACKEND,
  '/authserver': BACKEND,
  '/sessionserver': BACKEND,
};

// 开发服务器代理到后端（MCSTS 端口 3000）
export default defineConfig({
  plugins: [react()],
  // 页脚版本号等展示统一取 web/package.json 的 version（口径见 README 顶部），
  // 不再在组件里写死字面量。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy,
  },
  // 用于对生产构建做冒烟验证：vite preview 默认不带代理
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 按第三方库族拆分 chunk：首屏只需 core + antd，3D/图表/编辑器按路由懒加载
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // monaco 必须最先判定：@monaco-editor/react 内含 react 字样
          if (id.includes('monaco-editor')) return 'vendor-monaco';
          if (id.includes('three') || id.includes('skinview3d')) return 'vendor-three';
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) return 'vendor-charts';
          if (id.includes('antd') || id.includes('@ant-design') || id.includes('rc-')) return 'vendor-antd';
          // React 及其依赖族必须收在同一个 chunk 里：若把 react 单独拆出去、其余落到
          // 另一个兜底 chunk，会形成 vendor <-> vendor-react 的循环 chunk 引用，
          // Rollup 会告警且存在 TDZ 运行时风险。
          return 'vendor-core';
        },
      },
    },
  },
});
