import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发服务器代理到后端（MSCTS 端口 3000）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/authserver': 'http://localhost:3000',
      '/sessionserver': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
