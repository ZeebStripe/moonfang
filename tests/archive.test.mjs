import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { assertArchiveSize, assertMetadataSize, assertUnpackedFiles, unzipBounded } from '../src/engine/archive.ts';

test('opens an ordinary archive and can inspect its names without extraction', () => {
  const zipped = zipSync({ 'project.json': new TextEncoder().encode('{}') });
  assert.equal(new TextDecoder().decode(unzipBounded(zipped)['project.json']), '{}');
  const names = [];
  assert.deepEqual(unzipBounded(zipped, () => false, (entry) => names.push(entry.name)), {});
  assert.deepEqual(names, ['project.json']);
});

test('rejects an oversized entry from ZIP metadata before decompressing it', () => {
  const zipped = zipSync({ model: new Uint8Array([1]) });
  const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  let central = -1;
  for (let i = 0; i < zipped.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      central = i;
      break;
    }
  }
  assert.notEqual(central, -1);
  view.setUint32(central + 24, 512 * 1024 * 1024 + 1, true);
  assert.throws(() => unzipBounded(zipped), /Archive expands beyond/);
});

test('rejects archives with too many entries', () => {
  const files = Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [`file-${i}`, new Uint8Array(0)]));
  assert.throws(() => unzipBounded(zipSync(files)), /Archive expands beyond/);
  assert.throws(() => assertUnpackedFiles(files), /exceeds the supported archive size/);
});

test('applies size limits to generated archives and metadata', () => {
  assertArchiveSize(512 * 1024 * 1024);
  assert.throws(() => assertArchiveSize(512 * 1024 * 1024 + 1), /512 MB limit/);
  assertMetadataSize(8 * 1024 * 1024);
  assert.throws(() => assertMetadataSize(8 * 1024 * 1024 + 1), /8 MB limit/);
});
