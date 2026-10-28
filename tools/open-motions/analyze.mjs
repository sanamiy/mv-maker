// 回転列と主要関節の軌跡から、タグ付け用の解析値を出す
const ang = (a, i, j) => { const d = Math.abs(a[i] * a[j] + a[i + 1] * a[j + 1] + a[i + 2] * a[j + 2] + a[i + 3] * a[j + 3]); return 2 * Math.acos(Math.min(1, d)); };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const r2 = v => +v.toFixed(2);

function angSpeed(rot, bones, fps, n) {
  const list = bones.filter(b => rot[b]); let s = 0, c = 0;
  for (const b of list) for (let i = 1; i < n; i++) { s += ang(rot[b], (i - 1) * 4, i * 4) * fps; c++; }
  return c ? s / c : 0;
}

// 動きの強さの周期から拍を推定（自己相関、60〜180 BPM に折りたたむ）
function tempo(sig, fps) {
  const n = sig.length; if (n < fps * 4) return { bpm: null, beatConfidence: 0 };
  const m = sig.reduce((a, b) => a + b, 0) / n; const x = sig.map(v => v - m);
  const e = x.reduce((a, v) => a + v * v, 0) || 1;
  let best = 0, bestLag = 0;
  for (let lag = Math.round(fps * 0.3); lag <= Math.round(fps * 1.6); lag++) {
    let s = 0; for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    const r = s / e * n / (n - lag);
    if (r > best) { best = r; bestLag = lag; }
  }
  if (!bestLag) return { bpm: null, beatConfidence: 0 };
  let bpm = 60 * fps / bestLag;
  while (bpm < 60) bpm *= 2; while (bpm > 180) bpm /= 2;
  bpm = Math.round(bpm);
  // 拍の位相: 拍の間隔ごとに動きの強さを足し合わせ、いちばん強くなるずれを最初の拍にする
  const period = 60 * fps / bpm; let bestPhase = 0, bestSum = -Infinity;
  for (let ph = 0; ph < period; ph++) { let sum = 0, c = 0; for (let t = ph; t < n; t += period) { sum += x[Math.round(t)] ?? 0; c++; } if (sum / c > bestSum) { bestSum = sum / c; bestPhase = ph; } }
  return { bpm, beatConfidence: r2(best), firstBeat: +((bestPhase + 1) / fps).toFixed(3) };
}

// 足の接地: つま先が床から 5cm 以内で、水平の速さが 0.4m/s 未満の間。0.1 秒未満の接地・離地はならす
function contacts(toe, fps) {
  const n = toe.length, on = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.max(0, i - 1), k = Math.min(n - 1, i + 1);
    const v = Math.hypot(toe[k][0] - toe[j][0], toe[k][2] - toe[j][2]) * fps / Math.max(1, k - j);
    on[i] = toe[i][1] < 0.05 && v < 0.4;
  }
  const minRun = Math.round(fps * 0.1);
  for (const val of [false, true]) { // 短い離地を埋めてから、短い接地を消す
    let i = 0; while (i < n) { if (on[i] !== val) { i++; continue; } let j = i; while (j < n && on[j] === val) j++; if (j - i < minRun && i > 0 && j < n) for (let k = i; k < j; k++) on[k] = !val; i = j; }
  }
  const spans = []; let i = 0;
  while (i < n) { if (!on[i]) { i++; continue; } let j = i; while (j < n && on[j]) j++; spans.push([+(i / fps).toFixed(3), +((j - 1) / fps).toFixed(3)]); i = j; }
  return spans;
}

// 1コマの姿勢: 腰の高さ・接地・腕の位置から、つなぎ目で比べるための分類をする
function poseAt(track, i, h, yawRad) {
  const lt = track.leftToe[i][1] < 0.06 || track.leftFoot[i][1] < 0.14, rt = track.rightToe[i][1] < 0.06 || track.rightFoot[i][1] < 0.14;
  const hy = track.hips[i][1] / h;
  const pose = !lt && !rt && hy > 0.95 ? 'air' : hy > 0.85 ? 'stand' : hy > 0.55 ? 'crouch' : track.head[i][1] / h < 0.6 ? (hy < 0.3 ? 'lie' : 'floor') : hy < 0.4 ? 'sit' : 'kneel';
  const support = lt && rt ? 'both' : lt ? 'left' : rt ? 'right' : 'none';
  // 腕: 体の向きにそろえた座標で、手が肩より上・前・横・腰のそば・下のどれか
  const c = Math.cos(-yawRad), s = Math.sin(-yawRad), hip = track.hips[i];
  const local = p => { const x = p[0] - hip[0], z = p[2] - hip[2]; return [x * c + z * s, p[1], -x * s + z * c]; };
  const arm = side => {
    const hand = local(track[`${side}Hand`][i]), sh = local(track[`${side}UpperArm`][i]);
    if (hand[1] > sh[1] + 0.1 * h) return 'up';
    if (Math.abs(hand[0]) - Math.abs(sh[0]) > 0.35 * h) return 'wide';
    if (hand[2] > 0.3 * h) return 'front';
    if (Math.abs(hand[1] - hip[1]) < 0.15 * h && Math.abs(hand[0]) < 0.35 * h && Math.abs(hand[2]) < 0.2 * h) return 'hips';
    return 'down';
  };
  const l = arm('left'), r = arm('right');
  return { pose, support, arms: l === r ? l : 'other' };
}

export function analyze({ fps, frameCount: n, rot, bones, track, hipRest }) {
  const h = hipRest;
  const hip = track.hips;
  let path = 0; for (let i = 1; i < n; i++) path += Math.hypot(hip[i][0] - hip[i - 1][0], hip[i][2] - hip[i - 1][2]);
  const net = Math.hypot(hip[n - 1][0] - hip[0][0], hip[n - 1][2] - hip[0][2]);
  // 腰の向き（ヨー）の累積
  const yaw = i => { const q = rot.hips, o = i * 4; const [x, y, z, w] = [q[o], q[o + 1], q[o + 2], q[o + 3]]; return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x)); };
  let turn = 0, prev = yaw(0); for (let i = 1; i < n; i++) { let d = yaw(i) - prev; d = Math.atan2(Math.sin(d), Math.cos(d)); turn += d; prev = yaw(i); }
  const legs = angSpeed(rot, ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'], fps, n);
  const arms = angSpeed(rot, ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'], fps, n);
  const torso = angSpeed(rot, ['spine', 'chest', 'upperChest', 'neck', 'head'], fps, n);
  // 末端の速さ（m/s）を拍推定と強さに使う
  const ends = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'head'];
  const sig = []; for (let i = 1; i < n; i++) sig.push(ends.reduce((a, k) => a + dist(track[k][i], track[k][i - 1]) * fps, 0) + Math.abs(hip[i][1] - hip[i - 1][1]) * fps * 2);
  const energy = sig.reduce((a, b) => a + b, 0) / (sig.length || 1) / ends.length;
  let air = 0, low = 0;
  for (let i = 0; i < n; i++) { if (track.leftToe[i][1] > 0.08 && track.rightToe[i][1] > 0.08) air++; if (hip[i][1] < h * 0.6) low++; }
  // 腰の水平移動の最大・向きの振れ幅・上下の振れ幅（すべて腰の高さ倍か度）
  let maxTravel = 0; for (let i = 0; i < n; i++) maxTravel = Math.max(maxTravel, Math.hypot(hip[i][0] - hip[0][0], hip[i][2] - hip[0][2]));
  let cum = 0, cmin = 0, cmax = 0, pv = yaw(0); for (let i = 1; i < n; i++) { let d = yaw(i) - pv; d = Math.atan2(Math.sin(d), Math.cos(d)); cum += d; pv = yaw(i); cmin = Math.min(cmin, cum); cmax = Math.max(cmax, cum); }
  const hys = hip.map(p => p[1]).sort((a, b) => a - b); const pct = q => hys[Math.min(n - 1, Math.floor(q * (n - 1)))];
  // 向き: +Z（正面）からのずれ。大きく回るなら turning
  let front = 0, side = 0, back = 0; for (let i = 0; i < n; i++) { const d = Math.abs(yaw(i)) * 180 / Math.PI; if (d < 45) front++; else if (d < 135) side++; else back++; }
  const facing = (cmax - cmin) * 180 / Math.PI > 180 ? 'turning' : front >= side && front >= back ? 'front' : side >= back ? 'side' : 'back';
  // 部位ごとの動きの割合
  const share = {
    head: angSpeed(rot, ['neck', 'head'], fps, n), torso: angSpeed(rot, ['spine', 'chest', 'upperChest'], fps, n),
    arms: angSpeed(rot, ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'], fps, n),
    hands: angSpeed(rot, bones.filter(b => /Hand$|Thumb|Index|Middle|Ring|Little/.test(b)), fps, n),
    hips: angSpeed(rot, ['hips'], fps, n), legs: angSpeed(rot, ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'], fps, n),
  };
  const tot = Object.values(share).reduce((a, b) => a + b, 0) || 1;
  for (const k in share) share[k] = r2(share[k] / tot);
  const p0 = poseAt(track, 0, h, yaw(0)), p1 = poseAt(track, n - 1, h, yaw(n - 1));
  let loopDiff = 0, cnt = 0; for (const b of bones) if (rot[b] && b !== 'hips') { loopDiff += ang(rot[b], 0, (n - 1) * 4); cnt++; }
  loopDiff = loopDiff / cnt * 180 / Math.PI;
  return {
    hipHeight: r2(h),
    travel: { path: r2(path / h), net: r2(net / h) },
    turnDeg: Math.round(turn * 180 / Math.PI),
    angularSpeed: { legs: r2(legs), arms: r2(arms), torso: r2(torso) },
    energy: r2(energy),
    airborne: r2(air / n), lowHips: r2(low / n),
    loopPoseDiffDeg: Math.round(loopDiff),
    ...tempo(sig, fps),
    root: { netTravel: r2(net / h), maxTravel: r2(maxTravel / h), netTurnDeg: Math.round(turn * 180 / Math.PI), turnRangeDeg: Math.round((cmax - cmin) * 180 / Math.PI), hipsBounce: r2((pct(0.95) - pct(0.05)) / h) },
    facing, bodyShare: share,
    poses: { start: p0.pose, end: p1.pose, startSupport: p0.support, endSupport: p1.support, startArms: p0.arms, endArms: p1.arms },
    contacts: { left: contacts(track.leftToe, fps), right: contacts(track.rightToe, fps) },
  };
}
