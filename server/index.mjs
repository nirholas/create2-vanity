#!/usr/bin/env node
/**
 * Node host for the create2-vanity API.
 *
 * Bridges `node:http` to the Fetch-API handler in `app.mjs`, then falls through
 * to the built site in `dist/` for anything the API did not claim. That means
 * one process serves both in production (`npm run build && npm start`), while in
 * development Vite serves the site and proxies `/api` here.
 *
 *   PORT                 default 8787
 *   ATTESTATION_KEY     32-byte secp256k1 key for signing attestations
 *   ALLOW_SERVER_GRIND   set to 1 to enable the custodial /api/grind endpoint
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle, SERVICE } from './app.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8789);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
	const origin = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
	let request;
	try {
		request = toRequest(req, origin);
	} catch {
		res.writeHead(400).end('bad request');
		return;
	}

	let response = null;
	try {
		response = await handle(request, process.env);
	} catch (err) {
		console.error('unhandled', err);
		res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal error"}');
		return;
	}

	if (response) {
		await sendResponse(res, response);
		return;
	}
	serveStatic(req, res);
});

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} origin
 * @returns {Request}
 */
function toRequest(req, origin) {
	const url = new URL(req.url || '/', origin);
	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	return new Request(url, {
		method: req.method,
		headers: /** @type {any} */ (req.headers),
		// Node streams are async iterables; Request accepts one with duplex:'half'.
		...(hasBody ? { body: /** @type {any} */ (req), duplex: 'half' } : {}),
	});
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 */
async function sendResponse(res, response) {
	const headers = {};
	response.headers.forEach((value, key) => { headers[key] = value; });
	res.writeHead(response.status, headers);
	if (!response.body) { res.end(); return; }
	const buf = Buffer.from(await response.arrayBuffer());
	res.end(buf);
}

/**
 * Serve the built site. Unknown paths fall back to a 404 page rather than
 * silently returning index.html, so a broken link is visible instead of looking
 * like the home page.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function serveStatic(req, res) {
	if (!existsSync(DIST)) {
		res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
			.end(`${SERVICE.name} API is running, but the site has not been built.\nRun: npm run build\n`);
		return;
	}
	const url = new URL(req.url || '/', 'http://localhost');
	let pathname = decodeURIComponent(url.pathname);
	if (pathname.endsWith('/')) pathname += 'index.html';

	// normalize() collapses `..`; the prefix check then guarantees the resolved
	// path cannot escape dist/, which is the whole traversal defence.
	const filePath = normalize(join(DIST, pathname));
	if (!filePath.startsWith(DIST)) {
		res.writeHead(403).end('forbidden');
		return;
	}
	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
		return;
	}
	const type = MIME[extname(filePath)] || 'application/octet-stream';
	const immutable = filePath.includes('/assets/');
	res.writeHead(200, {
		'content-type': type,
		'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
	});
	createReadStream(filePath).pipe(res);
}

server.listen(PORT, () => {
	console.log(`${SERVICE.name} v${SERVICE.version} listening on http://127.0.0.1:${PORT}`);
	console.log(`  API      http://127.0.0.1:${PORT}/api/health`);
	console.log(`  OpenAPI  http://127.0.0.1:${PORT}/openapi.json`);
	console.log(`  Site     ${existsSync(DIST) ? `http://127.0.0.1:${PORT}/` : 'not built (npm run build)'}`);
});
