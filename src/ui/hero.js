/**
 * The hero: an address, in three dimensions, being ground.
 *
 * Every character of a candidate address is a quad on a slowly turning ring,
 * textured from a glyph atlas built at load. While the grinder runs, the
 * characters churn at a rate driven by the measured attempt rate, and the cells
 * covered by the pattern are held in the accent colour so you can see exactly
 * which part of the address is being searched for and which part is noise.
 *
 * On a hit the ring locks: the real address is written into the cells, the
 * matched ones pulse, and the churn stops. That is the whole product in one
 * image, and it is a read-out rather than an ornament, which is the only kind of
 * decoration worth shipping.
 *
 * Constraints:
 *   • one instanced draw call, no per-frame allocation;
 *   • it parks itself when the tab is hidden;
 *   • `prefers-reduced-motion` stops the churn and the rotation;
 *   • no WebGL means the canvas hides and the page is unaffected.
 */

import {
	Scene, PerspectiveCamera, WebGLRenderer, PlaneGeometry, InstancedMesh,
	MeshBasicMaterial, CanvasTexture, Object3D, Color, InstancedBufferAttribute,
	AdditiveBlending, DoubleSide, Group, Vector3,
} from 'three';

import { buildGlyphAtlas } from './glyph-atlas.js';

/**
 * @typedef {object} HeroOptions
 * @property {string} alphabet          characters the address is drawn from
 * @property {number} length            characters in an address
 * @property {string} accent            hex colour for matched cells
 * @property {string} accentAlt         hex colour for the second matched end
 * @property {string} [idle]            hex colour for unmatched cells
 * @property {string} [prefixSource]    ignored; kept out of the render loop
 */

/** @type {{ setPattern: Function, setActivity: Function, lock: Function, reset: Function } | null} */
let api = null;

/**
 * Mount the hero on a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HeroOptions} options
 * @returns {{ setPattern(prefix: string, suffix: string): void, setActivity(v: number): void, lock(address: string): void, reset(): void }}
 */
export function mountHero(canvas, options) {
	const alphabet = options.alphabet;
	const length = options.length;

	let renderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
	} catch {
		canvas.style.display = 'none';
		return noopApi();
	}

	const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(0x000000, 0);

	const scene = new Scene();
	const camera = new PerspectiveCamera(42, 1, 0.1, 100);
	camera.position.set(0, 0.42, 7.4);
	camera.lookAt(0, 0.02, 0);

	const ring = new Group();
	scene.add(ring);

	// ── glyphs ────────────────────────────────────────────────────────────────
	const atlas = buildGlyphAtlas(alphabet, { cell: 64 });
	const texture = new CanvasTexture(atlas.canvas);
	texture.anisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;

	// One cell of the atlas, so the geometry's UVs address a single glyph and an
	// instanced attribute slides the window along the row.
	const geometry = new PlaneGeometry(0.40, 0.60);
	const uv = geometry.attributes.uv;
	for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) / atlas.columns);
	uv.needsUpdate = true;

	const material = new MeshBasicMaterial({
		map: texture,
		transparent: true,
		depthWrite: false,
		side: DoubleSide,
		blending: AdditiveBlending,
	});

	// Per-instance glyph offset and colour, injected into the standard material
	// rather than writing a shader from scratch: fewer moving parts, same result.
	const offsets = new Float32Array(length);
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\n\t\t\tattribute float aGlyph;\n\t\t\tvarying float vGlyph;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\n\t\t\tvGlyph = aGlyph;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\n\t\t\tvarying float vGlyph;\n\t\t\tuniform float uColumns;')
			.replace('#include <map_fragment>', `
				vec2 glyphUv = vMapUv + vec2(vGlyph / uColumns, 0.0);
				vec4 sampledDiffuseColor = texture2D(map, glyphUv);
				diffuseColor *= sampledDiffuseColor;
			`);
		shader.uniforms.uColumns = { value: atlas.columns };
	};

	const mesh = new InstancedMesh(geometry, material, length);
	mesh.instanceMatrix.setUsage(35048); // DynamicDrawUsage
	mesh.geometry.setAttribute('aGlyph', new InstancedBufferAttribute(offsets, 1));
	ring.add(mesh);

	// ── layout ────────────────────────────────────────────────────────────────
	// The address lies along a shallow arc that bends away at the ends, so it
	// reads left to right like text while still being a thing in space.
	//
	// The important decision is the size hierarchy. Forty-four characters across
	// a hero strip are individually tiny, so the cells covered by the pattern are
	// drawn large and lit while the rest stay small and dim. The picture then says
	// what the product does: these characters are yours, the other forty are
	// entropy you are paying to sift.
	// The canvas is a wide, short strip, so the horizontal frustum is several
	// times the vertical one and the line can be far wider than it looks like it
	// should be. SPREAD is tuned against that aspect, not against the field of
	// view alone.
	const SPREAD = 17.6;
	const BEND = 3.4;
	const dummy = new Object3D();

	const idle = new Color(options.idle ?? '#5c5c6b');
	const accent = new Color(options.accent);
	const accentAlt = new Color(options.accentAlt);
	const colors = Array.from({ length }, () => idle.clone());

	for (let i = 0; i < length; i++) mesh.setColorAt(i, idle);

	/**
	 * Lay the cells out on one line with variable widths.
	 *
	 * Matched cells are drawn nearly twice the size of the rest, so the spacing
	 * has to be computed from the widths rather than assumed uniform, or the big
	 * ones collide with their neighbours. Running the cumulative sum every frame
	 * costs nothing at this count and keeps the layout correct the instant the
	 * pattern changes.
	 */
	function placeCells(time) {
		const widths = new Array(length);
		let total = 0;
		for (let i = 0; i < length; i++) {
			widths[i] = isMatched(i) ? 1.95 : 0.95;
			total += widths[i];
		}
		const unit = SPREAD / total;

		let cursor = 0;
		for (let i = 0; i < length; i++) {
			const centre = (cursor + widths[i] / 2) * unit - SPREAD / 2;
			cursor += widths[i];

			const t = centre / SPREAD;                 // roughly -0.5 … 0.5
			const matched = isMatched(i);
			const wave = reduceMotion ? 0 : Math.sin(time * 0.9 + i * 0.42) * 0.06;

			dummy.position.set(centre, wave, -BEND * t * t * 4);
			// Billboard toward the camera, then yaw with position so the strip has
			// depth instead of reading as a flat texture.
			dummy.lookAt(camera.position);
			dummy.rotateY(-t * 0.5);
			dummy.scale.setScalar(widths[i]);
			dummy.updateMatrix();
			mesh.setMatrixAt(i, dummy.matrix);

			// Fade the ends into the dark rather than clipping them. Additive
			// blending turns a darker colour into a dimmer glyph.
			const fade = 1 - Math.pow(Math.abs(t) * 2, 2.6) * 0.72;
			const base = !matched ? idle : (i < prefixLength ? accent : accentAlt);
			colors[i].copy(base).multiplyScalar(matched ? 1 : Math.max(0.12, fade));
			mesh.setColorAt(i, colors[i]);
		}
		mesh.instanceMatrix.needsUpdate = true;
		if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
	}

	// ── state ─────────────────────────────────────────────────────────────────
	let prefixLength = 0;
	let suffixLength = 0;
	let activity = 0;
	let smoothed = 0;
	let locked = null;
	let lockedAt = 0;
	let churnAccumulator = 0;

	function isMatched(i) {
		return i < prefixLength || i >= length - suffixLength;
	}

	/** Seed the instance colours; `placeCells` refreshes them every frame. */
	function paint() {
		for (let i = 0; i < length; i++) {
			colors[i].copy(!isMatched(i) ? idle : (i < prefixLength ? accent : accentAlt));
			mesh.setColorAt(i, colors[i]);
		}
		if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
	}

	function randomGlyph() {
		return Math.floor(Math.random() * atlas.columns);
	}

	/**
	 * Roll `count` random cells to new characters.
	 *
	 * Cells covered by the pattern are never rolled: they hold the characters
	 * that were asked for, so the strip reads as "this is what I want, and this
	 * is the entropy being sifted for it" rather than as undifferentiated noise.
	 */
	function churn(count) {
		if (locked) return;
		for (let n = 0; n < count; n++) {
			const i = Math.floor(Math.random() * length);
			if (isMatched(i)) continue;
			offsets[i] = randomGlyph();
		}
		mesh.geometry.attributes.aGlyph.needsUpdate = true;
	}

	/**
	 * The atlas index for a character, falling back to the other case.
	 *
	 * A hex alphabet is lowercase, but an EIP-55 checksummed address is not, so a
	 * strict lookup silently leaves a churned glyph wherever the address happens
	 * to carry an uppercase letter. Base58 keeps both cases and matches exactly,
	 * so trying the literal character first is what makes one lookup correct for
	 * both alphabets.
	 * @param {string|undefined} ch
	 * @returns {number} atlas index, or -1
	 */
	function glyphFor(ch) {
		if (!ch) return -1;
		const exact = atlas.indexOf(ch);
		if (exact >= 0) return exact;
		const lower = atlas.indexOf(ch.toLowerCase());
		if (lower >= 0) return lower;
		return atlas.indexOf(ch.toUpperCase());
	}

	/** Write the requested characters into the cells the pattern covers. */
	function writePattern(prefix, suffix) {
		for (let i = 0; i < prefix.length && i < length; i++) {
			const index = glyphFor(prefix[i]);
			if (index >= 0) offsets[i] = index;
		}
		for (let i = 0; i < suffix.length && i < length; i++) {
			const index = glyphFor(suffix[suffix.length - 1 - i]);
			if (index >= 0) offsets[length - 1 - i] = index;
		}
		mesh.geometry.attributes.aGlyph.needsUpdate = true;
	}

	for (let i = 0; i < length; i++) offsets[i] = randomGlyph();
	paint();

	// ── loop ──────────────────────────────────────────────────────────────────
	function resize() {
		const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 640;
		const height = canvas.clientHeight || 260;
		renderer.setSize(width, height, false);
		camera.aspect = width / Math.max(1, height);
		camera.updateProjectionMatrix();
	}
	resize();
	window.addEventListener('resize', resize, { passive: true });

	let raf = 0;
	let last = performance.now();

	function frame(now) {
		raf = requestAnimationFrame(frame);
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		const time = now / 1000;

		smoothed += (activity - smoothed) * Math.min(1, dt * 3);

		if (!reduceMotion) {
			ring.rotation.y = Math.sin(time * 0.11) * 0.055;
			ring.rotation.x = Math.sin(time * 0.08) * 0.02;

			// Idle churn keeps the hero alive; a running grind drives it much faster,
			// so the visual speed is the reported rate rather than a fixed animation.
			const perSecond = locked ? 0 : 6 + smoothed * 220;
			churnAccumulator += perSecond * dt;
			const steps = Math.floor(churnAccumulator);
			if (steps > 0) {
				churnAccumulator -= steps;
				churn(Math.min(steps, 240));
			}
		}

		placeCells(time);

		if (locked) {
			// A short pulse across the matched cells once the answer lands, then rest.
			const age = time - lockedAt;
			const pulse = Math.max(0, 1 - age / 1.6);
			if (pulse > 0) {
				for (let i = 0; i < length; i++) {
					if (!isMatched(i)) continue;
					const wave = Math.max(0, Math.sin(age * 4 - i * 0.25)) * pulse;
					colors[i].lerp(WHITE, wave * 0.7);
					mesh.setColorAt(i, colors[i]);
				}
				if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
			}
		}
		renderer.render(scene, camera);
	}
	const WHITE = new Color('#ffffff');
	raf = requestAnimationFrame(frame);

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			cancelAnimationFrame(raf);
			raf = 0;
		} else if (!raf) {
			last = performance.now();
			raf = requestAnimationFrame(frame);
		}
	});

	api = {
		/**
		 * Tell the hero which cells the pattern covers.
		 * @param {string} prefix
		 * @param {string} suffix
		 */
		setPattern(prefix, suffix) {
			const head = String(prefix || '');
			const tail = String(suffix || '');
			prefixLength = Math.min(length, head.length);
			suffixLength = Math.min(length - prefixLength, tail.length);
			if (locked) return;
			// Cells that leave the pattern go back to churning, so shortening a
			// prefix does not strand its old characters on the strip.
			for (let i = 0; i < length; i++) {
				if (!isMatched(i)) offsets[i] = randomGlyph();
			}
			writePattern(head.slice(0, prefixLength), tail.slice(tail.length - suffixLength));
			paint();
		},
		/** @param {number} value 0 idle, 1 grinding flat out */
		setActivity(value) {
			const n = Number(value);
			activity = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
		},
		/**
		 * Write a real address into the ring and stop churning.
		 * @param {string} address rendered form, without any `0x`
		 */
		lock(address) {
			const body = String(address || '').replace(/^0x/i, '');
			for (let i = 0; i < length; i++) {
				const index = glyphFor(body[i]);
				offsets[i] = index >= 0 ? index : offsets[i];
			}
			mesh.geometry.attributes.aGlyph.needsUpdate = true;
			locked = body;
			lockedAt = performance.now() / 1000;
			activity = 0;
		},
		/** Back to churning, for a second run. */
		reset() {
			locked = null;
			paint();
		},

		/**
		 * The characters currently on the ring, in order. Exists so a test can
		 * assert the hero shows the address it was given rather than something
		 * that merely looks plausible at 8 pixels.
		 * @returns {string}
		 */
		readout() {
			let out = '';
			for (let i = 0; i < length; i++) out += alphabet[offsets[i]] ?? '?';
			return out;
		},
	};
	return api;
}

/** @returns {{ setPattern: Function, setActivity: Function, lock: Function, reset: Function }} */
function noopApi() {
	return { setPattern() {}, setActivity() {}, lock() {}, reset() {} };
}

/** The mounted hero, or a no-op stand-in when the canvas is absent. */
export function hero() {
	return api ?? noopApi();
}
