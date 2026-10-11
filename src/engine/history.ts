import type { Layer, LayerMask } from './layers';
import { walkLayers } from './layers';
import type { PixelEntry } from './painter';

/**
 * Snapshot of a layer tree: structure plus every layer's (and mask's) non-GPU properties. Snapshots reference the
 * live layer objects, so GPU textures are shared with the document; pixel changes are tracked separately
 * (PixelEntry), and both kinds interleave on one undo stack.
 */
export interface TreeState {
  layers: LayerSnap[];
  selectedId: number | null;
  /** identity of the snapshot's contents, to skip no-op commits */
  key: string;
}

interface LayerSnap {
  layer: Layer;
  props: Record<string, unknown>;
  mask: LayerMask | null;
  maskProps: Pick<LayerMask, 'enabled' | 'generator'> | null;
  children: LayerSnap[] | null;
}

/** UI-only state that shouldn't create (or be reverted by) undo steps. */
const IGNORED = new Set(['rt', 'mask', 'children', 'collapsed']);

const maskIds = new WeakMap<LayerMask, number>();
let nextMaskId = 1;
const maskId = (m: LayerMask) => {
  if (!maskIds.has(m)) maskIds.set(m, nextMaskId++);
  return maskIds.get(m)!;
};

function snap(l: Layer): LayerSnap {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l)) if (!IGNORED.has(k)) props[k] = structuredClone(v);
  return {
    layer: l,
    props,
    mask: l.mask,
    maskProps: l.mask ? structuredClone({ enabled: l.mask.enabled, generator: l.mask.generator }) : null,
    children: l.kind === 'group' ? l.children.map(snap) : null,
  };
}

function keyOf(list: LayerSnap[]): unknown[] {
  return list.map((s) => [s.props, s.mask ? maskId(s.mask) : 0, s.maskProps, s.children ? keyOf(s.children) : null]);
}

export function captureTree(layers: Layer[], selectedId: number | null): TreeState {
  const snaps = layers.map(snap);
  return { layers: snaps, selectedId, key: JSON.stringify(keyOf(snaps)) };
}

function unsnap(s: LayerSnap): Layer {
  const l = s.layer as Layer & Record<string, unknown>;
  for (const [k, v] of Object.entries(s.props)) l[k] = structuredClone(v);
  l.mask = s.mask;
  if (s.mask && s.maskProps) Object.assign(s.mask, structuredClone(s.maskProps));
  if (l.kind === 'group') l.children = s.children!.map(unsnap);
  return l;
}

/** Puts the snapshot's layers back into their recorded state; returns the root list. */
export function restoreTree(state: TreeState): Layer[] {
  return state.layers.map(unsnap);
}

/** Every layer and mask a snapshot refers to. */
export function treeRefs(state: TreeState, layers: Set<Layer>, masks: Set<LayerMask>) {
  const visit = (list: LayerSnap[]) => {
    for (const s of list) {
      layers.add(s.layer);
      if (s.mask) masks.add(s.mask);
      if (s.children) visit(s.children);
    }
  };
  visit(state.layers);
}

export function liveRefs(list: Layer[], layers: Set<Layer>, masks: Set<LayerMask>) {
  for (const l of walkLayers(list)) {
    layers.add(l);
    if (l.mask) masks.add(l.mask);
  }
}

export type HistoryEntry<Owner> =
  | { kind: 'pixels'; label: string; entry: PixelEntry }
  | { kind: 'tree'; label: string; owner: Owner; before: TreeState; after: TreeState };
