// Quaternius Universal Animation Library (GLB) → 動きごとの VRMA + 解析値（A_TPose をレストの Tポーズとして使う）
// node quaternius2vrma.mjs in.glb ual1|ual2 outDir
import fs from 'node:fs';
import path from 'node:path';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { writeVRMA, continuous, PARENT, THREE } from './vrma.mjs';
import { analyze } from './analyze.mjs';

const [,, inFile, rig, outDir, fpsS = '30'] = process.argv;
const fingers = (fmt) => {
  const m = {};
  for (const [side, s] of [['left', 0], ['right', 1]]) {
    m[`${side}ThumbMetacarpal`] = fmt('thumb', 1, s); m[`${side}ThumbProximal`] = fmt('thumb', 2, s); m[`${side}ThumbDistal`] = fmt('thumb', 3, s);
    for (const [f, n] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'pinky']]) {
      m[`${side}${f}Proximal`] = fmt(n, 1, s); m[`${side}${f}Intermediate`] = fmt(n, 2, s); m[`${side}${f}Distal`] = fmt(n, 3, s);
    }
  }
  return m;
};
const RIGS = {
  ual1: { hips: 'DEF-hips', spine: 'DEF-spine001', chest: 'DEF-spine002', upperChest: 'DEF-spine003', neck: 'DEF-neck', head: 'DEF-head',
    leftShoulder: 'DEF-shoulderL', leftUpperArm: 'DEF-upper_armL', leftLowerArm: 'DEF-forearmL', leftHand: 'DEF-handL',
    rightShoulder: 'DEF-shoulderR', rightUpperArm: 'DEF-upper_armR', rightLowerArm: 'DEF-forearmR', rightHand: 'DEF-handR',
    leftUpperLeg: 'DEF-thighL', leftLowerLeg: 'DEF-shinL', leftFoot: 'DEF-footL', leftToes: 'DEF-toeL',
    rightUpperLeg: 'DEF-thighR', rightLowerLeg: 'DEF-shinR', rightFoot: 'DEF-footR', rightToes: 'DEF-toeR',
    ...fingers((n, i, s) => `DEF-${n === 'thumb' ? 'thumb' : 'f_' + n}0${i}${s ? 'R' : 'L'}`) },
  ual2: { hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'Head',
    leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
    rightShoulder: 'clavicle_r', rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
    leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l', leftToes: 'ball_l',
    rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r', rightToes: 'ball_r',
    ...fingers((n, i, s) => `${n}_0${i}_${s ? 'r' : 'l'}`) },
};
const MAP = RIGS[rig];
const buf = fs.readFileSync(inFile);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const scene = gltf.scene;
const byName = {}; scene.traverse(o => { if (o.isBone || o.type === 'Object3D') byName[o.name] = o; });
const names = Object.keys(MAP).filter(n => byName[MAP[n]]);
const miss = Object.keys(MAP).filter(n => !byName[MAP[n]]); if (miss.length) console.error('missing bones', miss.map(n => MAP[n]));
const mixer = new THREE.AnimationMixer(scene);
const at = (clip, t) => { mixer.stopAllAction(); const a = mixer.clipAction(clip); a.play(); mixer.setTime(t); scene.updateMatrixWorld(true); };
const wq = n => byName[MAP[n]].getWorldQuaternion(new THREE.Quaternion());
const wp = n => byName[MAP[n]].getWorldPosition(new THREE.Vector3());
const tip = n => { const b = byName[MAP[n]]; const c = b.children.find(c => c.isBone); return c ? c.getWorldPosition(new THREE.Vector3()) : b.getWorldPosition(new THREE.Vector3()); };

const tpose = gltf.animations.find(a => a.name === 'A_TPose');
at(tpose, 0);
const restInv = Object.fromEntries(names.map(n => [n, wq(n).invert()]));
const restPos = Object.fromEntries(names.map(n => [n, wp(n)]));
const floor0 = Math.min(tip('leftToes').y, tip('rightToes').y);
const center = restPos.hips.clone(); center.y = floor0;
for (const n of names) restPos[n].sub(center);
console.error(rig, 'T-pose arm dir', wp('leftHand').sub(wp('leftUpperArm')).normalize().toArray().map(v => v.toFixed(2)).join(','), 'hips', restPos.hips.y.toFixed(2));

fs.mkdirSync(outDir, { recursive: true });
const fps = +fpsS;
for (const clip of gltf.animations) {
  if (clip.name === 'A_TPose') continue;
  const frameCount = Math.max(2, Math.round(clip.duration * fps) + 1);
  const rot = Object.fromEntries(names.map(n => [n, new Float32Array(frameCount * 4)]));
  const hipsPos = new Float32Array(frameCount * 3);
  const track = { hips: [], head: [], leftHand: [], rightHand: [], leftFoot: [], rightFoot: [], leftToe: [], rightToe: [], leftUpperArm: [], rightUpperArm: [] };
  for (let i = 0; i < frameCount; i++) {
    at(clip, Math.min(clip.duration, i / fps));
    const delta = Object.fromEntries(names.map(n => [n, wq(n).multiply(restInv[n])]));
    for (const n of names) {
      let p = PARENT[n]; while (p && !delta[p]) p = PARENT[p];
      (p ? delta[p].clone().invert().multiply(delta[n]) : delta[n]).toArray(rot[n], i * 4);
    }
    wp('hips').sub(center).toArray(hipsPos, i * 3);
    for (const k of ['hips', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm']) track[k].push(wp(k).sub(center).toArray());
    track.leftToe.push(tip('leftToes').sub(center).toArray()); track.rightToe.push(tip('rightToes').sub(center).toArray());
  }
  for (const n of names) continuous(rot[n]);
  const id = `${rig}_${clip.name}`;
  fs.writeFileSync(path.join(outDir, id + '.vrma'), writeVRMA({ bones: names, restPos, fps, frameCount, rot, hipsPos, name: clip.name }));
  const metrics = analyze({ fps, frameCount, rot, bones: names, track, hipRest: restPos.hips.y });
  fs.writeFileSync(path.join(outDir, id + '.json'), JSON.stringify({ id, fps, frames: frameCount, duration: +((frameCount - 1) / fps).toFixed(2), ...metrics }, null, 1));
}
console.error(rig, gltf.animations.length - 1, 'clips');
