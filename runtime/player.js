// シーン定義を読み込み、フレーム番号を1つずつ進めて canvas に描く。
// 実時間には一切依存しない（Date / performance.now / requestAnimationFrame を使わない）ので、
// 何度書き出しても同じ映像になる。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { buildSections, musicAt } from './timeline.js';
import { behaviors } from './behaviors.js';
import { HtmlLayers, parseTime } from './layers.js';
import { loadMixamo } from './mixamo.js';

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
      for (const mo of this.motions) if (mo.opts.use === 'mixamo') mo.state.clip = await loadMixamo(res(mo.opts.file), vrm);
    }
    this.renderer.compile(this.three, this.camera);
    this.next = 0;
    return { width: this.width, height: this.height, fps: this.fps, frameCount: this.frameCount, duration: this.duration, audio: this.audioUrl, expressions: this.expressionNames ?? [], sections: this.sections.map(s => `${s.from}s ${s.name}`) };
  }

  // フレーム i を描く。SpringBone などの物理は前フレームからの積み上げなので、必ず 0 から順に呼ぶ。
  async frame(i) {
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
      await this.html.update(m);
      for (const l of this.html.layers) if (l.dirty) { l.texture.needsUpdate = true; l.dirty = false; }
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

  // 書き出し用: n フレーム進めて、まとめて base64 で返す（往復回数を減らすため）
  async renderBatch(start, n) {
    const parts = [];
    for (let i = start; i < Math.min(start + n, this.frameCount); i++) { await this.frame(i); parts.push(new Blob([this.pixels()])); }
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(parts)); });
    return url.slice(url.indexOf(',') + 1);
  }
}

window.MV = new Player();
window.MV_READY = true;
