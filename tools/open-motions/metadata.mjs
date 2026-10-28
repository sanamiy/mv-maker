// 解析値（analysis/*.json）と元素材の情報から、VRMA ごとのメタデータ（<name>.motion.json、Motion Meta 0.1）を書き、
// そこから一覧 catalog.jsonl / catalog.csv を作る
// node metadata.mjs <analysisDir> <datasetDir> <cmu-index.json> [validate.mjs]
import fs from 'node:fs';
import path from 'node:path';

const [,, ANALYSIS, DIR, cmuIndexPath, validatorPath] = process.argv;
const cmuIndex = Object.fromEntries(JSON.parse(fs.readFileSync(cmuIndexPath, 'utf8')).map(r => [r.id, r]));
const check = validatorPath ? (await import(path.resolve(validatorPath))).check : null;
const CONVERTER = 'open-motions@0.1';

// 素材ごとのライセンスと出典（そのまま貼れるクレジット文を必ず入れる）
const SOURCES = {
  cmu: {
    dir: 'cmu',
    license: id => ({
      spdx: 'LicenseRef-CMU-Mocap',
      url: 'http://mocap.cs.cmu.edu/faqs.php',
      attribution: 'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
      authors: [{ name: 'Carnegie Mellon University Graphics Lab', url: 'http://mocap.cs.cmu.edu/' }, { name: 'Bruce Hahne (BVH conversion, cgspeed)' }],
      source: { kind: 'converted', url: 'http://mocap.cs.cmu.edu/', originalId: id, originalFormat: 'bvh', converter: `${CONVERTER}/cmu2vrma`, capture: 'mocap' },
    }),
    sourceFps: 120,
  },
  ual1: {
    dir: 'quaternius/ual1',
    license: id => ({
      spdx: 'CC0-1.0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: 'Universal Animation Library by Quaternius (CC0 1.0)',
      authors: [{ name: 'Quaternius', url: 'https://quaternius.com/' }],
      source: { kind: 'converted', url: 'https://quaternius.com/packs/universalanimationlibrary.html', originalId: id, originalFormat: 'glb', converter: `${CONVERTER}/quaternius2vrma`, capture: 'keyframe' },
    }),
  },
  ual2: {
    dir: 'quaternius/ual2',
    license: id => ({
      spdx: 'CC0-1.0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: 'Universal Animation Library 2 by Quaternius (CC0 1.0)',
      authors: [{ name: 'Quaternius', url: 'https://quaternius.com/' }],
      source: { kind: 'converted', url: 'https://quaternius.itch.io/universal-animation-library-2', originalId: id, originalFormat: 'glb', converter: `${CONVERTER}/quaternius2vrma`, capture: 'keyframe' },
    }),
  },
};

// 説明文・名前のキーワード → 種類とジャンル（先に当たったものを優先）
const KIND = [
  ['dance', /danc|salsa|charleston|charelston|ballet|pirouette|arabesque|jete|breakdance|break ?dance|helicopter|fancyfootwork|lambada|bollywood|indian|twist dance|moonwalk|jackson|chicken dance|disco|jig|^dance_loop$/i],
  ['acrobatics', /cartwheel|flip|summersult|somersault|hand ?spring|handstand|acrobat/i],
  ['gesture', /wave|waving|clap|cheer|point|bow|salute|shrug|nod|^yes$|idle_no|hand signal|gesture|beckon|talk|phone|applaud|conduct|direct traffic|signal|nursery rhyme|teapot|peek ?a ?boo|laugh|cry|scared|happy|sad|angry|curtsey|mope|surprised|emotion|pantomime|story|communication/i],
  ['sit', /sit|sitting|kneel|lay|lie down|seat/i],
  ['jump', /jump|hop|leap/i],
  ['run', /run|jog|sprint/i],
  ['walk', /walk|march|wander|stroll|step|strut|navigate|stairs|tiptoe/i],
  ['idle', /idle|stand|wait|breath|look around|fold ?arms|foldarms/i],
  ['sports', /basketball|soccer|kick ball|golf|putt|tee|tennis|swim|stroke|swing|boxing|box |punch|kick|throw|catch|baseball|football|frisbee|stretch|exercise|jumping jacks|squat|yoga|tai chi|range of motion|martial|karate|empi|fishing/i],
  ['action', /get up|getting up|limp|sneak|motorcycle|sword|pistol|shoot|spell|attack|hit|death|fight|melee|shield|zombie|dash|slide|climb|push|pull|pick ?up|carry|chop|farm|harvest|drive|roll|crouch|throw|interact|consume|drink|eat|open|lift|wash|paint|sweep/i],
];
const GENRE = [
  ['salsa', /salsa/i], ['charleston', /charleston|charelston/i], ['modern', /modern|arabesque|pirouette|jete|glissade|rond de jambe|retire|tendue|coupe/i],
  ['indian', /indian|bollywood/i], ['breakdance', /break|helicopter|fancyfootwork|kickflip|uprightsequence/i], ['lambada', /lambada/i],
  ['pop', /jackson|moonwalk/i], ['chicken-dance', /chicken dance/i], ['social', /swing|waltz|tango|foxtrot/i], ['casual', /^dance_loop$|dance, whirl|dance moves/i],
];
const pick = (rules, text) => rules.filter(([, re]) => re.test(text)).map(([k]) => k);
const slug = s => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
const energyOf = e => (e < 0.15 ? 1 : e < 0.4 ? 2 : e < 0.8 ? 3 : e < 1.3 ? 4 : 5);

const m_id = (src, name) => slug(`${src}_${name}`);
// 崩れないことを目で確かめたもの（VRM1 のサンプル・まる・オオモフ）
const CHECKED = {
  cmu_60_01: ['vrm1-sample', 'maru', 'oomofu'], cmu_05_02: ['vrm1-sample'], cmu_85_12: ['vrm1-sample'],
  ual1_dance_loop: ['vrm1-sample'], ual1_walk_loop: ['vrm1-sample'], ual2_idle_foldarms_loop: ['vrm1-sample'], ual2_idle_talkingphone_loop: ['vrm1-sample'],
};

function build(src, a) {
  const S = SOURCES[src];
  let name, description, kindText, keywords = [];
  if (src === 'cmu') {
    const r = cmuIndex[a.id];
    name = a.id; description = r?.desc ?? '';
    const cat = r?.category ?? '';
    keywords = cat ? [cat] : [];
    kindText = `${description} ${/danc|salsa|charleston|charelston|breakdance/i.test(cat) && !/^walk$|^run|cartwheel|flip/i.test(description) ? cat : ''}`;
  } else {
    name = a.id.replace(/^ual[12]_/, ''); description = name.replace(/_RM$/, ' (root motion)').replace(/_/g, ' ');
    kindText = name;
  }
  // 説明文で決まらなければ（"clean" "unknown" など）、カテゴリ名で決める
  const kind = pick(KIND, kindText)[0] ?? pick(KIND, keywords.join(' '))[0] ?? 'other';
  const D = a.duration;
  const travelPerSec = a.travel.path / Math.max(D, 0.1);
  const locomotion = Math.abs(a.turnDeg) >= 300 && a.travel.net < 1 ? 'spinning' : a.travel.net > 1.2 || travelPerSec > 0.6 ? 'traveling' : a.travel.path > 0.4 ? 'stepping' : 'in-place';
  const upper = a.angularSpeed.legs < 0.35 * a.angularSpeed.arms && a.angularSpeed.legs < 0.6 && a.airborne < 0.02 && locomotion === 'in-place';
  const loopable = a.loopPoseDiffDeg <= 10 && a.travel.net < 0.3 && D >= 0.5;
  // 主に動く部位: 動きの割合が 25% 以上の部位。腕と脚の両方なら full
  let parts = Object.entries(a.bodyShare ?? {}).filter(([, v]) => v >= 0.25).map(([k]) => k);
  if (upper) parts = parts.filter(p => p !== 'legs' && p !== 'hips');
  if (!parts.length) parts = upper ? ['arms'] : ['full'];
  if (parts.includes('legs') && (parts.includes('arms') || !upper)) parts = ['full'];
  const confident = a.bpm != null && a.beatConfidence >= 0.3;

  // 接地 → contact / lift と footLock
  const events = [], ranges = [];
  const clamp = t => Math.min(t, D);  // 解析値の時刻（3桁）が duration（2桁に丸め）をわずかに超えることがある
  for (const side of ['left', 'right']) for (let [from, to] of a.contacts?.[side] ?? []) {
    from = clamp(from); to = clamp(to);
    if (from > 0) events.push({ t: from, type: 'contact', side });
    if (to < D - 1e-6) events.push({ t: to, type: 'lift', side });
    if (to - from >= 0.05) ranges.push({ from, to, type: 'footLock', side });
  }
  events.sort((x, y) => x.t - y.t || x.type.localeCompare(y.type));

  const m = {
    specVersion: '0.1',
    id: m_id(src, name),
    name, description, duration: D,
    ...(S.sourceFps ? { sourceFps: S.sourceFps } : {}),
    license: S.license(src === 'cmu' ? a.id : name),
    tags: {
      kind, genre: kind === 'dance' ? pick(GENRE, `${description} ${keywords.join(' ')} ${name}`) : [],
      energy: energyOf(a.energy), bodyParts: parts, locomotion, facing: a.facing,
      floorWork: a.lowHips > 0.2, airborne: a.airborne > 0.1,
      fingers: src !== 'cmu', expressions: false, lookAt: false,
      rootMotion: src === 'cmu' || /_RM$/.test(name),
      ...(keywords.length ? { keywords } : {}),
    },
    tempo: confident ? { bpm: a.bpm, beatsPerBar: 4, firstBeat: Math.min(a.firstBeat ?? 0, D), confidence: a.beatConfidence } : { bpm: null, confidence: a.beatConfidence ?? 0 },
    ...(loopable ? { loop: { in: 0, out: D, mode: 'cycle', blend: +Math.min(0.1, D / 4).toFixed(3), ...(confident ? { beats: Math.max(1, Math.round(D * a.bpm / 60)) } : {}), poseDiffDeg: a.loopPoseDiffDeg } } : {}),
    ...(kind === 'dance' && confident && a.beatConfidence >= 0.5 ? { allow: { stretch: { mode: 'beats' } } } : {}),
    ...(events.length ? { events } : {}),
    ...(ranges.length ? { ranges } : {}),
    root: a.root,
    poses: a.poses,
    retarget: { restPose: 'T', sourceHipHeight: a.hipHeight, floorAligned: true, ...(CHECKED[m_id(src, name)] ? { checkedOn: CHECKED[m_id(src, name)] } : {}) },
    provenance: { tags: 'auto', tempo: 'auto', events: 'auto', ranges: 'auto' },
    x: { openMotions: { pathTravel: a.travel.path, angularSpeed: a.angularSpeed, bodyShare: a.bodyShare, energy: a.energy, airborne: a.airborne, lowHips: a.lowHips } },
  };
  return m;
}

const rows = []; let bad = 0;
for (const src of Object.keys(SOURCES)) {
  const adir = path.join(ANALYSIS, src); if (!fs.existsSync(adir)) continue;
  for (const f of fs.readdirSync(adir).filter(f => f.endsWith('.json')).sort()) {
    const a = JSON.parse(fs.readFileSync(path.join(adir, f), 'utf8'));
    const m = build(src, a);
    const base = src === 'cmu' ? a.id : a.id.replace(/^ual[12]_/, '');
    const vrma = `${SOURCES[src].dir}/${base}.vrma`;
    if (!fs.existsSync(path.join(DIR, vrma))) { console.error('VRMA が無い:', vrma); bad++; continue; }
    const errs = check ? check(m) : [];
    if (errs.length) { console.error('除外（仕様の検証に通らない）:', m.id, errs.join(' / ')); fs.rmSync(path.join(DIR, vrma), { force: true }); bad++; continue; }
    fs.writeFileSync(path.join(DIR, vrma.replace(/\.vrma$/, '.motion.json')), JSON.stringify(m, null, 1) + '\n');
    rows.push({ file: vrma, m });
  }
}

// 一覧はサイドカーから作る（手で直さない）
const flat = ({ file, m }) => ({
  id: m.id, file, name: m.name, description: m.description, duration: m.duration,
  license: m.license.spdx, attribution: m.license.attribution,
  ...m.tags,
  bpm: m.tempo?.bpm ?? null,
  tempoBand: m.tempo?.bpm == null ? null : m.tempo.bpm < 90 ? 'slow' : m.tempo.bpm <= 120 ? 'mid' : 'fast',
  loopable: !!m.loop, loopBeats: m.loop?.beats ?? null, hasTiming: !!(m.events?.length || m.ranges?.length),
  travel: m.root?.netTravel ?? null, turnDeg: m.root?.netTurnDeg ?? null, startPose: m.poses?.start ?? null, endPose: m.poses?.end ?? null,
});
const flatRows = rows.map(flat);
fs.writeFileSync(path.join(DIR, 'catalog.jsonl'), flatRows.map(r => JSON.stringify(r)).join('\n') + '\n');
// タグは動きによって有無が違うので、全行の列を集める
const cols = [...new Set(flatRows.flatMap(r => Object.keys(r)))];
const esc = v => { const s = Array.isArray(v) ? v.join(';') : v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync(path.join(DIR, 'catalog.csv'), [cols.join(','), ...flatRows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n');

const count = k => Object.entries(flatRows.reduce((acc, r) => { for (const x of [].concat(r[k])) acc[x] = (acc[x] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]);
console.log(flatRows.length, 'motions', (flatRows.reduce((s, r) => s + r.duration, 0) / 3600).toFixed(2), 'h', bad ? `（${bad}本は除外）` : '');
for (const k of ['license', 'kind', 'genre', 'energy', 'tempoBand', 'bodyParts', 'locomotion', 'facing', 'loopable', 'hasTiming', 'startPose']) console.log(k, JSON.stringify(count(k)));
process.exit(bad && !flatRows.length ? 1 : 0);
