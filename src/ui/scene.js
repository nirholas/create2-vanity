/**
 * The keyspace backdrop.
 *
 * A vanity grind is a search through 2²⁵⁶ Ed25519 public keys for one that
 * happens to render with the characters you asked for. That is impossible to
 * draw honestly, so this draws the shape of the search instead: a sphere of
 * candidate points, each one a key, sweeping under a scan band. Points inside
 * the band light up as they are "tested". When a grind is running the sweep
 * speeds up and the band widens in proportion to the measured hash rate, so the
 * backdrop is a read-out, not a decoration.
 *
 * Constraints this file takes seriously:
 *   • it must never be the reason the page is slow: one draw call, no
 *     per-frame allocation, and the loop parks itself when the tab is hidden;
 *   • it must degrade to nothing on a machine with no WebGL rather than
 *     throwing into the console;
 *   • it must respect `prefers-reduced-motion`, which freezes the sweep.
 */

import {
	Scene, PerspectiveCamera, WebGLRenderer, BufferGeometry, BufferAttribute,
	Points, ShaderMaterial, AdditiveBlending, Color, Vector2,
} from 'three';

import { grindActivity } from './activity.js';

const POINT_COUNT = 14000;
const BASE_SPEED = 0.08;

let smoothed = 0; // eased toward the reported activity so the visual never snaps

const canvas = document.getElementById('bg');
if (canvas) start(canvas);

/** @param {HTMLCanvasElement} canvas */
function start(canvas) {
	let renderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
	} catch {
		// No WebGL (blocked, software-blacklisted, headless). The page is fully
		// usable without the backdrop, so leave the canvas transparent.
		canvas.style.display = 'none';
		return;
	}

	const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	renderer.setPixelRatio(dpr);
	renderer.setClearColor(0x000000, 0);

	const scene = new Scene();
	const camera = new PerspectiveCamera(55, 1, 0.1, 100);
	camera.position.set(0, 0, 3.4);

	// Fibonacci sphere: an even spread with no pole clumping, which is what makes
	// a uniform keyspace read as uniform rather than as a globe with seams.
	const positions = new Float32Array(POINT_COUNT * 3);
	const seeds = new Float32Array(POINT_COUNT);
	const golden = Math.PI * (3 - Math.sqrt(5));
	for (let i = 0; i < POINT_COUNT; i++) {
		const y = 1 - (i / (POINT_COUNT - 1)) * 2;
		const radius = Math.sqrt(Math.max(0, 1 - y * y));
		const theta = golden * i;
		positions[i * 3] = Math.cos(theta) * radius;
		positions[i * 3 + 1] = y;
		positions[i * 3 + 2] = Math.sin(theta) * radius;
		seeds[i] = Math.random();
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(positions, 3));
	geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));

	const material = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		uniforms: {
			uTime: { value: 0 },
			uActivity: { value: 0 },
			uScan: { value: 0 },
			uPixelRatio: { value: dpr },
			uIdle: { value: new Color('#3a3a44') },
			uHot: { value: new Color('#34d399') },
			uEdge: { value: new Color('#2dd4bf') },
			uResolution: { value: new Vector2(1, 1) },
		},
		vertexShader: /* glsl */`
			attribute float aSeed;
			uniform float uTime;
			uniform float uActivity;
			uniform float uScan;
			uniform float uPixelRatio;
			varying float vHit;
			varying float vDepth;

			void main() {
				vec3 p = position;

				// Breathing radius keeps the sphere from reading as a static prop.
				float breathe = 1.0 + 0.02 * sin(uTime * 0.6 + aSeed * 6.2831);
				p *= breathe;

				vec4 mv = modelViewMatrix * vec4(p, 1.0);

				// The scan band sweeps down the sphere in world Y. A point is "hit"
				// while the band crosses it; the band is wider and brighter the
				// harder the grinder is working.
				float band = 0.06 + 0.10 * uActivity;
				float d = abs(p.y - uScan);
				vHit = smoothstep(band, 0.0, d) * (0.35 + 0.65 * uActivity);

				// A sparse subset flickers independently so the surface never looks
				// like a rigid lattice.
				float flicker = step(0.997 - 0.02 * uActivity, fract(sin(aSeed * 91.7 + floor(uTime * 12.0)) * 43758.5453));
				vHit = max(vHit, flicker * uActivity);

				vDepth = clamp((-mv.z - 1.0) / 4.0, 0.0, 1.0);
				gl_Position = projectionMatrix * mv;
				gl_PointSize = (1.4 + 2.6 * vHit) * uPixelRatio * (2.2 / -mv.z);
			}
		`,
		fragmentShader: /* glsl */`
			precision mediump float;
			uniform vec3 uIdle;
			uniform vec3 uHot;
			uniform vec3 uEdge;
			varying float vHit;
			varying float vDepth;

			void main() {
				vec2 c = gl_PointCoord - 0.5;
				float r = dot(c, c);
				if (r > 0.25) discard;
				float falloff = 1.0 - smoothstep(0.0, 0.25, r);

				vec3 warm = mix(uHot, uEdge, vHit * 0.6);
				vec3 color = mix(uIdle, warm, vHit);
				float alpha = falloff * mix(0.12, 0.95, vHit) * (1.0 - 0.55 * vDepth);
				gl_FragColor = vec4(color, alpha);
			}
		`,
	});

	const points = new Points(geometry, material);
	scene.add(points);

	function resize() {
		const w = window.innerWidth;
		const h = window.innerHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		material.uniforms.uResolution.value.set(w, h);
	}
	resize();
	window.addEventListener('resize', resize, { passive: true });

	let raf = 0;
	let last = performance.now();
	let scan = 1;

	function frame(now) {
		raf = requestAnimationFrame(frame);
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;

		// Ease toward the reported activity so a paused grind fades out rather
		// than cutting to black mid-sweep.
		smoothed += (grindActivity() - smoothed) * Math.min(1, dt * 3);
		material.uniforms.uActivity.value = smoothed;

		if (!reduceMotion) {
			const speed = BASE_SPEED + smoothed * 0.9;
			scan -= dt * speed * 2.0;
			if (scan < -1.2) scan = 1.2;
			points.rotation.y += dt * (0.05 + smoothed * 0.25);
			points.rotation.x = Math.sin(now / 9000) * 0.12;
			material.uniforms.uTime.value = now / 1000;
		}
		material.uniforms.uScan.value = scan;

		renderer.render(scene, camera);
	}
	raf = requestAnimationFrame(frame);

	// A backdrop has no business burning battery in a background tab.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			cancelAnimationFrame(raf);
			raf = 0;
		} else if (!raf) {
			last = performance.now();
			raf = requestAnimationFrame(frame);
		}
	});
}
