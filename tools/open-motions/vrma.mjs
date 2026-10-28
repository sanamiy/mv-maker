// VRM 正規化ボーン（レストは全ボーン回転なしの Tポーズ）での回転列を VRMA (glTF + VRMC_vrm_animation) に書き出す
import * as THREE from 'three';

export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
};
// 指: 親指は Metacarpal→Proximal→Distal、ほかは Proximal→Intermediate→Distal
for (const side of ['left', 'right']) {
  PARENT[`${side}ThumbMetacarpal`] = `${side}Hand`; PARENT[`${side}ThumbProximal`] = `${side}ThumbMetacarpal`; PARENT[`${side}ThumbDistal`] = `${side}ThumbProximal`;
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    PARENT[`${side}${f}Proximal`] = `${side}Hand`; PARENT[`${side}${f}Intermediate`] = `${side}${f}Proximal`; PARENT[`${side}${f}Distal`] = `${side}${f}Intermediate`;
  }
}

// restPos: { bone: Vector3 ワールド位置(m) }  rot: { bone: Float32Array(frames*4) ローカル回転 }  hipsPos: Float32Array(frames*3)
export function writeVRMA({ bones, restPos, fps, frameCount, rot, hipsPos, name = 'motion', generator = 'mv-maker open-motions' }) {
  const parentOf = b => { let p = PARENT[b]; while (p && !bones.includes(p)) p = PARENT[p]; return p; };
  const nodes = bones.map(b => {
    const p = parentOf(b);
    const t = p ? restPos[b].clone().sub(restPos[p]) : restPos[b].clone();
    return { name: b, translation: t.toArray().map(v => +v.toFixed(5)) };
  });
  bones.forEach((b, i) => { const kids = bones.map((c, j) => parentOf(c) === b ? j : -1).filter(j => j >= 0); if (kids.length) nodes[i].children = kids; });

  const chunks = []; let offset = 0;
  const bufferViews = [], accessors = [];
  const add = (arr, type, minmax) => {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    chunks.push(buf, Buffer.alloc(pad)); offset += buf.length + pad;
    const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: arr.length / comps, type };
    if (minmax) Object.assign(acc, minmax);
    accessors.push(acc); return accessors.length - 1;
  };
  const times = new Float32Array(frameCount).map((_, i) => i / fps);
  const tAcc = add(times, 'SCALAR', { min: [0], max: [times[frameCount - 1]] });
  const samplers = [], channels = [];
  bones.forEach((b, i) => {
    samplers.push({ input: tAcc, output: add(rot[b], 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: i, path: 'rotation' } });
  });
  samplers.push({ input: tAcc, output: add(hipsPos, 'VEC3'), interpolation: 'LINEAR' });
  channels.push({ sampler: samplers.length - 1, target: { node: bones.indexOf('hips'), path: 'translation' } });

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(bones.map((b, i) => [b, { node: i }])) } } },
    scene: 0, scenes: [{ nodes: [bones.indexOf('hips')] }],
    nodes, animations: [{ name, channels, samplers }],
    buffers: [{ byteLength: bin.length }], bufferViews, accessors,
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
}

// 前フレームと同じ半球にそろえて補間の飛びを防ぐ
export function continuous(arr) {
  for (let i = 4; i < arr.length; i += 4) {
    const d = arr[i] * arr[i - 4] + arr[i + 1] * arr[i - 3] + arr[i + 2] * arr[i - 2] + arr[i + 3] * arr[i - 1];
    if (d < 0) for (let k = 0; k < 4; k++) arr[i + k] = -arr[i + k];
  }
  return arr;
}
export { THREE };
