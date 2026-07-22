// Shared contract between Model3dView and the two lazily-loaded viewer backends
// (modelViewerMount for glb/gltf, threeViewerMount for stl/obj). Kept in its own tiny module
// so importing it never drags in three.js or <model-viewer>.

export interface Model3dMountOptions {
  /** `/uploads/<stored_name>` to load. */
  url: string;
  /** One of glb|gltf|stl|obj (the backend already knows which family it handles). */
  format: string;
  /** Called once the model is loaded and first rendered. */
  onLoad: () => void;
  /** Called with a user-facing message if loading fails. */
  onError: (message: string) => void;
}

/** Mounts a viewer into `host` and returns a disposer that fully tears it down. */
export type Model3dMount = (host: HTMLElement, opts: Model3dMountOptions) => () => void;
