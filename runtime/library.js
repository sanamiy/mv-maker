// 動きの一覧（ライブラリ）を読み、id で引いたり条件で探したりする。ブラウザ（再生時）と Node（src/motions.mjs）の両方で使う。
// 一覧は open-vrma と同じ形: <dir>/catalog.jsonl（1行1モーション、SPEC §1.3 の列）と、VRMA の隣の <name>.motion.json（Motion Meta 0.1）
// 読み込みは readText(url) を渡して行う（ブラウザは fetch、Node は fs）。url は文字列で、ディレクトリの url は / で終える。

export const SECTION_ENERGY = { intro: [1, 2], verse: [2, 3], 'pre-chorus': [3, 4], chorus: [4, 5], interlude: [2, 4], bridge: [2, 3], outro: [1, 2] };

const join = (dir, file) => new URL(file, dir).href;

// Motion Meta → 一覧の1行（SPEC §1.3。open-vrma の catalog.jsonl と同じ列）
export function flatten(meta, file) {
  return {
    id: meta.id, file, name: meta.name ?? meta.id, description: meta.description ?? '', duration: meta.duration,
    license: meta.license?.spdx, attribution: meta.license?.attribution,
    ...meta.tags,
    bpm: meta.tempo?.bpm ?? null,
    alternatives: meta.tempo?.alternatives ?? [],
    tempoBand: meta.tempo?.bpm == null ? null : meta.tempo.bpm < 90 ? 'slow' : meta.tempo.bpm <= 120 ? 'mid' : 'fast',
    loopable: !!meta.loop, loopBeats: meta.loop?.beats ?? null, hasTiming: !!(meta.events?.length || meta.ranges?.length),
    travel: meta.root?.netTravel ?? null, turnDeg: meta.root?.netTurnDeg ?? null,
    startPose: meta.poses?.start ?? null, endPose: meta.poses?.end ?? null,
    stretch: meta.allow?.stretch ?? null,
  };
}

// 一覧のディレクトリを読む。返り値: { rows, find(id), meta(id) }
// dirs: [{ url: 'http://…/assets/open-vrma/', name? }]。先に書いた一覧の id が優先
export async function loadLibrary(dirs, readText) {
  const rows = [], byId = new Map(), metas = new Map(), sources = [];
  const tryRead = async u => { try { return await readText(u); } catch { return null; } };
  for (const d of dirs) {
    const url = d.url.endsWith('/') ? d.url : d.url + '/';
    const jsonl = await tryRead(join(url, 'catalog.jsonl'));
    if (jsonl != null) {
      let n = 0;
      for (const line of jsonl.split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (byId.has(r.id)) continue;
        const row = { alternatives: r.tempoAlternatives ?? r.alternatives ?? [], ...r, source: d.name ?? 'open-vrma', url: join(url, r.file) };
        rows.push(row); byId.set(r.id, row); n++;
      }
      sources.push({ ...d, url, count: n });
      continue;
    }
    sources.push({ ...d, url, count: 0, missing: true });
  }
  return {
    rows, sources,
    find: id => byId.get(id) ?? null,
    // サイドカーの Motion Meta（手元に無ければ null）
    async meta(id) {
      if (metas.has(id)) return metas.get(id);
      const row = byId.get(id); if (!row) return null;
      const text = await tryRead(row.url.replace(/\.vrma$/i, '.motion.json'));
      const meta = text ? JSON.parse(text) : null;
      metas.set(id, meta);
      return meta;
    },
  };
}

// 曲の BPM に合わせるときの再生速度。動きの拍1つを曲の 0.5 / 1 / 2 拍に当てる中から、速度が 1 に近いものを選ぶ
// 返り値: { rate, songBeatsPerMotionBeat, motionBpm, ok }（ok: 伸び縮みの許容範囲に入る）。拍の無い動きは null
export function tempoFit(row, songBpm) {
  if (!songBpm || row.bpm == null) return null;
  const s = row.stretch ?? {};
  if (s.mode === 'none') return { rate: 1, songBeatsPerMotionBeat: 1, motionBpm: row.bpm, ok: Math.abs(Math.log(songBpm / row.bpm)) < 0.03 };
  const lo = s.minRate ?? 0.8, hi = s.maxRate ?? 1.25;
  const ks = s.allowHalfDouble === false ? [1] : [0.5, 1, 2];
  let best = null;
  for (const c of [row.bpm, ...(row.alternatives ?? [])]) for (const k of ks) {
    const rate = songBpm / (c * k);
    if (!best || Math.abs(Math.log(rate)) < Math.abs(Math.log(best.rate))) best = { rate, songBeatsPerMotionBeat: 1 / k, motionBpm: c };
  }
  return { ...best, rate: +best.rate.toFixed(3), ok: best.rate >= lo - 1e-9 && best.rate <= hi + 1e-9 };
}

const list = v => (v == null ? [] : Array.isArray(v) ? v : String(v).split(',').map(s => s.trim()).filter(Boolean));
const range = v => { if (v == null) return null; if (Array.isArray(v)) return v; const [a, b] = String(v).split('-').map(Number); return [a, Number.isFinite(b) ? b : a]; };
const LICENSE_ALIAS = { cc0: 'CC0-1.0', 'cc-by': 'CC-BY-4.0', 'cc-by-sa': 'CC-BY-SA-4.0', 'cc-by-nc': 'CC-BY-NC-4.0', cmu: 'LicenseRef-CMU-Mocap' };

// 条件で絞り、合う順に並べる（SPEC §6.1 の順）。q のキー:
//   kind, genre, mood, bodyParts, facing, locomotion, source, license（カンマ区切り可。license は cc0 / cc-by / cmu などの略称も可）
//   section（区間名。タグがあれば絞り込み、なければ energy の目安で並べる）, energy（"4-5" など）, bpm（曲の BPM。伸び縮みの範囲外は除く）
//   loop（true でループできるものだけ）, inPlace（true でその場の動きだけ）, maxDuration / minDuration（秒）
//   after（直前に使う動きの id。終わりの姿勢と始まりの姿勢が合うものを上に）, text（名前・説明・キーワードの部分一致）
export function search(lib, q = {}) {
  const want = k => list(q[k]).map(s => s.toLowerCase());
  const kinds = want('kind'), genres = want('genre'), moods = want('mood'), parts = want('bodyParts'), facings = want('facing'), locos = want('locomotion'), srcs = want('source');
  const licenses = list(q.license).map(l => LICENSE_ALIAS[l.toLowerCase()] ?? l);
  const energy = range(q.energy), section = q.section ?? null, text = q.text?.toLowerCase();
  const prev = q.after ? lib.find(q.after) : null;
  const out = [];
  for (const r of lib.rows) {
    const has = (v, ws) => !ws.length || list(v).some(x => ws.includes(String(x).toLowerCase()));
    if (kinds.length && !kinds.includes(r.kind)) continue;
    if (!has(r.genre, genres) || !has(r.mood, moods) || !has(r.bodyParts, parts)) continue;
    if (facings.length && !facings.includes(r.facing)) continue;
    if (locos.length && !locos.includes(r.locomotion)) continue;
    if (srcs.length && !srcs.includes(r.source)) continue;
    if (licenses.length && !licenses.includes(r.license)) continue;
    if (energy && (r.energy == null || r.energy < energy[0] || r.energy > energy[1])) continue;
    if (section && Array.isArray(r.sections) && r.sections.length && !r.sections.includes(section)) continue;
    if (q.loop && !r.loopable) continue;
    if (q.inPlace && !(r.locomotion === 'in-place' || (r.travel != null && r.travel < 0.3))) continue;
    if (q.maxDuration && r.duration > q.maxDuration) continue;
    if (q.minDuration && r.duration < q.minDuration) continue;
    if (text && ![r.id, r.name, r.description, ...list(r.keywords)].some(s => String(s ?? '').toLowerCase().includes(text))) continue;
    const fit = q.bpm ? tempoFit(r, Number(q.bpm)) : null;
    if (q.bpm && !(fit?.ok)) continue;
    // 並べ順の点数（大きいほど上）
    let score = 0;
    if (fit) score += 2 - Math.abs(Math.log(fit.rate)) * 10;
    if (section && !energy && r.energy != null) { const [a, b] = SECTION_ENERGY[section] ?? [1, 5]; score -= r.energy < a ? a - r.energy : r.energy > b ? r.energy - b : 0; }
    if (section && Array.isArray(r.sections) && r.sections.includes(section)) score += 1;
    if (prev?.endPose && r.startPose) score += prev.endPose === r.startPose ? 1 : -1;
    if (r.loopable) score += 0.3;
    if (r.hasTiming) score += 0.2;
    if (r.facing === 'front') score += 0.2;
    out.push({ ...r, fit, score: +score.toFixed(2) });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out;
}
