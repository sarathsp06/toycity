// The walking person: models/person.glb, made by tools/dress_person.py in Blender from the Xbot
// mannequin (clothes, hair, face) with Xbot's own idle / walk / run animations untouched.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadAvatar(base, { height = 1.78 } = {}) {
  const gltf = await new GLTFLoader().loadAsync(new URL('models/person.glb', base).href);
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  model.scale.multiplyScalar(height / (box.max.y - box.min.y));
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  const clips = {};
  for (const n of ['idle', 'walk', 'run']) clips[n] = gltf.animations.find(a => a.name === n);
  return { model, clips };
}
