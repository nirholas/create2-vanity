/**
 * A tiny Fetch-API router.
 *
 * The API has to run in two places that agree on almost nothing: Node (for
 * `npm start`, Docker and Cloud Run) and a Cloudflare Worker (for the edge
 * deploy). Both understand the Fetch API's `Request` and `Response`, so the
 * whole application is written as one `(Request, env) => Promise<Response>`
 * function and each runtime gets a thin adapter instead of its own server.
 *
 * That is also why there is no framework here: a router, a JSON helper and an
 * error boundary are the entire surface this project needs, and a dependency
 * that has to be audited for both runtimes is a worse trade than forty lines.
 */

/** @typedef {{ req: Request, env: any, url: URL, params: Record<string,string> }} Ctx */
/** @typedef {(ctx: Ctx) => Response | Promise<Response>} Handler */

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'content-type',
	'access-control-max-age': '86400',
};

/**
 * JSON response with CORS and an explicit cache policy.
 * @param {any} body
 * @param {{ status?: number, cache?: string, headers?: Record<string,string> }} [init]
 * @returns {Response}
 */
export function json(body, init = {}) {
	return new Response(JSON.stringify(body, jsonSafe, init.status && init.status >= 400 ? 0 : 1), {
		status: init.status || 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': init.cache || 'no-store',
			...CORS,
			...(init.headers || {}),
		},
	});
}

/**
 * `Infinity` is a real answer here (an unreachable pattern needs infinitely many
 * attempts) but it is not valid JSON, and `JSON.stringify` silently turns it
 * into `null`, which reads as "no data" instead of "impossible". Render it as a
 * string the client can detect.
 * @param {string} _key
 * @param {any} value
 */
function jsonSafe(_key, value) {
	if (typeof value === 'number' && !Number.isFinite(value)) {
		return value > 0 ? 'Infinity' : (value < 0 ? '-Infinity' : null);
	}
	if (typeof value === 'bigint') return value.toString();
	return value;
}

/**
 * Plain-text response with CORS.
 * @param {string} text
 * @param {{ status?: number, type?: string, cache?: string }} [init]
 * @returns {Response}
 */
export function text(text_, init = {}) {
	return new Response(text_, {
		status: init.status || 200,
		headers: {
			'content-type': init.type || 'text/plain; charset=utf-8',
			'cache-control': init.cache || 'public, max-age=300',
			...CORS,
		},
	});
}

/**
 * A client error carrying an HTTP status. Thrown by handlers, rendered by the
 * error boundary, never leaked as a stack trace.
 */
export class HttpError extends Error {
	/** @param {number} status @param {string} message @param {any} [details] */
	constructor(status, message, details) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.details = details;
	}
}

/** @param {any} cond @param {string} message @param {number} [status] */
export function assert(cond, message, status = 400) {
	if (!cond) throw new HttpError(status, message);
}

/**
 * Read and validate a JSON body.
 * @param {Request} req
 * @returns {Promise<Record<string, any>>}
 */
export async function body(req) {
	const type = req.headers.get('content-type') || '';
	if (!type.includes('application/json')) throw new HttpError(415, 'send content-type: application/json');
	let parsed;
	try {
		parsed = await req.json();
	} catch {
		throw new HttpError(400, 'body is not valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new HttpError(400, 'body must be a JSON object');
	}
	return parsed;
}

/** Build a router. */
export function createRouter() {
	/** @type {{ method: string, pattern: RegExp, keys: string[], handler: Handler }[]} */
	const routes = [];

	/**
	 * @param {string} method
	 * @param {string} path supports `:name` segments
	 * @param {Handler} handler
	 */
	function add(method, path, handler) {
		const keys = [];
		const pattern = new RegExp(
			'^' + path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$',
		);
		routes.push({ method, pattern, keys, handler });
	}

	return {
		/** @param {string} path @param {Handler} h */
		get: (path, h) => add('GET', path, h),
		/** @param {string} path @param {Handler} h */
		post: (path, h) => add('POST', path, h),

		/**
		 * @param {Request} req
		 * @param {any} [env]
		 * @returns {Promise<Response|null>} null when no route matched, so a host
		 *   can fall through to static assets.
		 */
		async handle(req, env = {}) {
			const url = new URL(req.url);
			if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

			for (const route of routes) {
				if (route.method !== req.method) continue;
				const m = route.pattern.exec(url.pathname);
				if (!m) continue;
				const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
				try {
					return await route.handler({ req, env, url, params });
				} catch (err) {
					if (err instanceof HttpError) {
						return json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, { status: err.status });
					}
					// An unexpected throw is a bug in this service, not the caller's
					// fault: log it where the operator can see it and return a stable
					// shape rather than a stack trace.
					console.error(`[${req.method} ${url.pathname}]`, err);
					return json({ error: 'internal error' }, { status: 500 });
				}
			}

			// A path under /api that matched no route is a 404 from this service,
			// not a static-asset miss: say so instead of falling through to an
			// index.html that would confuse a machine client.
			if (url.pathname.startsWith('/api/')) {
				return json({ error: `no route for ${req.method} ${url.pathname}` }, { status: 404 });
			}
			return null;
		},
	};
}
