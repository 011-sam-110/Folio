// The auth hero's centrepiece: a procedural three.js book that opens on load with warm
// light spilling from between its pages - the literal reading of "Your notebooks, lit
// from within." It lives in its own module so three.js is a separate lazy chunk (see
// HeroBook.tsx), exactly like the editor's threeViewerMount: the login page's first paint
// never pulls three in. Nothing is downloaded - two covers, a spine, fanning page leaves,
// a ribbon and a soft glow sprite are built from primitives, so the amber material and the
// light from inside are fully under our control and match the --warm-* tokens.
import * as THREE from 'three';

export interface HeroBookOptions {
  /** Render one static open frame with no animation loop. */
  reducedMotion: boolean;
  /** Trim antialiasing / pixel-ratio / leaf count on small or low-core devices. */
  lowPower: boolean;
}

/** Mounts the book into `host` and returns a disposer that fully tears it down. */
export function mountHeroBook(host: HTMLElement, opts: HeroBookOptions): () => void {
  // Warm palette - literal siblings of the --warm-* / --parchment-* tokens so the scene
  // needs no DOM read. Colours are authored in sRGB (three converts them for lighting).
  const COVER = 0x5e3d1c; // amber-brown board
  const PAGE = 0xf4ead1; // parchment cream
  const PAGE_EDGE = 0xe9d3a4; // gilt-tinted fore-edge
  const GLOW = 0xffcf82; // the light from inside
  const SPINE = 0x4a2f14;
  const RIBBON = 0xd98a5a; // rose-gold bookmark (echoes --warm-rose)

  // Geometry (world units). Spine runs vertically (Y); covers hinge about that axis.
  const COVER_W = 2.35; // reach from spine outward (X)
  const COVER_H = 3.15; // height (Y)
  const COVER_T = 0.13; // thickness (Z)
  const PAGE_W = COVER_W - 0.14;
  const PAGE_H = COVER_H - 0.22;

  // Open state, expressed as each side's rotation from the flat-spread plane (rotation.y = 0
  // is a book laid open flat). Larger = more closed. We animate from nearly-shut to a gentle V.
  const A_CLOSED = 1.38; // ~79deg each side -> covers almost face to face
  const A_OPEN = 0.62; // ~35deg each side -> ~110deg spread
  const LEAVES = opts.lowPower ? 2 : 3; // fanning page leaves per side

  let width = host.clientWidth || 460;
  let height = host.clientHeight || 460;

  const renderer = new THREE.WebGLRenderer({ antialias: !opts.lowPower, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.5 : 2));
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  host.appendChild(canvas);

  // The book sits low and to the left in its own frame so its warm body stays in the hero's
  // bottom-left corner - clear of the headline, lede and trust line, which keep their AA
  // contrast on plain espresso. SIZE keeps the open silhouette compact.
  const BASE_Y = -1.0;
  const BASE_X = -0.7;
  const SIZE = 0.82;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
  camera.position.set(0, 1.35, 6.7);
  camera.lookAt(0, -0.28, 0);

  // --- lighting: a warm room + one light living inside the book ---
  const hemi = new THREE.HemisphereLight(0xffe6b4, 0x241304, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffdca0, 1.15);
  key.position.set(-2.6, 3.4, 3.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb26b, 0.5);
  rim.position.set(3.0, 1.2, -2.5);
  scene.add(rim);
  // The star: a point light between the covers. Intensity ramps up as the book opens so the
  // light appears to spill out from within.
  const innerLight = new THREE.PointLight(GLOW, 0, 9, 2);
  innerLight.position.set(0, 0.15, 0.35);
  scene.add(innerLight);

  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(o: T): T => {
    disposables.push(o);
    return o;
  };

  // A radial-gradient sprite behind the spine -> a soft bloom of light spilling upward.
  const glowTex = track(makeGlowTexture());
  const glowMat = track(
    new THREE.SpriteMaterial({ map: glowTex, color: GLOW, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  const glow = new THREE.Sprite(glowMat);
  glow.position.set(0, 0.35, -0.25);
  glow.scale.set(4.2, 3.4, 1);

  // --- materials ---
  const coverMat = track(new THREE.MeshStandardMaterial({ color: COVER, roughness: 0.66, metalness: 0.12 }));
  const spineMat = track(new THREE.MeshStandardMaterial({ color: SPINE, roughness: 0.7, metalness: 0.12 }));
  const pageMat = track(
    new THREE.MeshStandardMaterial({ color: PAGE, roughness: 0.92, metalness: 0, emissive: GLOW, emissiveIntensity: 0 }),
  );
  const edgeMat = track(new THREE.MeshStandardMaterial({ color: PAGE_EDGE, roughness: 0.85, metalness: 0.08 }));
  const ribbonMat = track(new THREE.MeshStandardMaterial({ color: RIBBON, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide }));

  // Geometry, translated so its inner edge sits on the spine (x = 0) and hinges cleanly.
  const coverGeo = track(new THREE.BoxGeometry(COVER_W, COVER_H, COVER_T));
  coverGeo.translate(COVER_W / 2, 0, 0);
  const pageGeo = track(new THREE.BoxGeometry(PAGE_W, PAGE_H, 0.02));
  pageGeo.translate(PAGE_W / 2, 0, 0);
  const wedgeGeo = track(new THREE.BoxGeometry(PAGE_W, PAGE_H, 0.09));
  wedgeGeo.translate(PAGE_W / 2, 0, 0);
  const edgeGeo = track(new THREE.BoxGeometry(0.05, PAGE_H, 0.1));
  edgeGeo.translate(PAGE_W, 0, 0);

  const book = new THREE.Group();
  book.position.set(BASE_X, BASE_Y, 0);
  const cradle = new THREE.Group();
  cradle.rotation.x = -0.5; // tilt the top back so we look down into the open pages
  book.add(cradle);
  scene.add(book);
  scene.add(glow);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.16, COVER_H + 0.04, COVER_T * 1.4), spineMat);
  cradle.add(spine);

  interface Side {
    hinge: THREE.Group; // holds the cover + page bulk, rotates to open
    leaves: THREE.Group[]; // fanning leaves, each with its own extra rotation
  }
  const buildSide = (dir: 1 | -1): Side => {
    const hinge = new THREE.Group();
    hinge.scale.x = dir; // -1 mirrors the +X-built geometry to the left half
    cradle.add(hinge);

    const cover = new THREE.Mesh(coverGeo, coverMat);
    cover.position.z = -COVER_T / 2 - 0.05; // cover sits below/behind the pages
    hinge.add(cover);

    const wedge = new THREE.Mesh(wedgeGeo, pageMat);
    hinge.add(wedge);
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    hinge.add(edge);

    const leaves: THREE.Group[] = [];
    for (let i = 0; i < LEAVES; i++) {
      const pivot = new THREE.Group();
      const leaf = new THREE.Mesh(pageGeo, pageMat);
      leaf.position.z = 0.055 + i * 0.012;
      pivot.add(leaf);
      hinge.add(pivot);
      leaves.push(pivot);
    }
    return { hinge, leaves };
  };
  const right = buildSide(1);
  const left = buildSide(-1);

  // Rose-gold ribbon hanging from the spine.
  const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 1.9), ribbonMat);
  ribbon.position.set(0.14, -COVER_H / 2 - 0.35, 0.12);
  ribbon.rotation.z = 0.06;
  cradle.add(ribbon);

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

  // Apply a single open amount (0 shut -> 1 open) across every moving part.
  function apply(open: number) {
    const a = A_CLOSED + (A_OPEN - A_CLOSED) * open;
    right.hinge.rotation.y = -a;
    left.hinge.rotation.y = a;

    // Leaves fan across the opening with a per-leaf stagger so the pages cascade.
    for (const side of [right, left]) {
      for (let i = 0; i < side.leaves.length; i++) {
        const stagger = clamp01((open - i * 0.14) / 0.6);
        const spread = easeOutCubic(stagger);
        // extra rotation lifts each leaf off the cover toward the centre of the spread
        side.leaves[i].rotation.y = (0.55 - 0.16 * i) * spread;
      }
    }

    innerLight.intensity = 2.1 * open;
    pageMat.emissiveIntensity = 0.3 * open;
    glowMat.opacity = 0.6 * open;
    const gs = 2.9 + 1.4 * open;
    glow.scale.set(gs * 1.25, gs, 1);
    const s = 0.92 + 0.08 * easeOutCubic(open);
    book.scale.setScalar(s * SIZE);
    book.rotation.y = (1 - open) * -0.42; // a small turn as it settles square to camera
  }

  const resize = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    width = w;
    height = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (opts.reducedMotion) renderer.render(scene, camera); // repaint the static frame
  });
  resize.observe(host);

  let raf = 0;
  let disposed = false;
  let visible = true;
  let vis: IntersectionObserver | null = null;

  if (opts.reducedMotion) {
    // Static open book, no loop.
    apply(1);
    book.rotation.y = -0.16;
    renderer.render(scene, camera);
  } else {
    const START_DELAY = 140;
    const OPEN_MS = 1750;
    const t0 = performance.now();
    const loop = (now: number) => {
      if (disposed) return;
      if (!visible) {
        raf = 0; // scrolled offscreen -> stop burning the GPU; the observer resumes us
        return;
      }
      raf = requestAnimationFrame(loop);
      const elapsed = now - t0 - START_DELAY;
      const e = clamp01(elapsed / OPEN_MS);
      const open = easeOutCubic(e);
      apply(open);
      if (e >= 1) {
        // Settle into a gentle idle: a slow float plus a barely-there sway.
        const it = (elapsed - OPEN_MS) / 1000;
        book.position.y = BASE_Y + Math.sin(it * 0.5) * 0.06;
        book.rotation.y = Math.sin(it * 0.42) * 0.05;
        book.rotation.x = Math.sin(it * 0.33 + 1) * 0.02;
      }
      renderer.render(scene, camera);
    };
    // Only render while the hero is on screen; the loop pauses when it scrolls away.
    vis = new IntersectionObserver(
      (entries) => {
        visible = entries.some((en) => en.isIntersecting);
        if (visible && !disposed && raf === 0) raf = requestAnimationFrame(loop);
      },
      { threshold: 0.01 },
    );
    vis.observe(host);
    raf = requestAnimationFrame(loop);
  }

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    vis?.disconnect();
    resize.disconnect();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
    for (const d of disposables) d.dispose();
    renderer.dispose();
    canvas.parentNode?.removeChild(canvas);
  };
}

/** A soft radial-gradient texture for the bloom sprite (transparent -> warm centre). */
function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.3, 'rgba(255,214,140,0.6)');
  g.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
