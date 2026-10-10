import * as THREE from 'three';
import type { MaterialValues } from './layers';

/** Renders small material-ball previews with the main renderer and returns data URLs. */
export function renderMaterialThumbnails(
  renderer: THREE.WebGLRenderer,
  environment: THREE.Texture | null,
  materials: MaterialValues[],
  size = 88,
): string[] {
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, samples: 4 });
  const scene = new THREE.Scene();
  scene.environment = environment;
  const mat = new THREE.MeshStandardMaterial();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
  scene.add(ball);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 10);
  cam.position.set(0, 0.6, 3.9);
  cam.lookAt(0, 0, 0);
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(-2, 3, 2);
  scene.add(light);

  const px = new Float32Array(size * size * 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const urls: string[] = [];
  const prevClear = renderer.getClearAlpha();
  for (const v of materials) {
    mat.color.setRGB(v.color[0], v.color[1], v.color[2], THREE.SRGBColorSpace);
    mat.roughness = v.roughness;
    mat.metalness = v.metallic;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = ((size - 1 - y) * size + x) * 4;
        const d = (y * size + x) * 4;
        const a = px[s + 3];
        for (let c = 0; c < 3; c++) {
          const lin = a > 0 ? px[s + c] / a : 0;
          img.data[d + c] = Math.round(255 * toSrgb(filmic(lin)));
        }
        img.data[d + 3] = Math.round(255 * Math.min(1, a));
      }
    }
    ctx.putImageData(img, 0, 0);
    urls.push(canvas.toDataURL());
  }
  renderer.setClearColor(0x000000, prevClear);
  renderer.setRenderTarget(null);
  rt.dispose();
  ball.geometry.dispose();
  mat.dispose();
  return urls;
}

function filmic(x: number) {
  // ACES approximation (Narkowicz)
  x *= 0.9;
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

function toSrgb(c: number) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
