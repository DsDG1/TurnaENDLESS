import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 云 API 与本机 API 是两个独立进程：/api/cloud 必须先于 /api 匹配。
// 云端默认端口 4178，可用 ENDLESS_CLOUD_WEB_TARGET 指到别的开发实例。
const cloudTarget = process.env.ENDLESS_CLOUD_WEB_TARGET ?? 'http://127.0.0.1:4178';
export default defineConfig(({ mode }) => {
  const connected = mode === 'cloud';
  const proxy: Record<string, ProxyOptions> = connected ? {
    '/api/cloud': { target: cloudTarget, changeOrigin: true },
    '/api': { target: 'http://127.0.0.1:4174', changeOrigin: true },
  } : {
    '^/api/(?!cloud(?:/|$))': { target: 'http://127.0.0.1:4174', changeOrigin: true },
  };
  const isolation: Plugin = {
    name: 'endless-runtime-isolation',
    generateBundle(_options, bundle) {
      const modules = [...new Set(Object.values(bundle).flatMap(output => output.type === 'chunk' ? Object.keys(output.modules) : []))].sort();
      const forbidden = connected ? [] : modules.filter(id => /\/src\/cloud\/|\/packages\/cloud-contracts\/|\/content\/src\/(?:cloud[^/]*|reader-index)\.[tj]s/.test(id.replaceAll('\\', '/')));
      if (forbidden.length) this.error(`Local build contains cloud implementation:\n${forbidden.join('\n')}`);
      const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
      const paths = modules.map(id => {
        const name = id.replaceAll('\\', '/').replaceAll('\0', '');
        if (name.startsWith(root)) return name.slice(root.length);
        const dependency = name.indexOf('/node_modules/');
        return dependency >= 0 ? name.slice(dependency + 1) : `external:${name.split('/').at(-1)}`;
      });
      this.emitFile({ type: 'asset', fileName: 'runtime-modules.json', source: JSON.stringify({ profile: connected ? 'cloud' : 'local', modules: paths }, null, 2) });
    },
  };
  return {
  resolve: { alias: [{ find: /^\.\/integration\.js$/, replacement: fileURLToPath(new URL(connected ? './src/cloud/integration.tsx' : './src/integration.tsx', import.meta.url)) }] },
  build: { outDir: connected ? 'dist-cloud' : 'dist' },
  server: { proxy, port: connected ? 5178 : 5173, strictPort: true },
  preview: { proxy, port: connected ? 4183 : 4173, strictPort: true },
  plugins: [
    react(),
    isolation,
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
  };
});
