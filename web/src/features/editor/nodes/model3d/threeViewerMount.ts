// STL / OBJ backend: a lightweight three.js viewer.
//
// <model-viewer> only speaks glTF, so STL and OBJ get their own tiny three.js scene. This
// whole module (three core + the two loaders + OrbitControls) is a separate lazy chunk,
// loaded only when an STL/OBJ node is actually activated - a note with only GLB models never
// pulls it in, and vice-versa. We store the ORIGINAL bytes rather than converting to GLB on
// import: it keeps storage honest (what you uploaded is what is served) and sidesteps the
// fragile in-browser GLTFExporter path and OBJ's external-.mtl problem (geometry renders under
// a neutral default material).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { Model3dMount } from './viewerTypes';

/** Recentre the object at the origin and pull the camera back to frame it fully. */
function frame(object: THREE.Object3D, camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.6;

  camera.position.set(dist * 0.7, dist * 0.5, dist);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose?.();
  });
}

export const mountViewer: Model3dMount = (host, opts) => {
  let disposed = false;
  let stopped = false;
  let raf = 0;
  let object: THREE.Object3D | null = null;

  const width = host.clientWidth || 480;
  const height = host.clientHeight || 320;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
  camera.position.set(0, 0, 5);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1, 1, 1);
  scene.add(key);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;

  const fail = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (!disposed) opts.onError('Couldn\'t load this model. The file may be corrupt or unsupported.');
  };

  if (opts.format === 'stl') {
    new STLLoader().load(
      opts.url,
      (geometry) => {
        if (disposed) return;
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: 0x9aa1ad, metalness: 0.1, roughness: 0.7 });
        object = new THREE.Mesh(geometry, material);
        scene.add(object);
        frame(object, camera, controls);
        opts.onLoad();
      },
      undefined,
      fail,
    );
  } else {
    new OBJLoader().load(
      opts.url,
      (group) => {
        if (disposed) return;
        object = group;
        scene.add(group);
        frame(group, camera, controls);
        opts.onLoad();
      },
      undefined,
      fail,
    );
  }

  const resize = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resize.observe(host);

  const loop = () => {
    if (disposed || stopped) return;
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    resize.disconnect();
    controls.dispose();
    if (object) disposeObject(object);
    renderer.dispose();
    renderer.domElement.parentNode?.removeChild(renderer.domElement);
  };
};
