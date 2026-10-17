# Moonfang 3D: design document

How Moonfang is built, why, and what comes next. The [README](../README.md) describes features for users; this
document is for whoever works on the code. Paths are relative to the repository root.

Status: **Beta 0.1.1**. The Skin Lab and UV seam bridges (sections 5 and 6) are on the `claude/skinlab-seams` branch
and not released yet. Bake cages (section 8) are planned, not started.

## Contents

1. [Goals](#1-goals)
2. [Tech stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Layers, masks and generators](#4-layers-masks-and-generators)
5. [Skin Lab](#5-skin-lab)
6. [UV seam bridges](#6-uv-seam-bridges)
7. [Testing](#7-testing)
8. [Roadmap: adjustable bake cages](#8-roadmap-adjustable-bake-cages)
9. [Other roadmap items and known limitations](#9-other-roadmap-items-and-known-limitations)

## 1. Goals

- A free, open source (MIT) PBR texture painter that runs offline on an ordinary laptop GPU.
- Paint and fill layers with procedural masks, mesh-map baking, smart materials and export presets for common engines.
- Everything runs on the GPU in texture space, so painting is interactive even at 4096².
- No accounts, no telemetry. The only network use is the opt-in update check and bug reports the user sends.
- Describe features on their own terms: no other products' names in the UI, the README or code comments (export
  presets that name the target engines are fine, since they describe compatibility).

## 2. Tech stack

| Role | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript 7, ES modules | Type-checked with `tsc --noEmit`; Vite does the build |
| Build / dev server | Vite 8 | The dev server on port 5178 also backs the desktop shortcut |
| UI | Plain DOM | No UI framework: a small `h()` helper (`src/ui/dom.ts`) and one stylesheet (`src/style.css`) |
| Rendering | three.js r186 on WebGL2 | Needs float render targets (`EXT_color_buffer_float`); most work is custom GLSL |
| Ray casting | three-mesh-bvh | GPU BVH for high-poly baking (`src/engine/highPoly.ts`) |
| Archives | fflate | Project files (`.mfp`), libraries (`.mflib`) and zipped models |
| Desktop app | Electron 44 + electron-builder 26 | NSIS installer and portable `.exe` on Windows, AppImage on Linux |
| Bug reports | Cloudflare Worker (`report-relay/`) | Files GitHub issues; the token stays a Worker secret |
| Tests | `node:test`, Playwright | Unit tests for pure modules, end-to-end tests in a real browser |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Typecheck + build + unit tests, and an e2e job |

Hardware baseline: the development machine is an Intel Iris Xe. Two constraints shape the engine:

- **16 samplers per shader.** Past that, textures read wrong with no error, which is why the layer shader is split into
  separate paint and fill programs.
- **Long GPU draws trip the Windows GPU watchdog** and lose the WebGL context, so heavy bakes are split into strips
  (`StripScheduler` in `src/engine/meshMaps.ts`).

## 3. Architecture

```
src/
  main.ts, app.ts      boot, the App object (state, events, undo, texture sets), exposed as window.app
  engine/              WebGL and data code, no DOM
  ui/                  panels, menus, dialogs, input handling
  data/                built-in materials, smart materials, Skin Lab recipes (pure data)
electron/              desktop shell (main process + preload)
report-relay/          bug-report Worker
tests/, e2e/           unit and end-to-end tests
```

Main engine modules:

| Module | Responsibility |
| --- | --- |
| `painter.ts` | Projection painting: depth pre-pass, stamps rasterised in UV space, MAX-blended stroke mask, apply pass from a pre-stroke snapshot (also the undo entry) |
| `compositor.ts` | Layer compositing with ping-pong MRT passes, mask generators, and the final pass (sRGB → linear, packing, height → normal, UV padding) |
| `meshMaps.ts` | Mesh-map bake: UV coverage, jump-flood seed map, seam twin map, position / normal / curvature, AO from many depth maps, sharp-edge distance |
| `highPoly.ts` | High-poly reference mesh, projection along the low-poly normals inside a front/back cage, ray-traced AO |
| `meshLoader.ts`, `meshAnalysis.ts` | Loading `.glb/.gltf/.fbx/.obj`, normalising to a unit bounding sphere, curvature and sharp-edge analysis |
| `generators.ts`, `layers.ts` | Layer and generator data model (generators are kept WebGL-free so they can be unit tested) |
| `seams.ts` | UV seam strips (section 6), also WebGL-free |
| `faceSelect.ts` | Triangle-id picking and face selection for the polygon fill tool |
| `decals.ts`, `brushTips.ts` | Decal preparation (background removal, trimming, height) and brush tips |
| `decalProjection.ts` | Projected decals (section 4.1): cylinder fit, placement and the projection maths the shader mirrors, WebGL-free |
| `exporter.ts`, `gltfPack.ts` | Per-preset channel packing and PNG / EXR / GLB export; packing a `.gltf` and its buffers into a `.glb` |
| `project.ts`, `archive.ts`, `saves.ts`, `history.ts` | Project format, zip limits, autosaves and versions, unified undo |

Coordinate conventions:

- Meshes are normalised on load (centred, bounding radius 1). The original transform is kept for export.
- Mesh map A stores the position normalised to the model's bounding box (`posN`); `extentRatio` rebuilds isotropic
  positions from it. Procedural scales are therefore relative to the model's size, not to world units.
- Mesh map B stores the model-space normal and the curvature.

## 4. Layers, masks and generators

- **Paint layers** store value + coverage per channel in five RGBA8 targets. **Fill layers** are uniforms plus fbm
  variation, optionally with triplanar texture maps. **Folders** nest and carry their own mask and opacity.
- A **mask** is a painted greyscale target, optionally multiplied with a **generator**. Generator parameters:
  `amount` (coverage), `contrast` (edge sharpness), `noiseScale`, `noiseAmount` (breakup), `invert`, `axis`, `seed`.
  Eye generators add `mapping` and `offset` (section 5.3).
- The shader picks a generator by its index in `GEN_TYPES` (`src/engine/generators.ts`), so **new generators go at the
  end** of that list. A unit test pins the original order.
- A **smart material** is a list of fill-layer specs (`SmartLayerSpec`), each with optional generator, opacity and blend
  settings. `App.addSmartMaterial` turns one into a folder of real layers. After that, the layers are ordinary layers:
  the recipe that made them is not kept.

### 4.1 Projected decals

The decal tool has three **placements**:

- **Paint into the layer** (the original): the decal is stamped into the selected paint layer's pixels, projected from
  the camera. It's permanent once placed.
- **Wrap around** and **Project flat**: the click adds a new fill layer that projects the decal image
  (`FillLayer.projection`, `DecalProjection` in `src/engine/decalProjection.ts`, unit tested in
  `tests/decalProjection.test.mjs`). It's procedural: it can be moved, turned, resized or placed again at any time.
  This is how tattoos are made.

A projected decal lands where the stamp's cursor preview shows. The click finds the triangle through the face picker
(`App.pickFace`), so it lands on the active texture set. Its size comes from the preview's on-screen size at that
depth, and its rotation turns the image's up onto the screen's up, plus the drag angle.

**Wrap around** (arms, legs, neck, torso) bends the image around a cylinder: `x` is the arc length round from the
front and `y` the height along the axis. The cylinder is fitted to the clicked limb (`fitCylinder`):

- The axis is the direction the surface normals don't vary in: the smallest eigenvector of Σ n nᵀ over the samples
  within 0.6 × the decal's size of the click, on the side facing the click.
- The centre is where the normal lines meet, seen down the axis (least squares). That gives the radius.
- A nearly flat patch (the normals hardly spread) has no clear axis. The axis is then the direction closest to the
  model's up across the surface, and the radius is a guess.
- On a limb that isn't upright, the axis points towards the model's middle (the shoulder, the hip). That only fixes
  the frame: the rotation then matches the preview.

**Project flat** (chest, back, face, a car door) projects the image straight along the clicked surface's normal.

**Limits on where it lands.** Two limits stop a projection from reaching parts it shouldn't. The surface must face out
of the cylinder, or along the normal for flat placement, which keeps it off the far side of a limb. It must also be
within **Reach** of the placed radius or surface, which keeps it off the other arm or the torso.

**Colours.** By default the decal paints its own colours. **One ink colour (tattoos)** paints its dark lines in the
layer's colour (blue-black by default). Light areas inside the design stay as they are, because background removal
only clears paper that touches the image border.

**Properties** (on the layer): placement, slide along the limb (or up and down), turn around the limb (or left and
right), rotate, size, width, reach, mirror, colours, and **Place again**. Place again keeps the look and takes a new
spot and fit.

Shader: `projectionSample` in the fill-layer pass, one more sampler (13 of 16 in that program). `projectionUV` in
`decalProjection.ts` mirrors it for tests. The image is read at mip level 0, because the pass runs in UV space, where
screen derivatives jump at every UV seam. Projects store the image by texture id and embed it (`usedTextureIds`). A
projected decal whose image is missing draws nothing rather than a solid fill.

Limits:

- A wrapped decal has a seam where its ends meet, if it's wide enough to go all the way round.
- On a cross-section that isn't round, arc length is measured from the axis, so the image stretches a little where
  the surface bulges.
- Sharp folds (armpit, groin) can pull in surface from the next part. Lower Reach to stop that.
- There's no on-model gizmo: you fine-tune with the sliders.
- Mirror symmetry applies to stamps only, not to projected decals.

## 5. Skin Lab

**Skin Lab** (top menu → Skin… / Eyes…) builds skin and eye materials from a few plain-language controls. Its output is
an ordinary smart material: a folder of fill layers driven by generators. Everything it adds can be edited, reordered
or deleted like any other layer, and no special data is saved in projects. Tattoos are decals (4.1).

Code: recipes in `src/data/skinlab.ts` (pure functions, unit tested in `tests/skinlab.test.mjs`); dialog in
`src/ui/skinlab.ts`; generators `pores`, `freckles`, `blush`, `iris`, `pupil`, `limbal` and `eyeveins` in
`src/engine/compositor.ts`.

Design rules:

- **Works on any UVs.** Skin detail is projected in 3D (position, normal, curvature, AO). Eyes use sphere mapping by
  default (5.3). No special UV layout is required.
- **Fits heads and full bodies.** The defaults were tuned on a full-body game character (one texel is a few mm), where
  harsh or saturating signals show as bands and craters.
- **The dialog is a starting point.** Fine-tuning happens on the layers afterwards, in the Properties panel.

### 5.1 Skin

Controls (`SkinParams`): skin tone (`melanin`, 0 very light … 1 very deep, sampled from a six-step ramp), undertone
(−1 cool … +1 warm), blush, freckles, pores (a toggle, off by default, with a depth slider), oiliness, and grime coats (5.2). Six presets: Porcelain, Fair, Olive, Tan,
Brown, Deep.

Layers, bottom to top:

| Layer | Driven by | Why this way |
| --- | --- | --- |
| Skin Tone | flat colour + slight variation | Base colour and roughness (oiliness → roughness 0.62 … 0.3) |
| Blush | `blush` generator: clearly convex areas + soft noise | Gentle (opacity = blush × 0.6) and soft-edged. A full-strength, hard-edged blush leaves pale bands in every crease of a body |
| Recess Shading | `ao` generator, multiply blend, opacity 0.65 | Uses occlusion, not the dirt generator: concave curvature saturates on organic meshes and painted hard dark bands along the neck and blotches under the eyes |
| Freckles | `freckles` generator: cellular speckles in clusters | Skipped when the slider is near 0 |
| Pores (toggle) | `pores` generator: shallow cellular pits, height only | Off by default (`poresOn`) because the result doesn't look right yet. When on: height 0.47 and scale 320, since deeper or larger pits read as craters on a full body |
| Grime coats | see 5.2 | Over the skin, in order |

The Noise scale slider goes to 500 for `pores` and `freckles` (60 for the other generators), because those cells are
far finer than other patterns.

### 5.2 Grime coats

Stackable coats of dirt, oil and the like, each one a fill layer over the skin and the coats below it. A coat
(`GrimeCoat`) has a name, colour, **Amount** (coverage), **Smoothness** (0 matte … 1 glossy, mapped to roughness
0.95 … 0.05), a **pattern** and a seed.

| Pattern | Generator | Typical use |
| --- | --- | --- |
| Cavities & creases | `dirt` | Dirt, soot |
| Patches | low-frequency `noise` | Mud, motor oil |
| Splatter | high-contrast, finer `noise` | Blood |
| Top surfaces | `facing` | Dust |

Presets: Dirt, Mud, Motor Oil, Soot, Dust, Blood. The dialog can reorder, reseed and remove coats. Repeated coats get
numbered names and different seeds, so they land in different places. **Add coats only** adds just the coats, as
their own folder, to put over armour, clothes or an existing skin. Opacity rises from 0.5 to 1 with Amount, so thin
coats are see-through and thick ones hide what is under them.

### 5.3 Eyes

Controls (`EyeParams`): iris colour (six presets: Brown, Hazel, Green, Blue, Gray, Amber), iris size, pupil size, iris
fibres, limbal ring, bloodshot veins, mapping, look direction, **gaze** and **pupil offset**.

Layers, bottom to top: Sclera, Veins (when above 0), Iris, Iris Fibers (dark), Iris Fibers (light), Limbal Ring, Pupil.

**Mapping.** Eye generators measure a radius `r` and a direction around a gaze axis.

- **Sphere** (default): `r` is the angle between the **surface normal** and the look axis (`r = 0.5` at 60°). On a
  round eyeball the normal points away from the eyeball's own centre, so every eyeball in a texture set gets its own
  round iris, wherever it sits and however its UVs are laid out. An earlier version measured the direction from the
  *model's* centre. That broke on characters whose two eyes share one material, because the centre was the middle of
  the body.
- **UV disc**: the iris is a disc centred in the 0–1 UV square, for eye textures laid out that way.

**Look direction** is one of ±X, ±Y, ±Z. Each has a fixed screen frame (right / up as seen by a camera looking back at
the eye), so "right" and "up" mean the same thing on every axis.

**Placement.** The generator's `offset` moves the centre, x right and y up as seen looking at the eye.

- With sphere mapping, the offset is a gaze rotation: 0.5 = 60°.
- With UV mapping, it's a shift in UV units.
- In the dialog, **gaze** moves every eye layer. **Pupil offset** moves only the pupil and is limited to the gap between
  the iris and pupil radii, so the pupil stays inside the iris. Gaze is limited to ±0.5.
- After adding, each eye layer's Mask section has **Centre** sliders. With **Move whole eye** (on by default), they move
  every eye-generator layer in the same folder by the same amount, so the iris, ring, veins and pupil stay aligned.
  Each layer gets its own offset array, because layers built from one recipe would otherwise share it.

The dialog preview draws the eye to scale (`r = 0.5` is half the preview's height), so size and offset changes show
immediately.

Limits: sphere mapping assumes a roughly round eyeball, and a strong cornea bulge slightly compresses the iris. Both
eyes look the same way: there's no per-eye convergence yet.

## 6. UV seam bridges

Texture-space filters (the height → normal step, padding) used to read a copy of an island's own edge at UV seams. That
showed as a visible seam in strong height effects such as oil.

- `src/engine/seams.ts` welds vertices by position and finds edges that are shared by exactly two triangles whose UVs
  differ. For each side it builds a strip just outside the island, where every point stores the UV of the same surface
  point continued across the seam (`buildSeamStrips`, unit tested in `tests/seams.test.mjs`).
- `meshMaps.ts` rasterises the strips into a float **twin map** (`SEAM_TEXELS = 8` wide, depth-tested, enlarged so that
  strips past the 0–1 border fit, read through `twinXf`).
- `GLSL_REMAP` exposes a twin-aware `remap()`, which the final pass uses for its height samples. Normals are therefore
  continuous across seams wherever a twin exists, and fall back to jump-flood padding elsewhere.

The demo meshes look the same either way. An oil seam reported in testing has not been reproduced on its original
model, so this needs checking on that model before release.

## 7. Testing

- **Unit tests** (`npm test`, Node 24 `node:test`): archive limits, Skin Lab recipes, seam strips, curvature
  normalisation, projected decals (cylinder fit, orientation, projection). They cover only pure modules, so those modules import nothing from WebGL and use explicit `.ts`
  import paths.
- **End-to-end tests** (`npm run test:e2e`, Playwright, `e2e/skinlab.spec.ts`): boot without errors, the Skin Lab
  adding skin, eye and grime folders, gaze moving the whole eye, the pores toggle, a wrapped decal placed with
  the decal tool and adjusted, and the live preview. CI uses Playwright's Chromium;
  locally, set `PW_CHANNEL=msedge` to use the installed Edge.
- **Visual checks** are scripted, not automated: headless Edge with GPU flags
  (`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`) loads a reference character, bakes it at 1024 and saves
  screenshots. There are no automated image comparisons yet.

## 8. Roadmap: adjustable bake cages

### Where it stands

The bake dialog has **Cage front** and **Cage back** sliders (0–20 % of model size). Rays start at the low-poly surface
pushed out by *front* along the vertex normal (`ro = vPos + n * uFront` in `src/engine/highPoly.ts`), cast inward, and
take the first high-poly hit within *front + back*. The cage is one distance everywhere. There's no preview, no
per-area control and no custom cage mesh.

Problems this causes:

- Parts that stick out (ears, fingers, straps, antennae) need a large distance, which then catches the wrong surfaces
  elsewhere.
- Rays follow the shading normal, so where normals are split at hard edges, neighbouring rays diverge and can leave
  gaps or cracks along the edge. This is expected from the code, but it hasn't been confirmed with a test bake yet.
- The cage can't be seen, so finding the right distance is trial and error.

### Options

Estimates include tests. They come from reading the bake code, not from building it.

| # | Feature | What it gives | Effort |
| --- | --- | --- | --- |
| 1 | **Cage preview**: a see-through copy of the mesh pushed out by *front* (and optionally *back*) in the viewport | Check that the cage encloses the high poly before baking | Small (≈ ½ day): a vertex shader that offsets along normals |
| 2 | **Averaged ray normals**: weld vertices by position (as `seams.ts` does) and average the normals, for ray directions only | No gaps or cracks along hard edges; shading normals stay unchanged | Small (≈ ½ day) |
| 3 | **Paintable cage distance**: a greyscale cage map, painted with the normal brushes, that scales front/back per area | Push the cage out locally without inflating it everywhere | Medium (≈ 1–2 days): reuses the mask painting targets; the projection shader samples one more texture |
| 4 | **Import a cage mesh** with the low poly's topology | Full control for artists who build cages in a modelling app | Medium (≈ 2–3 days), with risk: rays run from cage vertex to low-poly vertex. Matching vertices is the hard part, because loading un-indexes and normalises geometry and exporters can reorder or split vertices. Needs a validation step and a clear error when the cage doesn't match |
| 5 | **Edit cage vertices in Moonfang**: select and move points, push or pull regions | Interactive cage editing | Large (multiple weeks): there are no mesh-editing tools today (vertex selection, move gizmo, geometry undo) |

### Plan

**Do 1, 2 and 3 together (≈ 2–3 days)**, in that order: the preview makes the other two testable.

- Most cage problems in practice are not seeing the cage, cracks at hard edges, and a few tight spots, and these three
  cover all of them with systems the app already has.
- Option 4 is a follow-up if artists ask to bring cages from a modelling app.
- Option 5 is out of scope for a texture painter: high cost for little gain over 3.

Design decisions to settle while building:

- **Cage map storage**: per texture set, at bake resolution, 8-bit greyscale, with 0.5 = the slider distance (0 … 2×).
  It's saved in the project file and is part of undo like a mask.
- **Where to paint it**: a "Cage" pseudo-layer in the bake dialog, or a toggle like *Paint mask*. The pseudo-layer is
  clearer and keeps it out of the material stack.
- **Preview**: drawn only while the bake dialog is open or the cage map is being painted, in a distinct colour, with
  back faces culled.
- **Compatibility**: projects without a cage map behave exactly as now.

Test plan:

- A reference low/high-poly pair with hard edges and thin parts (for example a hard-surface truck and a character head
  with ears).
- Bake before and after each step.
- Count texels with no hit along hard edges (step 2).
- Check that local cage changes don't affect anything elsewhere (step 3).
- Unit-test the normal averaging and the cage-map scaling as pure functions.

## 9. Other roadmap items and known limitations

- High-poly baking projects every texture set against the whole high poly. There's no matching by mesh name yet.
- Normals use a per-triangle UV tangent frame, not MikkTSpace, so some engines may shade the low poly's smoothing
  slightly differently.
- Missing so far: an anchor/filter system, and emissive/opacity maps in imported texture sets.
- Symmetry is off while painting in the 2D view.
- No macOS desktop build yet (it has to be built and signed on a Mac).
- Desktop only: touch-only devices aren't supported.
- Projected decal follow-ups:
  - an on-model gizmo (drag to move, turn and scale)
  - a true surface wrap for areas that aren't tube-shaped (shoulder caps, the face)
  - mirror symmetry
- Skin Lab follow-ups:
  - rework pore relief, then turn the Pores toggle on by default
  - per-eye convergence
  - a click-to-aim tool for the gaze
  - raising the iris Noise scale slider max (its default of 70 is above the slider's max of 60)
  - checking the seam bridges on the model where the oil seam was reported
