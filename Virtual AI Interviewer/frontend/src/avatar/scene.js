/* The stage: renderer, portrait camera, studio lighting, backdrop.
 *
 * Deliberately knows nothing about monkeys. A rig is added with `add()` and
 * lit; whether that rig is the built-in sculpt or a loaded GLB is not this
 * file's business.
 */

import {
  ACESFilmicToneMapping,
  BackSide,
  CanvasTexture,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  PointLight,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  BoxGeometry,
  WebGLRenderer,
} from "three";

import { BACKDROP, CAMERA, LIGHTS, MAX_PIXEL_RATIO } from "./config.js";

/** The dark studio backdrop: a vertical gradient with a pool of light behind
 *  the shoulders, painted into a texture rather than lit for real. */
function backdropTexture() {
  const cv = document.createElement("canvas");
  cv.width = 8;
  cv.height = 512;
  const ctx = cv.getContext("2d");
  const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, hex(BACKDROP.bottom));
  grad.addColorStop(0.4, hex(BACKDROP.top));
  grad.addColorStop(1.0, hex(BACKDROP.bottom));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 512);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** A studio built out of emissive panels, pre-filtered into an environment map.
 *
 *  This is the image-based lighting that makes PBR materials look photographed
 *  rather than shaded: a large soft key panel front-left, a cooler panel on the
 *  right, a strip behind for the rim, and dark everywhere else. Generating it
 *  in code costs about a millisecond and avoids shipping a multi-megabyte HDRI
 *  to a browser. */
function studioEnvironment(renderer) {
  const env = new Scene();
  env.background = new Color(0x0b0f0e);

  const panel = (color, intensity, w, h, d, pos) => {
    const mesh = new Mesh(
      new BoxGeometry(w, h, d),
      new MeshStandardMaterial({ color: 0x000000, emissive: new Color(color), emissiveIntensity: intensity }),
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    env.add(mesh);
    return mesh;
  };

  panel(0xfff0dc, 5.5, 5, 6, 0.1, [-4.5, 3.5, 3.5]);   // key softbox
  panel(0x9dbcd8, 1.4, 4, 4, 0.1, [5, 1.5, 2.5]);      // cool fill
  panel(0xcfe4dd, 2.6, 6, 1.6, 0.1, [-1.5, 3.0, -5]);  // rim strip
  panel(0x2a3a36, 0.5, 12, 0.1, 12, [0, -3, 0]);       // dim bounce off the floor

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(env, 0.04);
  const texture = target.texture;
  texture.mapping = EquirectangularReflectionMapping;

  pmrem.dispose();
  env.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });
  return texture;
}

export function createScene(container) {
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = LIGHTS.exposure;
  // Self-shadowing is the shadow that matters in a portrait: brow onto eye,
  // nose onto lip, a raised hand onto the chest. There is no visible floor, so
  // a ground contact shadow would fall outside the crop entirely.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const canvas = renderer.domElement;
  canvas.className = "avatar-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Animated interviewer");

  const scene = new Scene();

  const camera = new PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
  camera.position.set(...CAMERA.position);
  camera.lookAt(...CAMERA.target);

  scene.environment = studioEnvironment(renderer);

  // Painted backdrop, unlit so it stays clean behind the rim light.
  const backdrop = new Mesh(
    new SphereGeometry(14, 32, 24),
    new MeshBasicMaterial({ map: backdropTexture(), side: BackSide }),
  );
  scene.add(backdrop);

  /* -- three-point light, low key. The environment map does the soft work; the
     lights do the shaping and the one shadow. -- */
  const hemi = new HemisphereLight(
    LIGHTS.hemisphere.sky, LIGHTS.hemisphere.ground, LIGHTS.hemisphere.intensity,
  );
  scene.add(hemi);

  const key = new DirectionalLight(LIGHTS.key.color, LIGHTS.key.intensity);
  key.position.set(...LIGHTS.key.position);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.02;
  // A tight frustum around the head and shoulders: the same 1024 map spread
  // over a default 1000-unit frustum would give shadows made of staircases.
  const cam = key.shadow.camera;
  cam.near = 0.5;
  cam.far = 12;
  cam.left = -1.8;
  cam.right = 1.8;
  cam.top = 2.8;
  cam.bottom = -0.6;
  cam.updateProjectionMatrix();
  scene.add(key);
  scene.add(key.target);
  key.target.position.set(0, 1.45, 0);

  const fill = new DirectionalLight(LIGHTS.fill.color, LIGHTS.fill.intensity);
  fill.position.set(...LIGHTS.fill.position);
  scene.add(fill);

  const rim = new DirectionalLight(LIGHTS.rim.color, LIGHTS.rim.intensity);
  rim.position.set(...LIGHTS.rim.position);
  scene.add(rim);

  // A weak light at the lens, purely so the eyes keep a catchlight.
  const catchlight = new PointLight(
    LIGHTS.catchlight.color, LIGHTS.catchlight.intensity, LIGHTS.catchlight.distance, 2,
  );
  catchlight.position.set(...LIGHTS.catchlight.position);
  scene.add(catchlight);

  const baseFovRad = (CAMERA.fov * Math.PI) / 180;

  function setSize(w, h) {
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    // On a narrow container the horizontal field would close in and crop the
    // ears; below a threshold, hold the horizontal field and open up
    // vertically instead.
    if (aspect < CAMERA.minAspect) {
      const halfH = CAMERA.minAspect * Math.tan(baseFovRad / 2);
      camera.fov = (2 * Math.atan(halfH / aspect) * 180) / Math.PI;
    } else {
      camera.fov = CAMERA.fov;
    }
    camera.updateProjectionMatrix();
  }

  function dispose() {
    scene.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const key of Object.keys(m || {})) {
            const v = m[key];
            if (v && v.isTexture) v.dispose();
          }
          m?.dispose();
        }
      }
    });
    scene.environment?.dispose();
    renderer.dispose();
  }

  container.appendChild(canvas);

  return { renderer, scene, camera, canvas, setSize, dispose };
}
