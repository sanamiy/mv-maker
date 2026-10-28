// 変換済みの解析値（*.json）と元の説明から、データセットの一覧 catalog.jsonl と catalog.csv を作る
// node catalog.mjs datasetDir cmu-index.json
import fs from 'node:fs';
import path from 'node:path';

const [,, DIR, cmuIndexPath] = process.argv;
const cmuIndex = Object.fromEntries(JSON.parse(fs.readFileSync(cmuIndexPath, 'utf8')).map(r => [r.id, r]));

// 説明文・名前のキーワード → 種類とジャンル（先に当たったものを優先）
const KIND = [
  ['dance', /danc|salsa|charleston|charelston|ballet|pirouette|arabesque|jete|breakdance|break ?dance|helicopter|fancyfootwork|lambada|bollywood|indian|twist dance|moonwalk|jackson|chicken dance|disco|jig|^dance_loop$/i],
  ['acrobatics', /cartwheel|flip|summersult|somersault|hand ?spring|handstand|acrobat/i],
  ['gesture', /wave|waving|clap|cheer|point|bow|salute|shrug|nod|^yes$|idle_no|hand signal|gesture|beckon|talk|phone|applaud|conduct|direct traffic|signal/i],
  ['sit', /sit|sitting|kneel|lay|lie down|seat/i],
  ['jump', /jump|hop|leap/i],
  ['run', /run|jog|sprint/i],
  ['walk', /walk|march|wander|stroll|step|strut|navigate|stairs|tiptoe/i],
  ['idle', /idle|stand|wait|breath|look around|fold ?arms|foldarms/i],
  ['sports', /basketball|soccer|kick ball|golf|tennis|swim|swing|boxing|box |punch|kick|throw|catch|baseball|football|stretch|exercise|jumping jacks|squat|yoga|tai chi/i],
  ['action', /sword|pistol|shoot|spell|attack|hit|death|fight|melee|shield|zombie|dash|slide|climb|push|pull|pick ?up|carry|chop|farm|harvest|drive|roll|crouch|throw|interact|consume|drink|eat|open|lift|wash|paint|sweep/i],
];
const GENRE = [
  ['salsa', /salsa/i], ['charleston', /charleston|charelston/i], ['modern', /modern|arabesque|pirouette|jete|glissade|rond de jambe|retire|tendue|coupe/i],
  ['indian', /indian|bollywood/i], ['breakdance', /break|helicopter|fancyfootwork|kickflip|uprightsequence/i], ['lambada', /lambada/i],
  ['pop', /jackson|moonwalk/i], ['chicken-dance', /chicken dance/i], ['social', /swing|waltz|tango|foxtrot/i], ['casual', /^dance_loop$|dance, whirl|dance moves/i],
];
const pick = (rules, text) => rules.filter(([, re]) => re.test(text)).map(([k]) => k);

const energyOf = e => (e < 0.15 ? 1 : e < 0.4 ? 2 : e < 0.8 ? 3 : e < 1.3 ? 4 : 5);
function derive(a) {
  const travelPerSec = a.travel.path / Math.max(a.duration, 0.1);
  const spins = Math.abs(a.turnDeg) >= 300;
  const locomotion = spins && a.travel.net < 1 ? 'spinning' : a.travel.net > 1.2 || travelPerSec > 0.6 ? 'traveling' : a.travel.path > 0.4 ? 'stepping' : 'in-place';
  const upperOnly = a.angularSpeed.legs < 0.35 * a.angularSpeed.arms && a.angularSpeed.legs < 0.6 && a.airborne < 0.02 && locomotion === 'in-place';
  return {
    energy: energyOf(a.energy),
    tempoBand: a.bpm == null || a.beatConfidence < 0.3 ? null : a.bpm < 90 ? 'slow' : a.bpm <= 120 ? 'mid' : 'fast',
    bodyParts: upperOnly ? 'upper' : 'full',
    locomotion,
    loopable: a.loopPoseDiffDeg <= 10 && a.travel.net < 0.3,
    floorWork: a.lowHips > 0.2,
    airborne: a.airborne > 0.1,
  };
}

const rows = [];
for (const [src, sub] of [['cmu', 'cmu'], ['quaternius-ual1', 'quaternius/ual1'], ['quaternius-ual2', 'quaternius/ual2']]) {
  const d = path.join(DIR, sub); if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter(f => f.endsWith('.json')).sort()) {
    const a = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
    const file = `${sub}/${f.replace(/\.json$/, '.vrma')}`;
    let name, description, category, text;
    if (src === 'cmu') {
      const r = cmuIndex[a.id]; name = a.id; description = r?.desc ?? ''; category = r?.category ?? '';
      text = `${description} ${/danc|salsa|charleston|charelston|breakdance/i.test(category) && !/^walk$|^run|cartwheel|flip/i.test(description) ? category : ''}`;
    } else {
      name = a.id.replace(/^ual[12]_/, ''); description = name.replace(/_RM$/, ' (root motion)').replace(/_/g, ' '); category = 'Quaternius Universal Animation Library' + (src.endsWith('2') ? ' 2' : '');
      text = name;
    }
    const kinds = pick(KIND, text);
    const kind = kinds[0] ?? 'other';
    rows.push({
      id: `${src.replace('quaternius-', '')}_${name}`.replace(/^cmu_/, 'cmu_'),
      file, source: src, name, description, category,
      duration: a.duration, fps: a.fps, frames: a.frames,
      kind, genre: kind === 'dance' ? pick(GENRE, `${description} ${category} ${name}`) : [],
      bpm: a.beatConfidence >= 0.3 ? a.bpm : null,
      ...derive(a),
      fingers: src !== 'cmu',
      rootMotion: src === 'cmu' || /_RM$/.test(name),
      analysis: { travel: a.travel, turnDeg: a.turnDeg, angularSpeed: a.angularSpeed, energy: a.energy, airborne: a.airborne, lowHips: a.lowHips, loopPoseDiffDeg: a.loopPoseDiffDeg, beatConfidence: a.beatConfidence, hipHeight: a.hipHeight },
    });
  }
}
fs.writeFileSync(path.join(DIR, 'catalog.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const cols = ['id', 'file', 'source', 'name', 'description', 'category', 'duration', 'kind', 'genre', 'bpm', 'tempoBand', 'energy', 'bodyParts', 'locomotion', 'loopable', 'floorWork', 'airborne', 'fingers', 'rootMotion'];
const esc = v => { const s = Array.isArray(v) ? v.join(';') : v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync(path.join(DIR, 'catalog.csv'), [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n');
const count = k => Object.entries(rows.reduce((m, r) => { const v = Array.isArray(r[k]) ? r[k] : [r[k]]; for (const x of v) m[x] = (m[x] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
console.log(rows.length, 'motions', (rows.reduce((s, r) => s + r.duration, 0) / 3600).toFixed(2), 'h');
for (const k of ['source', 'kind', 'genre', 'energy', 'tempoBand', 'bodyParts', 'locomotion', 'loopable']) console.log(k, JSON.stringify(count(k)));
