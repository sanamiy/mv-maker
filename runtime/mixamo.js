// Mixamo の FBX（アニメーション）を VRM の正規化ボーン用に変換し、時刻を指定して姿勢を取り出せるようにする。
// 変換のしかたは three-vrm 公式サンプル（loadMixamoAnimation）と同じ:
//   各ボーンの回転を「Mixamo の初期姿勢からの差分」にして、VRM の正規化ボーン（初期姿勢が単位回転）にそのまま入れる。
//   腰の位置は脚の長さの比で縮める。
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Mixamo のボーン名 → VRM のボーン名
export const MIXAMO_TO_VRM = {
  mixamorigHips: 'hips', mixamorigSpine: 'spine', mixamorigSpine1: 'chest', mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck', mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder', mixamorigLeftArm: 'leftUpperArm', mixamorigLeftForeArm: 'leftLowerArm', mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal', mixamorigLeftHandThumb2: 'leftThumbProximal', mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal', mixamorigLeftHandIndex2: 'leftIndexIntermediate', mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal', mixamorigLeftHandMiddle2: 'leftMiddleIntermediate', mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal', mixamorigLeftHandRing2: 'leftRingIntermediate', mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal', mixamorigLeftHandPinky2: 'leftLittleIntermediate', mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder', mixamorigRightArm: 'rightUpperArm', mixamorigRightForeArm: 'rightLowerArm', mixamorigRightHand: 'rightHand',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal', mixamorigRightHandThumb2: 'rightThumbProximal', mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal', mixamorigRightHandIndex2: 'rightIndexIntermediate', mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal', mixamorigRightHandMiddle2: 'rightMiddleIntermediate', mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandRing1: 'rightRingProximal', mixamorigRightHandRing2: 'rightRingIntermediate', mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandPinky1: 'rightLittleProximal', mixamorigRightHandPinky2: 'rightLittleIntermediate', mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg', mixamorigLeftLeg: 'leftLowerLeg', mixamorigLeftFoot: 'leftFoot', mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg', mixamorigRightLeg: 'rightLowerLeg', mixamorigRightFoot: 'rightFoot', mixamorigRightToeBase: 'rightToes',
};

// url の FBX を読み、vrm 用のトラックに変換する。返り値の sample(time) で各ボーンの回転（と腰の位置）が取れる
export async function loadMixamo(url, vrm) {
  const asset = await new FBXLoader().loadAsync(url);
  const clip = asset.animations.find(c => c.name === 'mixamo.com') ?? asset.animations[0];
  if (!clip) throw new Error(`no animation in ${url}`);
  asset.updateMatrixWorld(true);
  // ボーン名の前に "mixamorig:" や "mixamorig1:" が付く書き出しもあるので揃える
  const key = name => name.replace(/^mixamorig\d*:?/, 'mixamorig');
  const nodes = {};
  asset.traverse(o => { nodes[key(o.name)] = o; });

  const v = new THREE.Vector3();
  const motionHips = nodes.mixamorigHips;
  // 腰の高さ: 普通は FBX の初期姿勢の位置。0 になっている書き出しでは、1フレーム目の腰の高さを使う
  const hipsTrack = clip.tracks.find(t => key(t.name.split('.')[0]) === 'mixamorigHips' && t.name.endsWith('.position'));
  const first = hipsTrack ? [hipsTrack.values[0], hipsTrack.values[1], hipsTrack.values[2]] : [0, 0, 0];
  const hipsHeight = Math.abs(motionHips?.position.y) > 1e-3 ? Math.abs(motionHips.position.y) : Math.abs(first[1]) || 1;
  const vrmHips = vrm.humanoid.getNormalizedBoneNode('hips');
  const vrmHipsY = vrmHips.getWorldPosition(v).y - vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const scale = vrmHipsY / hipsHeight;
  const vrm0 = vrm.meta?.metaVersion === '0';

  const restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion(), q = new THREE.Quaternion();
  const tracks = [];
  for (const track of clip.tracks) {
    const [rawName, prop] = track.name.split('.');
    const rig = key(rawName), boneName = MIXAMO_TO_VRM[rig], node = boneName && vrm.humanoid.getNormalizedBoneNode(boneName), src = nodes[rig];
    if (!node || !src) continue;
    if (prop === 'quaternion') {
      src.getWorldQuaternion(restInv).invert();
      src.parent.getWorldQuaternion(parentRest);
      const values = Float32Array.from(track.values);
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i).premultiply(parentRest).multiply(restInv).toArray(values, i);
        if (vrm0) { values[i] = -values[i]; values[i + 2] = -values[i + 2]; }
      }
      tracks.push({ node, boneName, kind: 'q', interp: new THREE.QuaternionKeyframeTrack('q', track.times, values).createInterpolant() });
    } else if (prop === 'position' && boneName === 'hips') {
      const values = Float32Array.from(track.values, (x, i) => (vrm0 && i % 3 !== 1 ? -x : x) * scale);
      // 動きの基準（ここからの差分を足す）: 前後左右は1フレーム目の位置、高さは初期姿勢の腰の高さ
      const rest = [first[0], hipsHeight * Math.sign(first[1] || 1), first[2]].map((x, i) => (vrm0 && i !== 1 ? -x : x) * scale);
      tracks.push({ node, boneName, kind: 'p', interp: new THREE.VectorKeyframeTrack('p', track.times, values).createInterpolant(), rest });
    }
  }
  return { duration: clip.duration, tracks, name: url.split('/').pop() };
}

const _q = new THREE.Quaternion(), _t = new THREE.Quaternion(), _p = new THREE.Vector3();

// clip を時刻 time（秒）の姿勢で vrm に当てる。weight で今の姿勢と混ぜる（1 で置き換え）。
// opts.inPlace: 腰の前後左右の移動を止める / opts.faceFront: 体の向きを正面に固定 / opts.hips: false で腰の位置を動かさない / opts.mask: 当てるボーン名だけに絞る
export function applyMixamo(clip, time, weight, opts = {}) {
  for (const tr of clip.tracks) {
    if (opts.mask && !opts.mask.includes(tr.boneName)) continue;
    const r = tr.interp.evaluate(time);
    if (tr.kind === 'q') {
      _q.fromArray(r);
      // faceFront: 腰の向き（上下の軸まわりの回転）を消して、いつも正面を向かせる
      if (opts.faceFront && tr.boneName === 'hips') { _t.set(0, _q.y, 0, _q.w).normalize(); _q.premultiply(_t.invert()); }
      tr.node.quaternion.slerp(_q, weight);
    } else if (opts.hips !== false) {
      // 初期姿勢の腰の位置からの差分として足す（VRM の脚の長さに合わせて縮めてある）
      _p.set(opts.inPlace ? 0 : r[0] - tr.rest[0], r[1] - tr.rest[1], opts.inPlace ? 0 : r[2] - tr.rest[2]);
      tr.node.position.addScaledVector(_p, weight);
    }
  }
}
