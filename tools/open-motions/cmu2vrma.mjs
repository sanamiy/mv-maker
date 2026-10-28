// CMU BVH (cgspeed 2010版、1コマ目が Tポーズ) → VRMA + 解析値
// node cmu2vrma.mjs in.bvh out.vrma out.json
import fs from 'node:fs';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { writeVRMA, continuous, PARENT, THREE } from './vrma.mjs';
import { analyze } from './analyze.mjs';

const [,, inFile, outVrma, outJson, fpsS = '30'] = process.argv;
const UNIT = 0.0254 / 0.45; // CMU の ASF 単位 → m
const MAP = { hips: 'Hips', spine: 'LowerBack', chest: 'Spine', upperChest: 'Spine1', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase' };

const { skeleton, clip } = new BVHLoader().parse(fs.readFileSync(inFile, 'utf8'));
const src = Object.fromEntries(skeleton.bones.map(b => [b.name, b]));
const root = skeleton.bones[0];
const names = Object.keys(MAP).filter(n => src[MAP[n]]);
const interps = clip.tracks.map(t => { const [bn, prop] = t.name.split('.'); return { bone: src[bn], prop, it: t.createInterpolant() }; });
const pose = t => { for (const { bone, prop, it } of interps) { const v = it.evaluate(t); if (prop === 'quaternion') bone.quaternion.fromArray(v); else bone.position.fromArray(v); } root.updateMatrixWorld(true); };
const wq = n => src[MAP[n]].getWorldQuaternion(new THREE.Quaternion());
const wp = n => src[MAP[n]].getWorldPosition(new THREE.Vector3()).multiplyScalar(UNIT);
const endSite = n => { const b = src[MAP[n]]; const c = b.children[0]; return c ? c.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNIT) : wp(n); };

pose(0);
const restInv = Object.fromEntries(names.map(n => [n, wq(n).invert()]));
const restPos = Object.fromEntries(names.map(n => [n, wp(n)]));
const floor0 = Math.min(endSite('leftToes').y, endSite('rightToes').y);
const center = restPos.hips.clone(); center.y = floor0;
for (const n of names) restPos[n].sub(center);

const srcFrames = clip.tracks[0].times.length;
const dt = clip.duration / (srcFrames - 1);
const fps = +fpsS, start = dt, end = clip.duration;
const frameCount = Math.floor((end - start) * fps + 1e-6) + 1;
const rot = Object.fromEntries(names.map(n => [n, new Float32Array(frameCount * 4)]));
const hipsPos = new Float32Array(frameCount * 3);
const track = { hips: [], head: [], leftHand: [], rightHand: [], leftFoot: [], rightFoot: [], leftToe: [], rightToe: [], leftUpperArm: [], rightUpperArm: [] };
for (let i = 0; i < frameCount; i++) {
  pose(start + i / fps);
  const delta = Object.fromEntries(names.map(n => [n, wq(n).multiply(restInv[n])]));
  for (const n of names) {
    let p = PARENT[n]; while (p && !delta[p]) p = PARENT[p];
    const q = p ? delta[p].clone().invert().multiply(delta[n]) : delta[n];
    q.toArray(rot[n], i * 4);
  }
  wp('hips').sub(center).toArray(hipsPos, i * 3);
  for (const k of ['hips', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm']) track[k].push(wp(k).sub(center).toArray());
  track.leftToe.push(endSite('leftToes').sub(center).toArray());
  track.rightToe.push(endSite('rightToes').sub(center).toArray());
}
for (const n of names) continuous(rot[n]);
// 床: 全体の足先の最下点付近を 0 に
const toeYs = [...track.leftToe, ...track.rightToe].map(p => p[1]).sort((a, b) => a - b);
const floor = toeYs[Math.floor(toeYs.length * 0.02)];
for (let i = 0; i < frameCount; i++) hipsPos[i * 3 + 1] -= floor;
for (const k in track) for (const p of track[k]) p[1] -= floor;

const id = inFile.split('/').pop().replace(/\.bvh$/i, '');
fs.writeFileSync(outVrma, writeVRMA({ bones: names, restPos, fps, frameCount, rot, hipsPos, name: id }));
const metrics = analyze({ fps, frameCount, rot, bones: names, track, hipRest: restPos.hips.y });
fs.writeFileSync(outJson, JSON.stringify({ id, fps, frames: frameCount, duration: +((frameCount - 1) / fps).toFixed(2), ...metrics }, null, 1));
console.error(id, frameCount, 'frames', metrics);
