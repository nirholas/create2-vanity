import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Five static pages, one shared module graph, and a dev proxy that puts the
 * real API on the same origin as the site — so `fetch('/api/…')` in the browser
 * is the identical call in dev, in preview and in production.
 */
export default defineConfig({
	build: {
		target: 'es2022',
		rollupOptions: {
			input: {
				index: resolve(import.meta.dirname, 'index.html'),
				deploy: resolve(import.meta.dirname, 'deploy.html'),
				verify: resolve(import.meta.dirname, 'verify.html'),
				docs: resolve(import.meta.dirname, 'docs.html'),
			},
		},
	},
	worker: { format: 'es' },
	server: {
		port: 5182,
		proxy: {
			'/api': { target: process.env.API_ORIGIN || 'http://127.0.0.1:8789', changeOrigin: true },
			'/.well-known': { target: process.env.API_ORIGIN || 'http://127.0.0.1:8789', changeOrigin: true },
			'/llms.txt': { target: process.env.API_ORIGIN || 'http://127.0.0.1:8789', changeOrigin: true },
			'/openapi.json': { target: process.env.API_ORIGIN || 'http://127.0.0.1:8789', changeOrigin: true },
		},
	},
});
