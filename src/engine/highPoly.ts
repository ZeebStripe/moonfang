import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BVHShaderGLSL, FloatVertexAttributeTexture, MeshBVH, MeshBVHUniformStruct } from 'three-mesh-bvh';
import { rawMaterial, UV_SPACE_VERT } from './gl';
import { parseModel, type PaintMesh } from './meshLoader';

/**
 * High-poly reference mesh for baking. Lives in the low-poly mesh's normalised space and is uploaded to the
 * GPU as a BVH, so bake shaders can ray-trace it per texel.
 */
export class HighPoly {
  readonly triangles: number;
  readonly bvh = new MeshBVHUniformStruct();
  readonly normals = new FloatVertexAttributeTexture();

  private constructor(
    readonly name: string,
    readonly bytes: ArrayBuffer,
    geometry: THREE.BufferGeometry,
  ) {
    this.triangles = geometry.index!.count / 3;
    this.bvh.updateFrom(new MeshBVH(geometry));
    this.normals.updateFrom(geometry.attributes.normal as THREE.BufferAttribute);
  }

  /** Loads a high-poly file and fits it into `low`'s normalised space (both share the source file's units). */
  static async load(name: string, bytes: ArrayBuffer, low: PaintMesh): Promise<HighPoly> {
    const root = await parseModel(name, bytes);
    root.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
      const src = mesh.geometry;
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', toFloat(src.attributes.position));
      if (src.attributes.normal) g.setAttribute('normal', toFloat(src.attributes.normal));
      if (src.index) g.setIndex(src.index.clone());
      // OBJ files without `vn` (common for sculpt exports) come back with per-face normals, which would bake the facets.
      if (g.attributes.normal && !g.index && isFaceted(g.attributes.normal as THREE.BufferAttribute)) g.deleteAttribute('normal');
      if (!g.attributes.normal) {
        // Smooth normals need shared vertices.
        g = mergeVertices(g, 1e-6);
        g.computeVertexNormals();
      }
      if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
      g.applyMatrix4(mesh.matrixWorld);
      parts.push(g);
    });
    if (!parts.length) throw new Error('No meshes found in the high-poly file.');
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!merged) throw new Error('Failed to merge the high-poly mesh parts.');
    merged.translate(-low.center.x, -low.center.y, -low.center.z);
    merged.scale(low.scale, low.scale, low.scale);
    return new HighPoly(name, bytes, merged);
  }

  /** Same file, fitted to another low-poly mesh (after the low-poly mesh was reloaded). */
  refit(low: PaintMesh): Promise<HighPoly> {
    return HighPoly.load(this.name, this.bytes, low);
  }

  dispose() {
    this.bvh.dispose();
    this.normals.dispose();
  }
}

/** True when (nearly) every triangle of a non-indexed geometry has three identical vertex normals. */
function isFaceted(n: THREE.BufferAttribute): boolean {
  const tris = Math.floor(n.count / 3);
  const step = Math.max(1, Math.floor(tris / 2000));
  let flat = 0;
  let total = 0;
  for (let t = 0; t < tris; t += step, total++) {
    const i = t * 3;
    let same = true;
    for (let c = 0; c < 3 && same; c++) same = n.getComponent(i, c) === n.getComponent(i + 1, c) && n.getComponent(i, c) === n.getComponent(i + 2, c);
    if (same) flat++;
  }
  return total > 0 && flat / total > 0.99;
}

function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const f = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < 3; c++) f[i * 3 + c] = a.getComponent(i, c);
  return new THREE.BufferAttribute(f, 3);
}

const BVH_GLSL = /* glsl */ `
precision highp isampler2D;
precision highp usampler2D;
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}
uniform BVH bvh;
uniform sampler2D uHighN;
`;

/**
 * Projection (UV-space raster of the low-poly set): a ray from the cage (low surface pushed out by uFront)
 * goes inward along the low-poly normal; the first high-poly hit within uFront + uBack wins.
 *   o0: distance along the ray, hit flag, world length of one texel in u and v (for curvature)
 *   o1: high-poly world normal, hit flag
 *   o2: high-poly normal in the low-poly UV tangent frame (* 0.5 + 0.5), hit flag
 */
export function projectionMaterial() {
  return rawMaterial(
    `${BVH_GLSL}
     in vec3 vPos; in vec3 vNormal;
     uniform float uFront; uniform float uBack;
     layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
     void main(){
       vec3 n = normalize(vNormal);
       // Derivatives before any divergent control flow (same tangent frame as MeshMaps' raw pass).
       vec3 dpdu = dFdx(vPos), dpdv = dFdy(vPos);
       vec3 T = normalize(dpdu - n * dot(n, dpdu));
       vec3 B = normalize(cross(n, T)) * (dot(cross(n, T), dpdv) < 0.0 ? -1.0 : 1.0);
       vec3 ro = vPos + n * uFront;
       uvec4 fi; vec3 fn; vec3 bc; float side; float dist;
       bool hit = bvhIntersectFirstHit(bvh, ro, -n, fi, fn, bc, side, dist);
       if (!hit || dist > uFront + uBack) {
         o0 = vec4(0.0, 0.0, length(dpdu), length(dpdv));
         o1 = vec4(n, 0.0);
         o2 = vec4(0.5, 0.5, 1.0, 0.0);
         return;
       }
       vec3 hn = textureSampleBarycoord(uHighN, bc, fi.xyz).xyz;
       hn = length(hn) > 1e-6 ? normalize(hn) : normalize(fn);
       // Inverted or degenerate high-poly normals: face the low-poly side.
       if (dot(hn, n) < 0.0) hn = -hn;
       vec3 ts = normalize(vec3(dot(hn, T), dot(hn, B), max(dot(hn, n), 1e-3)));
       o0 = vec4(dist, 1.0, length(dpdu), length(dpdv));
       o1 = vec4(hn, 1.0);
       o2 = vec4(ts * 0.5 + 0.5, 1.0);
     }`,
    {
      bvh: { value: null },
      uHighN: { value: null },
      uFront: { value: 0.02 },
      uBack: { value: 0.02 },
    },
    { vertex: UV_SPACE_VERT },
  );
}

/**
 * Ambient occlusion of the high-poly surface, a few cosine-weighted rays per pass (additive: r = visible, g = count).
 * Texels without a projection hit write nothing; MeshMaps falls back to the low-poly AO there.
 */
export function rayAoMaterial() {
  return rawMaterial(
    `${BVH_GLSL}
     in vec3 vPos; in vec3 vNormal;
     uniform sampler2D uProj0; uniform sampler2D uProj1;
     uniform float uFront; uniform float uMaxDist; uniform float uSeed; uniform vec2 uSize;
     layout(location = 0) out vec4 o0;
     float hash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
     void main(){
       vec2 uv = gl_FragCoord.xy / uSize;
       vec4 p0 = texture(uProj0, uv);
       if (p0.g < 0.5) { o0 = vec4(0.0); return; }
       vec3 n = normalize(vNormal);
       vec3 hn = normalize(texture(uProj1, uv).xyz);
       vec3 origin = vPos + n * (uFront - p0.r) + hn * 0.0008;
       vec3 t = normalize(abs(hn.y) < 0.99 ? cross(hn, vec3(0.0, 1.0, 0.0)) : cross(hn, vec3(1.0, 0.0, 0.0)));
       vec3 b = cross(hn, t);
       float vis = 0.0;
       for (int i = 0; i < RAYS; i++) {
         float r1 = hash(vec3(gl_FragCoord.xy, uSeed + float(i) * 7.13));
         float r2 = hash(vec3(gl_FragCoord.yx + 17.0, uSeed * 1.37 + float(i) * 3.71));
         float r = sqrt(r1), phi = 6.2831853 * r2;
         vec3 d = normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + hn * sqrt(max(0.0, 1.0 - r1)));
         uvec4 fi; vec3 fn; vec3 bc; float side; float dist;
         bool hit = bvhIntersectFirstHit(bvh, origin, d, fi, fn, bc, side, dist);
         vis += (hit && dist < uMaxDist) ? 0.0 : 1.0;
       }
       o0 = vec4(vis, float(RAYS), 0.0, 0.0);
     }`,
    {
      bvh: { value: null },
      uHighN: { value: null },
      uProj0: { value: null },
      uProj1: { value: null },
      uFront: { value: 0.02 },
      uMaxDist: { value: 0.6 },
      uSeed: { value: 0 },
      uSize: { value: new THREE.Vector2() },
    },
    { vertex: UV_SPACE_VERT, blending: 'add', defines: { RAYS: 2 } },
  );
}
