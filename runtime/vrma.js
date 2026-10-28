// VRM Animation（.vrma）を読み、loadMixamo と同じ形（{ duration, tracks, name }）にする。
// 返り値は applyMixamo / analyzeMotion にそのまま渡せる（behaviors の拍合わせ・inPlace・mask などが同じように効く）。
// VRMA は VRM の正規化ボーン（初期姿勢が単位回転）の回転をそのまま持つので、回転は差分にせずに入れる。
// 腰の位置は VRMA の初期姿勢の腰の高さと VRM の腰の高さの比で縮める（three-vrm-animation の createVRMAnimationClip と同じ）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

export async function loadVrma(url, vrm) {
  const loader = new GLTFLoader();
  loader.register(p => new VRMAnimationLoaderPlugin(p));
  const gltf = await loader.loadAsync(url);
  const anim = gltf.userData.vrmAnimations?.[0];
  if (!anim) throw new Error(`no VRM animation in ${url}`);
  const vrm0 = vrm.meta?.metaVersion === '0';
  const tracks = [];
  for (const [boneName, track] of anim.humanoidTracks.rotation) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) continue;
    const values = vrm0 ? track.values.map((v, i) => (i % 2 === 0 ? -v : v)) : track.values;
    tracks.push({ node, boneName, kind: 'q', interp: new THREE.QuaternionKeyframeTrack('q', track.times, values).createInterpolant() });
  }
  for (const [boneName, track] of anim.humanoidTracks.translation) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node || boneName !== 'hips') continue;
    const restY = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? node.position.y;
    const scale = restY / (anim.restHipsPosition?.y || restY || 1);
    const values = track.values.map((v, i) => (vrm0 && i % 3 !== 1 ? -v : v) * scale);
    // 動きの基準（ここからの差分を足す）: 前後左右は1フレーム目の位置、高さは VRM の初期姿勢の腰の高さ
    tracks.push({ node, boneName, kind: 'p', interp: new THREE.VectorKeyframeTrack('p', track.times, values).createInterpolant(), rest: [values[0], restY, values[2]] });
  }
  return { duration: anim.duration, tracks, name: decodeURIComponent(url.split('/').pop()) };
}

// Motion Meta（.motion.json）から、behaviors.mixamo が使う拍の情報（analyzeMotion と同じ形）を作る。拍の無い動きは null
export function infoFromMeta(meta, duration) {
  const t = meta?.tempo;
  if (!t?.bpm) return null;
  const period = 60 / t.bpm, perBar = t.beatsPerBar ?? 4;
  const firstBeat = t.firstBeat ?? 0;
  // 小節頭: firstBeat が小節の firstBarBeat 拍目なので、そこから (perBar − firstBarBeat + 1) % perBar 拍後
  const barPhase = firstBeat + (((perBar - (t.firstBarBeat ?? 1) + 1) % perBar) * period);
  const loopLen = meta.loop ? meta.loop.out - meta.loop.in : duration;
  return { period, phase: firstBeat, barPhase: barPhase % duration, beats: meta.loop?.beats ?? Math.max(1, Math.round(loopLen / period)), bpm: t.bpm, beatClarity: t.confidence ?? null, alternatives: t.alternatives ?? [], fromMeta: true };
}
