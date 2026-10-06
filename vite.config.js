import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  const connectSources = ["'self'"];
  const configuredApiUrl = process.env.VITE_API_BASE_URL?.trim();
  if (configuredApiUrl) {
    try {
      const apiUrl = new URL(configuredApiUrl);
      if (apiUrl.protocol === 'https:' || apiUrl.protocol === 'http:') connectSources.push(apiUrl.origin);
    } catch {
      // Relative API paths are covered by 'self'.
    }
  }

  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
  ].join('; ');

  return {
    plugins: [
      react(),
      ...(command === 'build' ? [{
        name: 'production-content-security-policy',
        transformIndexHtml(html) {
          return html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">\n  </head>`);
        },
      }] : []),
    ],
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: process.env.API_SERVER_URL || 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4173,
      host: '0.0.0.0',
      headers: {
        'Content-Security-Policy': contentSecurityPolicy,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      },
    },
  };
});
