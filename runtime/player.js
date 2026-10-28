// シーン定義を読み込み、フレーム番号を1つずつ進めて canvas に描く。
// 実時間には一切依存しない（Date / performance.now / requestAnimationFrame を使わない）ので、
// 何度書き出しても同じ映像になる。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { buildSections, musicAt } from './timeline.js';
import { behaviors } from './behaviors.js';
import { HtmlLayers, parseTime } from './layers.js';
import { loadMixamo, analyzeMotion } from './mixamo.js';
import { loadVrma, infoFromMeta } from './vrma.js';
import { loadLibrary } from './library.js';

const BG_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }`;
const BG_FRAG = `
uniform float uTime, uBeat, uPulse, uEnergy, uAspect;
uniform vec3 uLow, uHigh;
varying vec2 vUv;
void main(){
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float k = clamp((uEnergy - 0.3) / 1.0, 0.0, 1.0);
  vec3 base = mix(uLow, uHigh, k);
  vec3 col = base * (0.35 + 0.65 * smoothstep(1.1, 0.0, r));
  // 拍ごとに中心から広がるリング
  float ring = fract(uBeat);
  float w = smoothstep(0.03, 0.0, abs(r - ring * 1.2)) * (1.0 - ring);
  col += mix(uHigh, vec3(1.0), 0.5) * w * (0.3 + 0.7 * k);
  // ゆっくり回る放射状のストライプ（盛り上がるほど強く）
  float a = atan(p.y, p.x);
  float rays = 0.5 + 0.5 * sin(a * 12.0 + uTime * 0.8);
  col += base * rays * 0.25 * k * smoothstep(0.1, 0.8, r);
  col += uPulse * 0.08 * k;
  gl_FragColor = vec4(col, 1.0);
}`;

class Player {
  async load(sceneUrl, opts = {}) {
    const res = u => new URL(u, sceneUrl).href;
    this.scene = await (await fetch(sceneUrl)).json();
    const S = this.scene;
    this.width = opts.width ?? S.width ?? 1280;
    this.height = opts.height ?? S.height ?? 720;
    this.fps = S.fps ?? 30;
    this.analysis = await (await fetch(res(S.analysis))).json();
    this.sections = buildSections(S, this.analysis);
    this.duration = S.duration ?? this.analysis.duration;
    this.frameCount = Math.ceil(this.duration * this.fps);
    this.audioUrl = S.audio ? res(S.audio) : null;

    const canvas = document.getElementById('mv');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.autoClear = false;

    this.three = new THREE.Scene();
    const cam = S.camera || {};
    this.camCfg = { position: [0, 1.35, 2.4], target: [0, 1.15, 0], fov: 30, beatZoom: 0.04, orbit: 0.25, ...cam };
    this.camera = new THREE.PerspectiveCamera(this.camCfg.fov, this.width / this.height, 0.1, 50);
    // ショット: camera.shots に時刻ごとのカメラを並べると、その時刻で切り替わる（at の書き方は HTML の data-start と同じ）
    const tctx = { analysis: this.analysis, sections: this.sections, duration: this.duration };
    this.shots = (cam.shots || []).map(s => ({ ...s, start: parseTime(s.at, tctx) ?? 0 })).sort((a, b) => a.start - b.start);
    this.shots.forEach((s, k) => { s.end = s.dur != null ? s.start + s.dur : (this.shots[k + 1]?.start ?? this.duration); });

    // 組み込みのシェーダー背景（scene.background を書いたときだけ）。HTMLで背景を書くなら不要
    this.useShaderBg = !!S.background;
    const bg = S.background || {};
    this.bgUniforms = {
      uTime: { value: 0 }, uBeat: { value: 0 }, uPulse: { value: 0 }, uEnergy: { value: 1 },
      uAspect: { value: this.width / this.height },
      uLow: { value: new THREE.Color(bg.low ?? '#1d1b3a') }, uHigh: { value: new THREE.Color(bg.high ?? '#ff4d8d') },
    };
    this.bgScene = new THREE.Scene();
    const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: BG_VERT, fragmentShader: BG_FRAG, uniforms: this.bgUniforms, depthWrite: false, depthTest: false }));
    bgMesh.frustumCulled = false;
    this.bgScene.add(bgMesh);
    this.bgCamera = new THREE.Camera();

    // HTML/CSS のレイヤー（背景・文字・図）。place: "back" はキャラの後ろ、"front" は手前
    this.html = null;
    if (S.layers?.length) {
      this.html = new HtmlLayers();
      const sceneW = S.width ?? 1280, sceneH = S.height ?? 720;
      await this.html.load({
        layers: S.layers, styles: S.styles, baseUrl: sceneUrl, runtimeCss: new URL('./mv.css', import.meta.url).href,
        width: sceneW, height: sceneH, outWidth: this.width, outHeight: this.height,
        ctx: { analysis: this.analysis, sections: this.sections, duration: this.duration },
      });
      this.overlay = { back: new THREE.Scene(), front: new THREE.Scene() };
      for (const l of this.html.layers) {
        l.texture = new THREE.CanvasTexture(l.canvas);
        l.texture.colorSpace = THREE.NoColorSpace; // 変換せずそのまま出す
        l.texture.minFilter = l.texture.magFilter = THREE.LinearFilter;
        l.texture.generateMipmaps = false;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
          uniforms: { map: { value: l.texture } },
          vertexShader: BG_VERT,
          // canvas の色は sRGB のまま出力したいので、three の色変換を通さずそのまま書く
          fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv); }',
          transparent: true, depthWrite: false, depthTest: false,
        }));
        mesh.frustumCulled = false;
        mesh.renderOrder = this.overlay[l.place === 'back' ? 'back' : 'front'].children.length;
        this.overlay[l.place === 'back' ? 'back' : 'front'].add(mesh);
      }
    }

    // 床（拍で光る円盤）
    // "floor": false で消せる。{ color, glow, radius } で見た目を変えられる
    const fl = S.floor === false ? null : { color: '#222233', glow: bg.high ?? '#ff4d8d', radius: 1.2, ...(S.floor || {}) };
    this.floorMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(fl?.color ?? '#222233'), emissive: new THREE.Color(fl?.glow ?? '#ff4d8d'), emissiveIntensity: 0, roughness: 0.6 });
    if (fl) {
      const floor = new THREE.Mesh(new THREE.CircleGeometry(fl.radius, 64), this.floorMat);
      floor.rotation.x = -Math.PI / 2;
      this.three.add(floor);
    }

    // 照明: "light": { color, intensity, ambient, rim }。セクションに "light": "#色" を書くとキーライトの色がそこで変わる
    this.lightCfg = { color: '#ffffff', intensity: 2.2, ambient: 0.6, rim: null, ...(S.light || {}) };
    this.key = new THREE.DirectionalLight(new THREE.Color(this.lightCfg.color), this.lightCfg.intensity);
    this.key.position.set(1, 2, 2);
    this.ambient = new THREE.AmbientLight(0xffffff, this.lightCfg.ambient);
    this.three.add(this.key, this.ambient);
    if (this.lightCfg.rim) {
      this.rim = new THREE.DirectionalLight(new THREE.Color(this.lightCfg.rim), this.lightCfg.rimIntensity ?? 2.5);
      this.rim.position.set(-1.5, 2.5, -2);
      this.three.add(this.rim);
    }
    this._ca = new THREE.Color(); this._cb = new THREE.Color();

    // キャラ
    const ch = S.character || {};
    this.motions = (ch.motions || [{ use: 'idle' }]).map(m => ({ fn: behaviors[m.use], opts: m, state: {} }));
    for (const m of this.motions) if (!m.fn) throw new Error(`unknown motion: ${m.opts.use}`);
    if (ch.vrm) {
      const loader = new GLTFLoader();
      loader.register(p => new VRMLoaderPlugin(p));
      const gltf = await loader.loadAsync(res(ch.vrm));
      const vrm = gltf.userData.vrm;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
      vrm.scene.traverse(o => { o.frustumCulled = false; });
      vrm.scene.position.fromArray(ch.position ?? [0, 0, 0]);
      if (vrm.lookAt) vrm.lookAt.target = this.camera;
      this.three.add(vrm.scene);
      this.vrm = vrm;
      // "smoothing": 秒。全ボーンをこの時定数で遅らせて追従させる（動きの角が取れて、重さが出る）。0 で無効
      this.smoothing = ch.smoothing ?? 0;
      this.smoothNodes = Object.keys(vrm.humanoid.humanBones).map(n => vrm.humanoid.getNormalizedBoneNode(n)).filter(Boolean)
        .map(node => ({ node, q: node.quaternion.clone(), p: node.position.clone() }));
      this.expressionNames = vrm.expressionManager ? vrm.expressionManager.expressions.map(e => e.expressionName) : [];
      // Mixamo のモーション（{ "use": "mixamo", "file": "..." }）は先に読み込んで変換しておく
      // 動きの中の拍も調べておき、曲の拍・小節頭に合わせて再生できるようにする
      this.mixamoInfo = [];
      const downbeat0 = musicAt(this.analysis.downbeats[0] ?? 0, this.analysis, this.sections).steadyBeat;
      // ライブラリの動き（{ "use": "clip", "motion": "<id>" }）は一覧から VRMA とメタデータの場所を引く
      // 一覧は scene.json の motionLibraries（scene.json からの相対パス）、なければ assets/open-vrma/
      let library = null;
      const getText = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.text(); };
      for (const mo of this.motions) {
        if (mo.opts.use !== 'mixamo' && mo.opts.use !== 'clip') continue;
        if (mo.opts.use === 'clip') {
          let url = mo.opts.file ? res(mo.opts.file) : null, meta = null;
          if (mo.opts.motion) {
            library ??= await loadLibrary((S.motionLibraries ?? [new URL('../assets/open-vrma/', import.meta.url).href]).map(u => ({ url: res(u) })), getText);
            const row = library.find(mo.opts.motion);
            if (!row) throw new Error(`motion "${mo.opts.motion}" が一覧にありません（node src/motions.mjs search で探す）`);
            url = row.url;
            meta = await library.meta(mo.opts.motion);
          } else if (url) meta = await getText(url.replace(/\.vrma$/i, '.motion.json')).then(JSON.parse, () => null);
          if (!url) throw new Error('clip には motion（id）か file を書く');
          try { mo.state.clip = /\.fbx$/i.test(url) ? await loadMixamo(url, vrm) : await loadVrma(url, vrm); }
          catch (e) { throw new Error(`${mo.opts.motion ?? mo.opts.file} を読めません（${e.message}）${mo.opts.motion ? `。node src/motions.mjs pull ${mo.opts.motion} で取ってくる` : ''}`); }
          mo.state.meta = meta;
          if (meta?.loop) mo.state.loopRange = [meta.loop.in, meta.loop.out];
          if (meta) mo.state.loop = !!meta.loop;   // ループ区間の無い動きは、既定では1回だけ再生する
          const st = meta?.allow?.stretch;
          if (st?.mode === 'none') mo.state.sync = 'time';
          if (st?.allowHalfDouble === false) mo.state.halfDouble = false;
          mo.state.info = infoFromMeta(meta, mo.state.clip.duration) ?? analyzeMotion(mo.state.clip, vrm);
        } else {
          mo.state.clip = await loadMixamo(res(mo.opts.file), vrm);
          mo.state.info = analyzeMotion(mo.state.clip, vrm);
        }
        mo.state.barOffset = ((downbeat0 % 4) + 4) % 4;
        mo.state.sections = this.sections;
        const { bpm, beats, phase, barPhase, strength, travel } = mo.state.info;
        this.mixamoInfo.push({ file: mo.opts.motion ?? mo.opts.file, meta: !!mo.state.meta, duration: +mo.state.clip.duration.toFixed(2), bpm: +bpm.toFixed(1), beats, phase: +phase.toFixed(3), barPhase: +barPhase.toFixed(3), ...(strength != null ? { strength: +strength.toFixed(2), travel: +travel.toFixed(2) } : {}) });
      }
    }
    this.renderer.compile(this.three, this.camera);
    this.next = 0;
    return { width: this.width, height: this.height, fps: this.fps, frameCount: this.frameCount, duration: this.duration, audio: this.audioUrl, expressions: this.expressionNames ?? [], mixamo: this.mixamoInfo ?? [], sections: this.sections.map(s => `${s.from}s ${s.name}`) };
  }

  // フレーム i を描く。SpringBone などの物理は前フレームからの積み上げなので、必ず 0 から順に呼ぶ。
  // draw: false なら動きや状態だけ進めて描かない（途中から書き出すとき、そこまでを早送りして同じ状態にするため）
  async frame(i, draw = true) {
    if (i !== this.next) throw new Error(`frames must be sequential: expected ${this.next}, got ${i}`);
    this.next++;
    const dt = 1 / this.fps, t = i * dt;
    const m = musicAt(t, this.analysis, this.sections);
    const vrm = this.vrm;
    if (vrm) {
      vrm.humanoid.resetNormalizedPose();
      const em = vrm.expressionManager;
      if (em) {
        em.resetValues();
        for (const [k, v] of Object.entries(m.expression)) if (em.getExpression(k)) em.setValue(k, v);
      }
      for (const { fn, opts, state } of this.motions) {
        // "only": ["chorus"] / "except": [...] でセクションを絞れる（境目は energy を混ぜてなめらかに）
        if (!opts.only && !opts.except) { fn(vrm, m, opts, state); continue; }
        const on = s => !!s && (opts.only ? opts.only.includes(s.name) : !opts.except.includes(s.name));
        const cur = this.sections[m.sectionIndex], prev = this.sections[m.sectionIndex - 1] ?? cur;
        const w = (on(prev) ? 1 : 0) * (1 - m.sectionBlend) + (on(cur) ? 1 : 0) * m.sectionBlend;
        if (w > 0) fn(vrm, { ...m, energy: m.energy * w, weight: w }, opts, state);
      }
      if (this.smoothing > 0) this.smoothPose(i === 0 || this.jumped ? 1 : 1 - Math.exp(-dt / this.smoothing));
      this.jumped = false;
      vrm.update(i === 0 ? 0 : dt);
    }
    // カメラ: 拍でわずかに寄り、盛り上がるとゆっくり回り込む
    const c = this.shotAt(t), target = new THREE.Vector3(...c.target);
    const off = new THREE.Vector3(...c.position).sub(target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 0.35) * c.orbit * Math.max(0, m.energy - 0.5));
    off.multiplyScalar(1 - c.beatZoom * m.beatPulse * m.energy);
    this.camera.position.copy(target).add(off);
    this.camera.lookAt(target);
    if (c.roll) this.camera.rotateZ(c.roll * Math.PI / 180);
    if (this.camera.fov !== c.fov) { this.camera.fov = c.fov; this.camera.updateProjectionMatrix(); }
    // 背景と照明
    Object.assign(this.bgUniforms.uTime, { value: t });
    this.bgUniforms.uBeat.value = m.beatPos;
    this.bgUniforms.uPulse.value = m.beatPulse;
    this.bgUniforms.uEnergy.value = m.energy;
    this.floorMat.emissiveIntensity = m.beatPulse * 0.6 * m.energy;
    this.key.intensity = this.lightCfg.intensity - 0.2 + m.beatPulse * 0.6 * m.energy;
    const cur = this.sections[m.sectionIndex], prev = this.sections[m.sectionIndex - 1] ?? cur;
    this._ca.set(prev?.light ?? this.lightCfg.color); this._cb.set(cur?.light ?? this.lightCfg.color);
    this.key.color.copy(this._ca).lerp(this._cb, m.sectionBlend ?? 1);

    if (this.html) {
      await this.html.update(m, draw);
      for (const l of this.html.layers) if (l.dirty) { l.texture.needsUpdate = true; l.dirty = false; }
    }

    if (!draw) {
      // 描くときは renderer.render の中で行列が更新され、次のフレームの物理がそれを使うので、ここでも同じことをする
      this.three.updateMatrixWorld();
      this.camera.updateMatrixWorld();
      return m;
    }
    this.renderer.setClearColor(this.scene.clearColor ?? '#000000', 1);
    this.renderer.clear();
    if (this.useShaderBg) this.renderer.render(this.bgScene, this.bgCamera);
    if (this.overlay) this.renderer.render(this.overlay.back, this.bgCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.three, this.camera);
    if (this.overlay) this.renderer.render(this.overlay.front, this.bgCamera);
    return m;
  }

  // 前フレームの姿勢から今の目標姿勢へ a の割合だけ近づける（a=1 でそのまま）
  smoothPose(a) {
    for (const b of this.smoothNodes) {
      b.q.slerp(b.node.quaternion, a); b.node.quaternion.copy(b.q);
      b.p.lerp(b.node.position, a); b.node.position.copy(b.p);
    }
  }

  // 時刻 t のカメラ設定。ショットの中では position/target/fov/roll から to.* へ ease で動く
  shotAt(t) {
    const base = this.camCfg;
    let k = -1;
    for (let j = 0; j < this.shots.length; j++) if (this.shots[j].start <= t) k = j;
    if (k < 0) return base;
    const s = this.shots[k], a = { ...base, roll: 0, ...s };
    if (!s.to) return a;
    const p = Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start)));
    const e = s.ease === 'linear' ? p : s.ease === 'out' ? 1 - (1 - p) ** 3 : p * p * (3 - 2 * p);
    const lerp = (x, y) => (Array.isArray(x) ? x.map((v, i) => v + (y[i] - v) * e) : x + (y - x) * e);
    for (const key of ['position', 'target', 'fov', 'roll']) if (s.to[key] != null) a[key] = lerp(a[key], s.to[key]);
    return a;
  }

  // プレビュー用: 物理の積み上げを諦めて任意フレームへ飛ぶ
  jump(i) { this.next = Math.max(0, Math.min(i, this.frameCount - 1)); this.jumped = true; }

  // 現在の描画結果を RGBA（下から上の行順）で返す
  pixels() {
    const gl = this.renderer.getContext();
    const buf = this.buf ??= new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  // 書き出し用: start..end-1 を描き、生の RGBA（下から上の行順）を WebSocket で書き出し側へ順に送る。
  // page.evaluate の戻り値で返すと base64 文字列の受け渡しだけで 1 フレーム 40ms ほどかかるため。
  // GPU からの読み出しは PBO で非同期にし（前のフレームを受け取るあいだに次を描く）、
  // 受け取り側の返事を待たずに inflight 枚まで先に描き進める（送信と描画を重ねる）。
  // start が途中なら、そこまでは描かずに状態だけ進める（並列書き出しで、0 から書いたときと同じ絵にするため）
  async streamTo(url, start, end, inflight = 3) {
    while (this.next < start) await this.frame(this.next, false);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = () => ng(new Error(`cannot connect ${url}`)); });
    // 返事（1フレームにつき1つ）が n 個そろうまで待つ
    let acked = 0, sent = 0, wake = null;
    ws.onmessage = () => { acked++; wake?.(); };
    const until = async n => { while (acked < n) await new Promise(r => (wake = r)); };

    const gl = this.renderer.getContext(), size = this.width * this.height * 4;
    const pbos = [0, 1].map(() => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      return { b, fence: null };
    });
    const sendPbo = async p => {
      // fence が済んだのを確かめてから読む（確かめずに読むと Chromium の読み出し用の写しが使われず、遅くなる）
      while (gl.clientWaitSync(p.fence, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise(r => setTimeout(r, 0));
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.b);
      const px = new Uint8Array(size);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(p.fence); p.fence = null;
      ws.send(px);
      await until(++sent - inflight);
    };
    for (let i = start; i < end; i++) {
      await this.frame(i);
      const p = pbos[i & 1];
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.b);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      p.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const prev = pbos[(i + 1) & 1];
      if (prev.fence) await sendPbo(prev);
    }
    const last = pbos[(end - 1) & 1];
    if (last.fence) await sendPbo(last);
    await until(end - start);
    for (const p of pbos) gl.deleteBuffer(p.b);
    ws.close();
  }
}

window.MV = new Player();
window.MV_READY = true;
