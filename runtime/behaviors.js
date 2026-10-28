// キャラの動き。各関数は毎フレーム呼ばれ、正規化ボーンを直接いじる（毎フレーム初期姿勢から組み直す）。
// 引数: (vrm, m = musicAt() の結果, opts = シーンで指定したパラメータ, state = 振る舞いごとの永続データ)
//
// なめらかに見せるための決まり:
// - 拍の境目で値が飛ばないようにする（sin/cos で拍をまたいで続く曲線か、境目で 0 になる曲線を使う）
// - 拍の頭の「キメ」は env()（短く立ち上がって、ゆっくり戻る）を使う。beatPulse は拍の頭で 0→1 に跳ぶので直接は使わない
// - 仕上げに character.smoothing で全ボーンを少し遅らせて追従させる（player.js）

import { applyMixamo } from './mixamo.js';

const bone = (vrm, name) => vrm.humanoid.getNormalizedBoneNode(name);
const add = (node, x = 0, y = 0, z = 0) => { if (node) { node.rotation.x += x; node.rotation.y += y; node.rotation.z += z; } };
const PI = Math.PI;
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
// 拍の中の位置 p（0→1）に対して、attack で 0→1 に上がり、そのあと 1→0 へ戻る（端は両方 0 なので拍をまたいでも飛ばない）
const env = (p, attack = 0.12) => (p < attack ? smooth(p / attack) : Math.pow(1 - smooth((p - attack) / (1 - attack)), 1.6));

// 決定的な疑似乱数（同じ入力なら必ず同じ値）
export function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

// only / except で選んだ区間が続くまとまりの、始まりの時刻（どれも選ばれていなければ 0）
function runStart(sections, i, o) {
  if (!sections || (!o.only && !o.except)) return 0;
  const on = s => !!s && (o.only ? o.only.includes(s.name) : !o.except.includes(s.name));
  let j = Math.max(0, i);
  while (j > 0 && on(sections[j - 1])) j--;
  return sections[j]?.from ?? 0;
}

export const behaviors = {
  // 腕を下ろした立ち姿勢と呼吸
  idle(vrm, m, o) {
    const down = o.armDown ?? 1.4;
    add(bone(vrm, 'leftUpperArm'), 0, 0, -down);
    add(bone(vrm, 'rightUpperArm'), 0, 0, down);
    add(bone(vrm, 'leftLowerArm'), 0, -0.25, 0);
    add(bone(vrm, 'rightLowerArm'), 0, 0.25, 0);
    add(bone(vrm, 'chest'), Math.sin(m.t * 2.2) * 0.015, 0, 0);
  },

  // 拍ごとに膝を曲げて沈む
  bounce(vrm, m, o) {
    const depth = (o.amount ?? 0.03) * m.energy * (0.5 + 0.5 * Math.cos(2 * PI * m.beatPhase));
    const hips = bone(vrm, 'hips');
    if (hips) hips.position.y -= depth;
    const bend = Math.acos(Math.max(0.5, 1 - depth / 0.4));
    for (const s of ['left', 'right']) {
      add(bone(vrm, `${s}UpperLeg`), -bend, 0, 0);
      add(bone(vrm, `${s}LowerLeg`), bend * 2, 0, 0);
      add(bone(vrm, `${s}Foot`), -bend, 0, 0);
    }
  },

  // 拍の頭でうなずく
  headNod(vrm, m, o) {
    const a = (o.amount ?? 0.12) * m.energy * env(m.beatPhase, 0.15);
    add(bone(vrm, 'head'), a, 0, 0);
    add(bone(vrm, 'neck'), a * 0.4, 0, 0);
  },

  // 2拍で左右に揺れる
  sway(vrm, m, o) {
    const s = Math.sin(PI * m.beatPos) * (o.amount ?? 0.08) * m.energy;
    add(bone(vrm, 'spine'), 0, s * 0.5, s);
    add(bone(vrm, 'head'), 0, 0, -s * 0.6);
  },

  // 歩くように腕を前後に振る（左右逆向き、肘は少し遅れて曲がる）。energy が liftFrom を超えると腕が横に上がる
  armSwing(vrm, m, o) {
    const amt = (o.amount ?? 0.5) * m.energy;
    const ph = PI * m.beatPos, s = Math.sin(ph), lag = Math.sin(ph - 0.6);
    const lift = smooth((m.energy - (o.liftFrom ?? 1)) / 0.4) * (o.lift ?? 0.8);
    add(bone(vrm, 'leftUpperArm'), -s * amt, 0, lift + Math.abs(s) * amt * 0.15);
    add(bone(vrm, 'rightUpperArm'), s * amt, 0, -lift - Math.abs(s) * amt * 0.15);
    add(bone(vrm, 'leftLowerArm'), 0, -(0.5 + 0.5 * lag) * amt * 0.7, 0);
    add(bone(vrm, 'rightLowerArm'), 0, (0.5 - 0.5 * lag) * amt * 0.7, 0);
    add(bone(vrm, 'chest'), 0, s * amt * 0.12, 0);
  },

  // 拍ごとに左右へ体重を移す（腰が横に動き、体重の乗っていない足が少し上がる）
  stepSide(vrm, m, o) {
    const amt = (o.amount ?? 0.05) * m.energy;
    const w = Math.cos(PI * m.beatPos); // 拍の頭で ±1、拍をまたいで連続
    const hips = bone(vrm, 'hips');
    if (hips) hips.position.x += w * amt;
    add(hips, 0, 0, -w * amt * 1.2);
    const free = m.beatIndex % 2 ? 'right' : 'left', k = Math.sin(PI * m.beatPhase) ** 2;
    add(bone(vrm, `${free}UpperLeg`), -k * amt * 4, 0, 0);
    add(bone(vrm, `${free}LowerLeg`), k * amt * 7, 0, 0);
  },

  // 1小節かけて体ごと左右に向きを変える
  turn(vrm, m, o) {
    const a = Math.sin(PI * m.barPos * (o.speed ?? 0.5)) * (o.amount ?? 0.35) * Math.min(1, m.energy);
    add(bone(vrm, 'hips'), 0, a, 0);
    add(bone(vrm, 'head'), 0, -a * 0.5, 0);
  },

  // 拍の頭で片腕ずつ突き上げる（サビ向け）。上げた腕は次の拍までにゆっくり下りる
  pump(vrm, m, o) {
    const up = (o.amount ?? 1.2) * Math.min(1.5, m.energy);
    const e = env(m.beatPhase, 0.14);
    const side = m.beatIndex % 2 ? 'left' : 'right', sign = side === 'left' ? 1 : -1;
    add(bone(vrm, `${side}UpperArm`), -e * up * 0.2, 0, sign * e * up * 1.7);
    add(bone(vrm, `${side}LowerArm`), 0, -sign * e * up * 0.45, 0);
    add(bone(vrm, 'chest'), -e * 0.05 * m.energy, 0, sign * e * 0.05 * m.energy);
    add(bone(vrm, 'head'), -e * 0.06 * m.energy, 0, 0);
  },

  // 跳ぶ。every 拍ごと（既定 4 = 小節の頭）に、拍 1 つぶん放物線で浮く。しゃがんでから跳び、着地で沈む
  jump(vrm, m, o) {
    const every = o.every ?? 4, len = o.length ?? 1;
    const pos = m.beatPos - (o.offset ?? 0), k = Math.floor(pos / every), p = (pos - k * every) / len;
    if (p < -0.25 || p > 1.3) return;
    const h = (o.height ?? 0.18) * Math.min(1.3, m.energy);
    const air = p > 0 && p < 1 ? 4 * p * (1 - p) : 0;                                    // 空中の高さ 0→1→0
    const crouch = p < 0 ? smooth((p + 0.25) / 0.25) : p > 1 ? 1 - smooth((p - 1) / 0.3) : 0; // 踏み切り前と着地のしゃがみ
    const tuck = p > 0 && p < 1 ? Math.sin(PI * p) : 0;
    const hips = bone(vrm, 'hips');
    if (hips) hips.position.y += air * h - crouch * h * 0.35;
    for (const s of ['left', 'right']) {
      const bend = crouch * 0.5 + tuck * 0.35;
      add(bone(vrm, `${s}UpperLeg`), -bend, 0, 0);
      add(bone(vrm, `${s}LowerLeg`), bend * 1.8, 0, 0);
      add(bone(vrm, `${s}Foot`), -bend * 0.6, 0, 0);
    }
    // 腕は空中で上へ
    add(bone(vrm, 'leftUpperArm'), 0, 0, tuck * 0.9 * (o.arms ?? 1));
    add(bone(vrm, 'rightUpperArm'), 0, 0, -tuck * 0.9 * (o.arms ?? 1));
  },

  // 首かしげ。every 拍ごとに左右どちらかへ傾けて、しばらく止める
  headTilt(vrm, m, o) {
    const every = o.every ?? 8, k = Math.floor(m.beatPos / every), p = m.beatPos / every - k;
    const dir = hash(k + 3) < 0.5 ? -1 : 1;
    const a = (o.amount ?? 0.28) * smooth(p / 0.15) * (1 - smooth((p - 0.75) / 0.25)) * dir;
    add(bone(vrm, 'head'), 0, a * 0.3, a);
    add(bone(vrm, 'neck'), 0, 0, a * 0.3);
  },

  // 片手を顔の横まで上げて振る（side: "right" / "left"）
  wave(vrm, m, o) {
    const side = o.side ?? 'right', sign = side === 'left' ? 1 : -1, w = Math.min(1, m.energy * 1.5);
    const s = Math.sin(PI * m.beatPos * (o.speed ?? 2));
    add(bone(vrm, `${side}UpperArm`), -0.2 * w, 0, sign * 1.9 * w);
    add(bone(vrm, `${side}LowerArm`), 0, -sign * (1.3 + 0.1 * s) * w, sign * s * 0.45 * w);
    add(bone(vrm, `${side}Hand`), 0, 0, sign * s * 0.25 * w);
    add(bone(vrm, 'head'), 0, 0, sign * 0.08 * w);
  },

  // 胸の前で手拍子（beats: 小節の何拍目で叩くか。0 始まりで既定は 1 と 3 = 2拍目と4拍目）
  clap(vrm, m, o) {
    const w = Math.min(1, m.energy), beats = o.beats ?? [1, 3];
    const inBar = ((m.beatIndex % 4) + 4) % 4;
    // 叩く拍に向けて閉じ、叩いたら開く
    const hit = beats.includes(inBar), next = beats.includes((inBar + 1) % 4);
    const close = hit ? 1 - smooth(m.beatPhase / 0.45) : next ? smooth((m.beatPhase - 0.55) / 0.45) : 0;
    const inward = (o.width ?? 0.62) * (0.45 + 0.55 * close);
    for (const [s, sign] of [['left', 1], ['right', -1]]) {
      add(bone(vrm, `${s}UpperArm`), -1.05 * w, -sign * inward * w, 0);
      add(bone(vrm, `${s}LowerArm`), 0, -sign * 0.35 * w, 0);
      add(bone(vrm, `${s}Hand`), 0, 0, -sign * 0.3 * w);
    }
  },

  // サビ用の大きな振り付け。拍ごとにポーズを切り替え、間はなめらかにつなぐ
  // poses: 使うポーズ名の並び（1拍に1つ）。用意してあるのは up / v / cross / point / wide / down
  choreo(vrm, m, o) {
    const seq = o.poses ?? ['v', 'v', 'cross', 'wide', 'point', 'point', 'up', 'down'];
    const per = o.beatsPerPose ?? 1, w = Math.min(1.2, m.energy) * (o.amount ?? 1);
    const pos = m.beatPos / per, i = Math.floor(pos), f = smooth(Math.min(1, (pos - i) / (o.blend ?? 0.45)));
    const a = CHOREO[seq[((i - 1) % seq.length + seq.length) % seq.length]], b = CHOREO[seq[(i % seq.length + seq.length) % seq.length]];
    for (const name of Object.keys({ ...a, ...b })) {
      const pa = a[name] ?? [0, 0, 0], pb = b[name] ?? [0, 0, 0];
      add(bone(vrm, name), ...pa.map((v, k) => (v + (pb[k] - v) * f) * w));
    }
  },

  // Mixamo の FBX の動き（file）。既定では、動きの中の拍（読み込み時に調べた、手足が止まる瞬間や足の着地）を
  // 曲の拍に重ね、動きの「4拍のまとまりの頭」を曲の小節頭に合わせて再生する。速さは動きの拍1つ＝曲の 1/2・1・2 拍のうち近いものに伸び縮み
  // motionBeat: 動きの拍1つを曲の何拍にするか（0.5 / 1 / 2 など、省略時は自動） / offset: 曲の何拍ぶん後ろへずらすか
  // sync: "stretch"（beats 拍に1ループを伸び縮みするだけ）/ "time"（元の速さ、speed 倍）
  // weight: 今の姿勢と混ぜる割合 / inPlace: 腰の移動を止める / faceFront: 正面を向いたまま / hips: false で腰の位置を使わない
  // mask: ["head", ...] で当てるボーンを絞る。下に書いたモーションはこの上に足される
  mixamo(vrm, m, o, state) {
    const clip = state.clip, info = state.info;
    if (!clip) return;
    // ループする区間（Motion Meta の loop。なければ全体）
    const [lin, lout] = state.loopRange ?? [0, clip.duration];
    const dur = lout - lin;
    const sync = o.sync ?? state.sync;
    let time;
    if (sync === 'time') time = (m.t - (o.start ?? 0)) * (o.speed ?? 1);
    else if (sync === 'stretch' || !info) {
      const beats = o.beats ?? Math.max(1, Math.round(dur / m.beatPeriod));
      time = lin + ((m.steadyBeat - (o.offset ?? 0)) / beats) * dur;
    } else {
      const ks = state.halfDouble === false ? [1] : [0.5, 1, 2];
      const k = o.motionBeat ?? ks.reduce((best, c) => (Math.abs(Math.log(m.beatPeriod * c / info.period)) < Math.abs(Math.log(m.beatPeriod * best / info.period)) ? c : best), 1);
      state.lastK = k;
      const songBeats = m.steadyBeat - (state.barOffset ?? 0) - (o.offset ?? 0);
      time = info.barPhase + (songBeats / k) * info.period;
    }
    const loop = o.loop ?? state.loop ?? true;
    if (loop === false && sync !== 'time') {
      // 1回だけ再生する動きは、出番（only / except で選んだ区間が続くまとまり）の頭から数える。出番の頭に動きの小節頭が来る
      const songBeats = (m.t - (o.start ?? runStart(state.sections, m.sectionIndex, o))) / m.beatPeriod - (o.offset ?? 0);
      time = info && sync !== 'stretch' ? info.barPhase + (songBeats / (o.motionBeat ?? state.lastK ?? 1)) * info.period : lin + songBeats * m.beatPeriod;
    }
    time = loop === false ? Math.min(Math.max(0, time), clip.duration) : lin + ((((time - lin) % dur) + dur) % dur);
    applyMixamo(clip, time, (o.weight ?? 1) * (m.weight ?? 1), o);
  },

  // VRMA などライブラリの動き。{ "use": "clip", "motion": "<id>" }（open-vrma の一覧から引く）か { "use": "clip", "file": "x.vrma" }
  // 再生のしかた・パラメータは mixamo と同じ。隣の .motion.json があれば、拍・小節頭・ループ区間・伸び縮みの可否をそこから取る
  clip(vrm, m, o, state) { behaviors.mixamo(vrm, m, o, state); },

  // ランダムっぽいが決定的なまばたき（表情の blink は他の表情より後に上書き）
  blink(vrm, m, o) {
    const interval = o.interval ?? 3.5, k = Math.floor(m.t / interval);
    const at = k * interval + hash(k) * (interval - 0.3), d = (m.t - at) / 0.16;
    const v = d >= 0 && d <= 1 ? 1 - Math.abs(d * 2 - 1) : 0;
    const em = vrm.expressionManager;
    if (em?.getExpression('blink')) em.setValue('blink', Math.max(em.getValue('blink') ?? 0, v * (1 - (m.expression.happy ?? 0) * 0.7)));
  },

  // 音量で口を開ける（歌っている風）
  mouth(vrm, m, o) {
    const em = vrm.expressionManager;
    if (em?.getExpression('aa')) em.setValue('aa', Math.min(1, m.loudness * (o.amount ?? 0.6) * m.energy));
  },
};

// choreo のポーズ（idle で腕を下ろした姿勢に足す回転 [x, y, z]）。左腕は +z で上がる、右腕は -z
const CHOREO = {
  up:    { leftUpperArm: [0, 0, 2.5], rightUpperArm: [0, 0, -2.5], leftLowerArm: [0, -0.2, 0], rightLowerArm: [0, 0.2, 0], head: [-0.15, 0, 0] },
  v:     { leftUpperArm: [-0.2, 0, 2.0], rightUpperArm: [-0.2, 0, -2.0], chest: [-0.06, 0, 0], head: [-0.1, 0, 0] },
  cross: { leftUpperArm: [-1.1, -0.6, 0.9], rightUpperArm: [-1.1, 0.6, -0.9], leftLowerArm: [0, -1.0, 0], rightLowerArm: [0, 1.0, 0], chest: [0.08, 0, 0], head: [0.1, 0, 0] },
  wide:  { leftUpperArm: [0, 0, 1.25], rightUpperArm: [0, 0, -1.25], hips: [0, 0, 0], chest: [-0.05, 0, 0] },
  point: { rightUpperArm: [-0.6, 0, -2.0], rightLowerArm: [0, 0.1, 0], leftUpperArm: [0, 0, 0.3], leftLowerArm: [0, -1.2, 0], chest: [0, -0.25, 0.08], head: [0, -0.2, 0.1] },
  down:  { leftUpperArm: [0.3, 0, 0.35], rightUpperArm: [0.3, 0, -0.35], chest: [0.15, 0, 0], head: [0.2, 0, 0] },
};
