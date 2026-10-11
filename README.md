# Moonfang 3D

**Moonfang 3D** (Moonfang for short) is a free, open source 3D texture painting tool for game assets: paint PBR
materials straight onto your models, layer smart materials and masks, and export ready-to-use texture sets.
It runs as a desktop app or in the browser (WebGL2) and is built with TypeScript and three.js.

### [⬇ Download Moonfang 3D for Windows or Linux](https://github.com/ZeebStripe/moonfang/releases)

Open the newest release, then under **Assets** pick `Moonfang-3D-Setup-….exe` (Windows) or the `.AppImage` (Linux).
The app isn't among the repository's files above; it is only on the Releases page.

![Moonfang 3D with the Rusty Iron smart material on a torus knot](docs/screenshots/hero.png)

| | |
| --- | --- |
| ![Cel Shaded Comic smart material on a vase](docs/screenshots/cel-shaded.png) | ![A model with two texture sets: worn painted steel and antique gold](docs/screenshots/texture-sets.png) |
| Smart materials, here *Cel Shaded Comic*: ink outlines and light bands from baked mesh maps | One texture set per material, each with its own layer stack |
| ![The export dialog with the glTF / Godot preset](docs/screenshots/export.png) | |
| Export presets for Unreal, Unity, glTF/Godot, or a textured GLB | |

> **Public beta (Beta 0.1.0).** Expect rough edges and please report what breaks:
> **Help → Report a Bug** in the app, or [open an issue](https://github.com/ZeebStripe/moonfang/issues/new/choose).

## Features

- **Projection painting** onto the 3D model across every PBR channel at once: base color, roughness, metallic, height, normal, **emissive** and **opacity**. Normal detail is combined with the normal derived from height, and normal maps are projected triplanar, then converted into each texel's UV tangent frame (baked as a mesh map). It paints across UV seams and is occlusion-aware, so strokes never bleed onto hidden surfaces. It also fades out at grazing angles.
- **Brush**: size, hardness, opacity, spacing, pen pressure (size and/or opacity), per-channel toggles and an eraser.
  - **Tips**: round, square, splatter, grunge, scratches, star and leaf, plus imported images (dark-on-light images are inverted automatically). Tips have an angle and can follow the stroke direction.
  - **Dynamics**: size, angle and opacity jitter, scatter, and lazy-mouse smoothing.
  - **Symmetry**: mirror strokes across the model's center on X, Y or Z.
  - **Stencils**: an image fixed to the screen that masks the brush. Hold `S` and drag to move it, scroll to scale, or Shift+scroll to rotate. It can be tiled, and "Use colors" turns it into a **decal projector**.
- **Layer stack**: paint layers, procedural fill layers and **folders**, with:
  - opacity
  - blend modes (normal, multiply, screen, overlay, add, subtract) plus separate height blending
  - visibility, drag-and-drop reordering and duplication
  - folders that can be nested, collapsed, and given their own mask or opacity; drag layers into or out of them, and Ctrl+G wraps the selected layer in a new folder. Smart materials arrive as a folder.
- **Polygon fill** (`P`): select faces and assign materials to them. Click or drag over the model to select whole
  **polygons** (quads), single **triangles**, **UV islands** or connected **mesh parts**. Shift+drag box-selects the visible
  faces, and Ctrl deselects. Then click a material or smart material in the shelf: it is added as a fill layer (or folder)
  masked to exactly those faces. You can also show or hide the selected layer on them, or fill them with the brush.
  It works in the 2D UV view too.
- **Masks**: painted masks (black/white/grey) that multiply with procedural **generators**:
  - Edge Wear, Dirt/Cavity, Top-Facing (dust), Position Gradient, Noise, Ambient Occlusion, Curvature
  - each generator has amount, contrast, noise breakup, scale, invert and seed controls
- **Mesh map baking** from the low-poly mesh, done on the GPU:
  - ambient occlusion, using 32–512 hemispherical shadow-map samples and a max distance
  - curvature (dominant principal curvature, with normals smoothed only across gentle angles)
  - a **sharp-edge map**: distance to the nearest hard convex / concave edge (faces meeting above the *sharp edge
    angle*), so low-poly hard-surface models get crisp, even-width edge wear and ink lines
  - world-space normal and position maps
  - UV padding through a jump-flood dilation, so there are no seams at mip levels
  - **from a high-poly mesh** (Mesh → Bake Mesh Maps → High poly): its detail is ray-traced onto the low poly
    (GPU BVH via [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)) along the low-poly normals, inside an
    adjustable front/back cage. That gives a tangent-space normal map, which sits under all painted normals and is
    included in exports, plus high-poly AO and curvature for the smart masks. The high poly has to sit at the same
    position and in the same units as the low poly. It is stored in the project file.
- **Materials**: 27 PBR presets, with rendered thumbnails, that you can use on the brush or add as fill layers.
- **Smart materials**: Worn Painted Steel, Military Paint, Rusty Iron, Weathered Copper, Scuffed Plastic, Antique Gold, Dusty Concrete and **Cel Shaded Comic** (comic-book ink outlines, hard light/shadow bands and hatching) and **Cel Shaded Outline** (the same without hatching). Each is a stack of fill layers driven by generators, added as a folder. Select the folder to recolor the whole material from one **Colors** list.
- **Your own materials**, via **Library ▾** in the shelf or drag & drop:
  - Import **PBR texture sets** (for example from ambientCG or Poly Haven). Maps are detected from file names: `BaseColor/Albedo/Diffuse`, `Roughness` (or `Gloss`, which is inverted), `Metallic`, `Height/Displacement`, `Normal` (OpenGL, or DirectX when the name contains `DX`), and packed `ARM/ORM`.
  - Textured materials are projected **triplanar** in object space, so they are seamless across UV seams. You can paint with them or use them as fill layers, with adjustable tiling and a color tint.
  - Save a fill layer as a material, or a set of fill layers (with their generator masks) as a **smart material**.
  - Your library is stored in the browser (IndexedDB). Export or import it as `.mflib` (a zip with the images) or as plain `.json`. Projects embed the textures they use.
- **Smart masks**: one-click generator presets.
- **Viewport**:
  - PBR preview with image-based lighting (built-in studio or your own `.hdr`)
  - exposure and environment rotation
  - channel views: base color, roughness, metallic, height, normal, emissive, opacity, AO, curvature, world normal, position, layer mask
  - a **2D UV view** (toggle `3D | 2D` in the top bar, or `U`): the active texture set's texture laid out flat with its
    UV wireframe, UV padding dimmed. You can pan, zoom and **paint** there too: strokes are projected onto a flat copy
    of the mesh at its UVs, using the same painter as the 3D view.
- **Export**:
  - texture sets as **8-bit PNG, 16-bit PNG or OpenEXR** (half float, linear color) zips, with presets for **separate PBR maps**, **glTF/Godot/three.js (ORM)**, **Unreal (ORM, DirectX normal)**, **Unity URP (Metallic/Smoothness)** and **Unity HDRP (Mask Map)**
  - an Emissive map and base-color alpha (opacity) are added automatically when those channels are used
  - a **textured GLB** with the material applied (emissive texture and alpha blending included when used)
- **Projects**: save and load `.mfp` files, which contain the mesh, layers, masks and settings, all lossless.
- **Multiple texture sets**: each material of the model is its own texture set, with its own layer stack, resolution and baked maps. Switch sets above the layer stack. Painting only affects the active set, while the whole model still occludes. Export writes one set of maps per texture set (`<name>_<set>_<map>.png`), and the GLB gets one material per set.
- **Undo/redo** for strokes, fills and layer operations: adding, deleting, duplicating, moving and grouping layers,
  masks and generators, renames and property changes (a slider drag is one step). Up to 80 steps, 24 of them strokes.
- **Autosave**: every 30 seconds to browser storage, with a restore prompt the next time you start.
- **Texture resolution**: 512–4096, and existing layers are resampled when you change it.

## Getting started

### Desktop app (recommended)

Download the latest build from the [Releases page](https://github.com/ZeebStripe/moonfang/releases):

- **Windows**: download `Moonfang-3D-Setup-<version>.exe` and double-click it in your Downloads folder. The installer
  starts Moonfang 3D when it finishes and adds Desktop and Start menu shortcuts. To skip installing, use
  `Moonfang-3D-Portable-<version>.exe` instead: double-click it to run. The builds aren't code-signed yet, so Windows
  SmartScreen may warn the first time: choose *More info → Run anyway*.
- **Linux**: `Moonfang-3D-Linux-<version>-x86_64.AppImage`. Make it executable (`chmod +x`, or Properties → allow
  running as a program) and double-click it.
- You don't need the *Source code* downloads; they're for developers.

The desktop app works fully offline. It bundles its own Chromium, so it doesn't depend on your browser.

To build the desktop app yourself: `npm install`, then `npm run dist:win` (on Windows) or `npm run dist:linux` (on Linux).
The packages land in `release/`. `npm run app` runs it without packaging.

Bug reports: **Help → Report a Bug** sends reports through `report-relay/`, a tiny Cloudflare Worker that files them as
GitHub issues (see [report-relay/README.md](report-relay/README.md) to set it up). Until its URL is set in
`src/meta.ts`, the app opens the prefilled GitHub issue form instead.

### From source, in your browser

On Windows, double-click **`create-shortcut.bat`** once. It adds a **Moonfang** shortcut to the desktop and
the Start menu that opens the app in its own window of your default browser, without tabs or address bar (app
mode in Edge, Chrome, Brave or Vivaldi; a separate profile with the toolbars hidden in Firefox), and stops the
server again when you close that window. The app window uses its own browser profile, so its autosave is
separate from a normal browser tab's.

Alternatively, **`start.bat`** starts Moonfang and opens it in your browser (it installs the dependencies on
first run), and **`stop.bat`** stops it.

On Linux, run **`./create-shortcut.sh`** once. It adds Moonfang to the application menu (and the desktop) with
the same behaviour: your default browser in an app-style window, server stopped on close. Snap and Flatpak browsers
are supported. **`./start.sh`** and **`./stop.sh`** work like the Windows scripts. You need Node.js 20+ and a
browser with WebGL2; on Linux Chrome, check `chrome://gpu` that WebGL is hardware accelerated.

Or manually, on any system:

```bash
npm install
npm run dev
```

Then open http://localhost:5178. A demo mesh loads automatically. To use your own mesh, use **File → Open Mesh**, or drag a
file, a model folder or a zipped model onto the viewport. The mesh needs non-overlapping UVs in 0–1.

| Mesh format | Notes |
| --- | --- |
| `.glb` | Recommended. |
| `.gltf` | Select or drop it together with its `.bin` file(s), drop its whole folder, use **File → Open Mesh Folder…**, or open a `.zip` of it (as downloaded from Sketchfab and similar sites). In the desktop app, opening just the `.gltf` is enough: its `.bin` files are read from the same folder. If a `.bin` is missing, Moonfang asks for it. The model's own texture images aren't needed: Moonfang only uses the geometry, UVs and materials, and packs the rest into a single `.glb` inside the project. |
| `.obj` | Mesh only. The `.mtl` file is ignored. |
| `.fbx` | Binary or ASCII. Skinned meshes are painted in their bind pose. |

On Windows PowerShell 5.1, chain commands with `;` rather than `&&`:

```powershell
cd "C:\Users\ashmedai\Documents\moonfang"; npm run dev
```

To build a static site into `dist/`, which you can host anywhere:

```bash
npm run build
```

### Saving your work

- **Autosave** runs every 30 seconds while you work (and when the window loses focus). The newest 5 autosaves are
  kept, and the next start offers to restore the latest one.
- **File → Save Version…** (Ctrl+Alt+S) is an iterative save: it stores the current state as the next numbered
  version of the project (v1, v2, …) with an optional note. Versions are kept until you delete them.
- **File → Saved Versions…** lists versions and autosaves. Restore any of them (your unsaved changes are autosaved
  first, so restoring is never destructive), download one as a `.mfp` file, or delete it.
- **File → Save Project** (Ctrl+S) downloads a `.mfp` project file to keep or share. Versions and autosaves live inside
  the app's own storage, so download the ones you care about as a backup.

### Typical workflow

1. Load a mesh. The mesh maps bake automatically.
2. Pick a material in the shelf to paint it with the brush, or press **+** on a material to add it as a fill layer.
3. To put a material on specific parts: press **P** (polygon fill), select the faces, and click the material in the shelf.
   To paint it on freely instead: add a fill layer, give it a **black mask** (from the mask button on the layer stack), then paint the mask white.
4. To add wear and grime: click a **Smart Material**, or apply a **Smart Mask** to a layer and tweak the generator in the Properties panel.
5. Export with **Export** in the top right.

### Controls

| Input | Action |
| --- | --- |
| Left mouse | Paint |
| Alt + Left mouse / Middle mouse | Orbit |
| Right mouse / Shift + Middle mouse | Pan |
| Wheel | Zoom |
| `B` / `E` / `P` | Paint / Erase / Polygon fill |
| Polygon fill: Left mouse | Select faces (drag to select more; Ctrl deselects) |
| Polygon fill: Shift + drag | Box-select the visible faces |
| Polygon fill: `1` `2` `3` `4` | Select triangles / polygons / UV islands / mesh parts |
| Polygon fill: Ctrl+A / Ctrl+I / Esc | Select all / Invert / Clear the selection |
| Ctrl + Right mouse drag | Brush size (left/right) or hardness (up/down) |
| `[` `]` | Brush size (with Shift: hardness) |
| `X` | Swap the mask paint value (black/white) |
| `S` (hold) | Stencil: drag to move, scroll to scale, Shift+scroll to rotate |
| Ctrl+G | Put the selected layer in a new folder |
| `M` | Toggle painting the layer content / its mask |
| `C` | Cycle the viewport channel |
| `F` | Frame the model (the UV square in the 2D view) |
| `U` | Toggle the 3D / 2D UV view |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+O / Ctrl+S / Ctrl+E | Open mesh / Save project / Export |
| Ctrl+Alt+S | Save version |
| `?` | Shortcut list |

## How it works

All painting and compositing runs on the GPU in **texture space**.

- **Painting** (`src/engine/painter.ts`): A depth pre-pass renders the model from the camera. Each batch of brush stamps
  then rasterises the mesh *in UV space*. Each texel projects its world position into the screen, tests it against the
  depth map, and accumulates brush falloff into a stroke mask using MAX blending. An apply pass re-derives the layer from
  a pre-stroke snapshot, so stroke opacity never builds up, and that snapshot doubles as the undo entry.
- **Polygon fill** (`src/engine/faceSelect.ts`): The visible triangles' ids are rendered into an offscreen buffer and read
  back once per view, so hovering and box selection are lookups. Selected faces are rasterised in UV space into the mask
  (or into the stroke mask, for brush fills), so the fill follows the face borders exactly.
- **Layers** (`src/engine/compositor.ts`): Paint layers store per-channel value + coverage in five RGBA8 targets. Fill
  layers are uniforms plus fbm variation. Each layer is composited with ping-pong MRT passes, with masks and generators
  evaluated in the same shader. A final pass converts sRGB to linear, packs AO/roughness/metallic/height, derives a
  tangent-space normal from height, and applies UV padding through the jump-flood seed map.
- **Mesh maps** (`src/engine/meshMaps.ts`): UV coverage, a jump-flood nearest-texel seed map, position/normal/curvature
  rasterised in UV space, and AO accumulated from many orthographic depth maps.
- **Export** (`src/engine/exporter.ts`): Channels are re-packed per preset on the GPU and encoded with a small built-in
  PNG encoder, because canvas encoding premultiplies alpha and would destroy data stored in alpha channels. UV
  orientation and normal-map green conventions are corrected per source format.

## Limitations / roadmap

- High-poly baking projects every texture set against the whole high poly (no matching by mesh name yet), and the cage
  is a uniform distance rather than an editable cage mesh. Normals use a per-triangle UV tangent frame, not MikkTSpace,
  so other engines may show slight shading differences on the low poly's smoothing.
- Missing so far: an anchor/filter system, and emissive/opacity texture maps in imported materials (both channels can
  be painted and filled, but texture-set import only reads color/roughness/metallic/height/normal).
- Symmetry is disabled while painting in the 2D view.
- `.sbsar` procedural material files can't be imported, since they need a proprietary engine.
- WebGL2 with `EXT_color_buffer_float` is required. That covers any recent desktop browser.
- Desktop only: phones and touch-only tablets aren't supported (a mouse or pen tablet is needed).
- No macOS desktop build yet (it has to be built and signed on a Mac); Mac users can run it from source in a browser.

## Privacy

Moonfang runs entirely on your computer. There are no accounts, no analytics or telemetry, and nothing you load,
paint or save is uploaded anywhere. Projects, autosaves, versions and your material library are stored locally (in the
desktop app's data folder, or in the browser's storage for this site).

Moonfang only goes online in these cases:

- **Update check**: on start, it downloads the public list of Moonfang releases from GitHub to see whether a newer
  version exists. Nothing about you or your work is sent. Turn it off in the "new version" popup; **Help → Check for
  Updates** still works by hand.
- **Bug reports you send**: **Help → Report a Bug** opens a report form in the app. It shows exactly what will be sent
  along with your text (app version, browser, graphics card and, if you tick the box, errors from this session), and
  nothing leaves your computer until you press **Send**. Reports go privately to the developer through a small relay
  server (`report-relay/`), which uses your IP address only briefly, to stop spam. You can also choose **Use GitHub
  instead** to file a public issue yourself. Errors are only kept in memory while the app runs, never stored or sent
  automatically.
- **Links you click**: GitHub, Ko-fi and release pages open in your browser.

## Support

Moonfang is free. If you'd like to support its development, you can [buy me a coffee on Ko-fi](https://ko-fi.com/zeebstripe)
(also under **Help** in the app).

## License

MIT. See [LICENSE](LICENSE). Moonfang bundles three.js, three-mesh-bvh and fflate (all MIT); their licenses are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which also ships with every build.
