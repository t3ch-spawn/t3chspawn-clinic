import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Set VITE_SITE_URL for a custom domain; hosted defaults are detected automatically.
  const hostedDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const configuredUrl = process.env.VITE_SITE_URL || env.VITE_SITE_URL
    || process.env.RENDER_EXTERNAL_URL || (hostedDomain ? `https://${hostedDomain}` : '');
  const siteUrl = configuredUrl ? new URL(configuredUrl) : null;
  if (siteUrl && !['http:', 'https:'].includes(siteUrl.protocol)) throw new Error('VITE_SITE_URL must be an http or https URL.');

  return {
    plugins: [react(), tailwindcss(), {
      name: 'clinic-social-metadata',
      transformIndexHtml(html) {
        if (!siteUrl) return html;
        const origin = siteUrl.origin;
        return {
          html: html.replaceAll('content="/og-image.png"', `content="${origin}/og-image.png"`),
          tags: [
            { tag: 'link', attrs: { rel: 'canonical', href: `${origin}/` }, injectTo: 'head' },
            { tag: 'meta', attrs: { property: 'og:url', content: `${origin}/` }, injectTo: 'head' },
          ],
        };
      },
    }],
    server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
  };
});
