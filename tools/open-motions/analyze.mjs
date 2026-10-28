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
  return { bpm: Math.round(bpm), beatConfidence: r2(best) };
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
  };
}
