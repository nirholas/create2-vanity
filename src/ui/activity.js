/**
 * Shared grind-activity signal.
 *
 * The page controllers report how hard the grinder is working; the WebGL
 * backdrop reads it. Keeping the signal in its own module means a controller
 * never imports three.js just to move a number, so the interactive chunk stays
 * small and the 3D scene loads independently of it.
 */

let activity = 0;

/**
 * @param {number} value 0 = idle or paused, 1 = full measured rate
 */
export function setGrindActivity(value) {
	const n = Number(value);
	activity = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** @returns {number} */
export function grindActivity() {
	return activity;
}
