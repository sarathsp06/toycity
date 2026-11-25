// Every model loads through here: a GLTFLoader that can read meshopt-compressed files
// (EXT_meshopt_compression, decoded in WebAssembly by three.js's own decoder). tools/build_site.sh
// compresses the room, the people and their animations for the website, about half their download; the uncompressed files in
// web/models load just the same (the tools that make them read them back).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export function gltfLoader() { return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder); }

// A compressed file stores positions and normals as small normalised integers, with the scale that
// restores them on the mesh's node. Code that bakes a node's transform into a copy of its geometry
// (the cars, which are rebuilt into instanced and drivable cars) must turn them back into floats first,
// or the bake clamps every vertex to the integers' range.
export function floatGeometry(geo) {
  for (const k of ['position', 'normal', 'tangent']) {
    const a = geo.attributes[k]; if (!a || (a.array instanceof Float32Array && !a.isInterleavedBufferAttribute && !a.normalized)) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.getComponent(i, j);
    geo.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
  }
  return geo;
}
