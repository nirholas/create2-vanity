/**
 * Cloudflare Worker host.
 *
 * The same Fetch handler as the Node server, with static assets served by the
 * Workers Assets binding instead of the filesystem.
 *
 * Every endpoint behaves identically here: the grinder is pure @noble
 * arithmetic with no filesystem or WebAssembly dependency, so the edge runtime
 * runs the same code as Node.
 *
 * Deploy: npm run build && npx wrangler deploy
 */

import { handle } from '../server/app.mjs';

export default {
	/**
	 * @param {Request} request
	 * @param {{ ASSETS?: { fetch: (req: Request) => Promise<Response> } }} env
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env) {
		const response = await handle(request, env);
		if (response) return response;
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response('not found', { status: 404 });
	},
};
