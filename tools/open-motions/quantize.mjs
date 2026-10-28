// VRMA の回転トラックを 16bit 整数（normalized SHORT）にして容量を約半分にする。位置・時刻は float のまま
// node quantize.mjs <フォルダ>    フォルダ以下の .vrma をすべて上書き（16bit 化済みのものは飛ばす）
// node quantize.mjs in.vrma out.vrma
import fs from 'node:fs';
import path from 'node:path';

export function quantizeVRMA(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));
  const rotAcc = new Set(json.animations.flatMap(a => a.channels.filter(c => c.target.path === 'rotation').map(c => a.samplers[c.sampler].output)));
  const chunks = []; let offset = 0;
  const views = json.accessors.map((acc, i) => {
    const v = json.bufferViews[acc.bufferView];
    let buf = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    if (rotAcc.has(i) && acc.componentType === 5126) {
      const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const s = new Int16Array(f.length);
      for (let k = 0; k < f.length; k++) s[k] = Math.round(Math.max(-1, Math.min(1, f[k])) * 32767);
      buf = Buffer.from(s.buffer); acc.componentType = 5122; acc.normalized = true;
    }
    const pad = (4 - (buf.length % 4)) % 4;
    const view = { buffer: 0, byteOffset: offset, byteLength: buf.length };
    chunks.push(buf, Buffer.alloc(pad)); offset += buf.length + pad;
    acc.bufferView = i; return view;
  });
  json.bufferViews = views;
  const newBin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBin.length }];
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + newBin.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, ch(js.length, 0x4e4f534a), js, ch(newBin.length, 0x004e4942), newBin]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, a, b] = process.argv;
  if (fs.statSync(a).isDirectory()) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.vrma') ? [path.join(d, e.name)] : []);
    let n = 0;
    for (const f of walk(a)) { const buf = fs.readFileSync(f); if (buf.includes('"normalized":true')) continue; fs.writeFileSync(f, quantizeVRMA(buf)); n++; }
    console.error('16bit 化:', n, '本');
  } else fs.writeFileSync(b, quantizeVRMA(fs.readFileSync(a)));
}
