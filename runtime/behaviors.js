// キャラの動き。各関数は毎フレーム呼ばれ、正規化ボーンを直接いじる（毎フレーム初期姿勢から組み直す）。
// 引数: (vrm, m = musicAt() の結果, opts = シーンで指定したパラメータ, state = 振る舞いごとの永続データ)

const bone = (vrm, name) => vrm.humanoid.getNormalizedBoneNode(name);
const add = (node, x = 0, y = 0, z = 0) => { if (node) { node.rotation.x += x; node.rotation.y += y; node.rotation.z += z; } };

// 決定的な疑似乱数（同じ入力なら必ず同じ値）
export function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

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
    const depth = (o.amount ?? 0.03) * m.energy * (0.5 + 0.5 * Math.cos(2 * Math.PI * m.beatPhase));
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
    const a = (o.amount ?? 0.12) * m.energy * m.beatPulse;
    add(bone(vrm, 'head'), a, 0, 0);
    add(bone(vrm, 'neck'), a * 0.4, 0, 0);
  },

  // 2拍で左右に揺れる
  sway(vrm, m, o) {
    const s = Math.sin(Math.PI * m.beatPos) * (o.amount ?? 0.08) * m.energy;
    add(bone(vrm, 'spine'), 0, s * 0.5, s);
    add(bone(vrm, 'head'), 0, 0, -s * 0.6);
  },

  // 拍ごとに左右交互に腕を振る。energy が高いほど大きく上がる
  armSwing(vrm, m, o) {
    const s = Math.sin(Math.PI * m.beatPos), amt = (o.amount ?? 0.5) * m.energy;
    const lift = Math.max(0, m.energy - (o.liftFrom ?? 1)) * (o.lift ?? 1.6);
    add(bone(vrm, 'leftUpperArm'), 0, 0, lift + Math.max(0, s) * amt);
    add(bone(vrm, 'rightUpperArm'), 0, 0, -lift - Math.max(0, -s) * amt);
    add(bone(vrm, 'leftLowerArm'), 0, -Math.max(0, s) * amt * 0.8, 0);
    add(bone(vrm, 'rightLowerArm'), 0, Math.max(0, -s) * amt * 0.8, 0);
  },

  // ランダムっぽいが決定的なまばたき（表情の blink は他の表情より後に上書き）
  blink(vrm, m, o) {
    const interval = o.interval ?? 3.5, k = Math.floor(m.t / interval);
    const at = k * interval + hash(k) * (interval - 0.3), d = (m.t - at) / 0.16;
    const v = d >= 0 && d <= 1 ? 1 - Math.abs(d * 2 - 1) : 0;
    const em = vrm.expressionManager;
    if (em?.getExpression('blink')) em.setValue('blink', Math.max(em.getValue('blink') ?? 0, v * (1 - (m.expression.happy ?? 0) * 0.7)));
  },

  // 拍ごとに左右へ体重を移す（腰が横に動き、反対の膝が曲がる）
  stepSide(vrm, m, o) {
    const side = m.beatIndex % 2 ? 1 : -1, k = Math.sin(Math.PI * m.beatPhase);
    const amt = (o.amount ?? 0.05) * m.energy;
    const hips = bone(vrm, 'hips');
    if (hips) hips.position.x += side * amt * (0.5 + 0.5 * Math.cos(Math.PI * m.beatPhase));
    add(hips, 0, 0, -side * amt * 1.2);
    const lift = side > 0 ? 'left' : 'right';
    add(bone(vrm, `${lift}UpperLeg`), -k * amt * 4, 0, 0);
    add(bone(vrm, `${lift}LowerLeg`), k * amt * 7, 0, 0);
  },

  // 1小節かけて体ごと左右に向きを変える
  turn(vrm, m, o) {
    const a = Math.sin(Math.PI * m.barPos * (o.speed ?? 0.5)) * (o.amount ?? 0.35) * Math.min(1, m.energy);
    add(bone(vrm, 'hips'), 0, a, 0);
    add(bone(vrm, 'head'), 0, -a * 0.5, 0);
  },

  // 拍の頭で片腕ずつ突き上げる（サビ向け）
  pump(vrm, m, o) {
    const side = m.beatIndex % 2 ? 'left' : 'right', sign = side === 'left' ? 1 : -1;
    const up = (o.amount ?? 1.2) * Math.min(1.5, m.energy) * (0.35 + 0.65 * m.beatPulse);
    add(bone(vrm, `${side}UpperArm`), 0, 0, sign * up);
    add(bone(vrm, `${side}LowerArm`), 0, -sign * up * 0.5, 0);
    add(bone(vrm, 'chest'), -m.beatPulse * 0.06 * m.energy, 0, sign * 0.04 * m.energy);
  },

  // 音量で口を開ける（歌っている風）
  mouth(vrm, m, o) {
    const em = vrm.expressionManager;
    if (em?.getExpression('aa')) em.setValue('aa', Math.min(1, m.loudness * (o.amount ?? 0.6) * m.energy));
  },
};
