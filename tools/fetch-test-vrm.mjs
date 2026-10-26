// 動作確認用のサンプルVRM（three-vrm リポジトリ同梱のもの）を assets/test.vrm に取得する。
// リポジトリには含めない。オリジナルモデルができたら scene.json の character.vrm を差し替える。
import fs from 'node:fs';
const URL_ = 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';
const out = new URL('../assets/test.vrm', import.meta.url);
if (fs.existsSync(out)) { console.log('assets/test.vrm already exists'); process.exit(0); }
fs.mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
const res = await fetch(URL_);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log('saved assets/test.vrm');
