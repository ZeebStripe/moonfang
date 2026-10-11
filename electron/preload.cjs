// The only desktop-specific API the page gets. It can learn where a picked/dropped file lives on disk, and read the
// buffer files a .gltf on disk references (checked in the main process); nothing else on the file system.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('moonfangDesktop', {
  /** Absolute path of a File the user picked or dropped ('' when it has none, e.g. from a zip). */
  pathForFile: (file) => webUtils.getPathForFile(file),
  /** Bytes of a buffer referenced by the .gltf at `gltfPath` (uri exactly as written in it), or null. */
  readGltfBuffer: (gltfPath, uri) => ipcRenderer.invoke('read-gltf-buffer', gltfPath, uri),
});
