# Open Painter

A free, open source 3D texture painting tool for game assets.
It runs in the browser (WebGL2) and is built with TypeScript and three.js.

## Features (v0.1)

- **Projection painting** onto the 3D model across every PBR channel at once: base color, roughness, metallic and height. It paints across UV seams and is occlusion-aware, so strokes never bleed onto hidden surfaces. It also fades out at grazing angles.
- **Brush**: size, hardness, opacity, spacing, pen pressure (size and/or opacity), per-channel toggles and an eraser.
- **Layer stack**: paint layers and procedural fill layers with:
  - opacity
  - blend modes (normal, multiply, screen, overlay, add, subtract) plus separate height blending
  - visibility, drag-and-drop reordering and duplication
- **Masks**: painted masks (black/white/grey) that multiply with procedural **generators**:
  - Edge Wear, Dirt/Cavity, Top-Facing (dust), Position Gradient, Noise, Ambient Occlusion, Curvature
  - each generator has amount, contrast, noise breakup, scale, invert and seed controls
- **Mesh map baking** from the low-poly mesh, done on the GPU:
  - ambient occlusion, using 32–512 hemispherical shadow-map samples and a max distance
  - curvature (dominant principal curvature)
  - world-space normal and position maps
  - UV padding through a jump-flood dilation, so there are no seams at mip levels
- **Materials**: 27 PBR presets, with rendered thumbnails, that you can use on the brush or add as fill layers.
- **Smart materials**: Worn Painted Steel, Military Paint, Rusty Iron, Weathered Copper, Scuffed Plastic, Antique Gold and Dusty Concrete. Each is a stack of fill layers driven by generators.
- **Your own materials**, via **Library ▾** in the shelf or drag & drop:
  - Import **PBR texture sets** (for example from ambientCG or Poly Haven). Maps are detected from file names: `BaseColor/Albedo/Diffuse`, `Roughness` (or `Gloss`, which is inverted), `Metallic`, `Height/Displacement`, and packed `ARM/ORM`.
  - Textured materials are projected **triplanar** in object space, so they are seamless across UV seams. You can paint with them or use them as fill layers, with adjustable tiling and a color tint.
  - Save a fill layer as a material, or a set of fill layers (with their generator masks) as a **smart material**.
  - Your library is stored in the browser (IndexedDB). Export or import it as `.oplib` (a zip with the images) or as plain `.json`. Projects embed the textures they use.
- **Smart masks**: one-click generator presets.
- **Viewport**:
  - PBR preview with image-based lighting (built-in studio or your own `.hdr`)
  - exposure and environment rotation
  - channel views: base color, roughness, metallic, height, normal, AO, curvature, world normal, position, layer mask
- **Export**:
  - texture sets as PNG zips, with presets for **separate PBR maps**, **glTF/Godot/three.js (ORM)**, **Unreal (ORM, DirectX normal)**, **Unity URP (Metallic/Smoothness)** and **Unity HDRP (Mask Map)**
  - a **textured GLB** with the material applied
- **Projects**: save and load `.opp` files, which contain the mesh, layers, masks and settings, all lossless.
- **Undo/redo** for strokes and fills, with 24 steps.
- **Texture resolution**: 512–4096, and existing layers are resampled when you change it.

## Getting started

```bash
npm install
npm run dev
```

Then open http://localhost:5178. A demo mesh loads automatically. To use your own mesh, use **File → Open Mesh**, or drag a
file onto the viewport. The mesh needs non-overlapping UVs in 0–1.

| Mesh format | Notes |
| --- | --- |
| `.glb` | Recommended. |
| `.gltf` | Only with embedded buffers. A `.gltf` that uses a separate `.bin` file or external textures can't be opened yet; convert it to `.glb`. |
| `.obj` | Mesh only. The `.mtl` file is ignored. |
| `.fbx` | Binary or ASCII. Skinned meshes are painted in their bind pose. |

On Windows PowerShell 5.1, chain commands with `;` rather than `&&`:

```powershell
cd "$env:USERPROFILE\OneDrive\Dokumente\open-painter"; npm run dev
```

To build a static site into `dist/`, which you can host anywhere:

```bash
npm run build
```

### Typical workflow

1. Load a mesh. The mesh maps bake automatically.
2. Pick a material in the shelf to paint it with the brush, or press **+** on a material to add it as a fill layer.
3. To paint a material on: add a fill layer, give it a **black mask** (from the mask button on the layer stack), then paint the mask white.
4. To add wear and grime: click a **Smart Material**, or apply a **Smart Mask** to a layer and tweak the generator in the Properties panel.
5. Export with **Export** in the top right.

### Controls

| Input | Action |
| --- | --- |
| Left mouse | Paint |
| Alt + Left mouse / Middle mouse | Orbit |
| Right mouse / Shift + Middle mouse | Pan |
| Wheel | Zoom |
| `B` / `E` | Paint / Erase |
| `[` `]` | Brush size (with Shift: hardness) |
| `X` | Swap the mask paint value (black/white) |
| `M` | Toggle painting the layer content / its mask |
| `C` | Cycle the viewport channel |
| `F` | Frame the model |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+O / Ctrl+S / Ctrl+E | Open mesh / Save project / Export |
| `?` | Shortcut list |

## How it works

All painting and compositing runs on the GPU in **texture space**.

- **Painting** (`src/engine/painter.ts`): A depth pre-pass renders the model from the camera. Each batch of brush stamps
  then rasterises the mesh *in UV space*. Each texel projects its world position into the screen, tests it against the
  depth map, and accumulates brush falloff into a stroke mask using MAX blending. An apply pass re-derives the layer from
  a pre-stroke snapshot, so stroke opacity never builds up, and that snapshot doubles as the undo entry.
- **Layers** (`src/engine/compositor.ts`): Paint layers store per-channel value + coverage in three RGBA8 targets. Fill
  layers are uniforms plus fbm variation. Each layer is composited with ping-pong MRT passes, with masks and generators
  evaluated in the same shader. A final pass converts sRGB to linear, packs AO/roughness/metallic/height, derives a
  tangent-space normal from height, and applies UV padding through the jump-flood seed map.
- **Mesh maps** (`src/engine/meshMaps.ts`): UV coverage, a jump-flood nearest-texel seed map, position/normal/curvature
  rasterised in UV space, and AO accumulated from many orthographic depth maps.
- **Export** (`src/engine/exporter.ts`): Channels are re-packed per preset on the GPU and encoded with a small built-in
  PNG encoder, because canvas encoding premultiplies alpha and would destroy data stored in alpha channels. UV
  orientation and normal-map green conventions are corrected per source format.

## Limitations / roadmap

- One texture set per model. Multi-material models are merged into one UV space.
- No baking from a high-poly mesh yet. Curvature and AO come from the low-poly mesh, so edges need actual bevels for edge wear.
- Missing so far: symmetry painting, brush alphas/stencils, layer folders, an emissive/opacity channel, an anchor/filter system, and a 2D UV view.
- Texture sets: normal maps are skipped, because layers carry height rather than normals; use the set's height map. `.sbsar` procedural material files can't be imported, since they need a proprietary engine.
- PNG export is 8-bit, so there is no 16-bit height or EXR output yet.
- WebGL2 with `EXT_color_buffer_float` is required. That covers any recent desktop browser.

## License

MIT. See [LICENSE](LICENSE).
