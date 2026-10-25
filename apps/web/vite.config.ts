import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 云 API 与本机 API 是两个独立进程：/api/cloud 必须先于 /api 匹配。
// 云端默认端口 4178，可用 ENDLESS_CLOUD_WEB_TARGET 指到别的开发实例。
const cloudTarget = process.env.ENDLESS_CLOUD_WEB_TARGET ?? 'http://127.0.0.1:4178';
const proxy = {
  '/api/cloud': { target: cloudTarget, changeOrigin: true },
  '/api': { target: 'http://127.0.0.1:4174', changeOrigin: true },
};

export default defineConfig({
  server: { proxy, port: 5173, strictPort: true },
  preview: { proxy, port: 4173, strictPort: true },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        id: '/',
        name: 'ENDLESS · 故事频道',
        short_name: 'ENDLESS',
        description: 'AI 续写互动故事。已保存的内容可离线阅读。',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f6f5f0',
        theme_color: '#f6f5f0',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
