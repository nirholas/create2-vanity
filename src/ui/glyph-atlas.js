/**
 * A texture atlas of an alphabet, drawn once at load.
 *
 * The hero scene renders an address as a ring of characters, and a character in
 * WebGL is a quad with the right slice of a texture on it. Building that texture
 * from a canvas keeps the whole thing dependency-free: no font loader, no SDF
 * pipeline, no network request, and the glyphs match the page's own monospace
 * stack because the browser draws them with it.
 *
 * The atlas is a single row of equal cells, so picking a glyph is one UV offset,
 * which an instanced attribute can carry.
 */

/**
 * @typedef {object} GlyphAtlas
 * @property {HTMLCanvasElement} canvas
 * @property {number} columns    cells across
 * @property {number} cell       pixel size of one cell
 * @property {string} alphabet
 * @property {(char: string) => number} indexOf  glyph index, or -1
 */

/**
 * @param {string} alphabet the characters to draw, in order
 * @param {{ cell?: number, color?: string, font?: string }} [opts]
 * @returns {GlyphAtlas}
 */
export function buildGlyphAtlas(alphabet, opts = {}) {
	const cell = opts.cell ?? 64;
	const columns = alphabet.length;
	const canvas = document.createElement('canvas');
	canvas.width = columns * cell;
	canvas.height = cell;

	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = opts.color ?? '#ffffff';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.font = opts.font ?? `600 ${Math.round(cell * 0.66)}px ui-monospace, SFMono-Regular, Menlo, monospace`;

	for (let i = 0; i < columns; i++) {
		ctx.fillText(alphabet[i], i * cell + cell / 2, cell / 2 + cell * 0.02);
	}

	const index = new Map([...alphabet].map((ch, i) => [ch, i]));
	return {
		canvas,
		columns,
		cell,
		alphabet,
		indexOf: (ch) => (index.has(ch) ? index.get(ch) : -1),
	};
}
