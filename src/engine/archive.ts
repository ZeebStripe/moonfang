import { unzipSync, type UnzipFileInfo } from 'fflate';

// Keep imported archives within a size the desktop app can reasonably open.
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export function assertArchiveSize(size: number): void {
  if (size > MAX_ARCHIVE_BYTES) throw new Error('Archive is too large to open (512 MB limit).');
}

export function assertMetadataSize(size: number): void {
  if (size > MAX_METADATA_BYTES) throw new Error('Project or library metadata is too large (8 MB limit).');
}

/** Apply the same limits to files produced by Moonfang, so a saved archive remains reopenable. */
export function assertUnpackedFiles(files: Record<string, Uint8Array>): void {
  let count = 0;
  let total = 0;
  for (const data of Object.values(files)) {
    count++;
    total += data.length;
    if (count > MAX_ENTRIES || data.length > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error('Project or library exceeds the supported archive size (1 GB total, 512 MB per file, 2048 files).');
    }
  }
}

/** Inspect every ZIP entry before fflate allocates its decompressed output. */
export function unzipBounded(
  bytes: Uint8Array,
  accept: (entry: UnzipFileInfo) => boolean = () => true,
  onEntry?: (entry: UnzipFileInfo) => void,
): Record<string, Uint8Array> {
  assertArchiveSize(bytes.length);
  let count = 0;
  let total = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      count++;
      total += entry.originalSize;
      if (
        count > MAX_ENTRIES ||
        !Number.isSafeInteger(entry.originalSize) ||
        entry.originalSize < 0 ||
        entry.originalSize > MAX_ENTRY_BYTES ||
        total > MAX_TOTAL_BYTES
      ) throw new Error('Archive expands beyond the supported size (1 GB total, 512 MB per file, 2048 files).');
      onEntry?.(entry);
      return accept(entry);
    },
  });
}
