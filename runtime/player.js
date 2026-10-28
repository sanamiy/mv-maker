// シーン定義を読み込み、フレーム番号を1つずつ進めて canvas に描く。
// 実時間には一切依存しない（Date / performance.now / requestAnimationFrame を使わない）ので、
// 何度書き出しても同じ映像になる。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { buildSections, musicAt } from './timeline.js';
import { behaviors } from './behaviors.js';
import { HtmlLayers } from './layers.js';

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
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0x222233, emissive: new THREE.Color(bg.high ?? '#ff4d8d'), emissiveIntensity: 0, roughness: 0.6 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.2, 64), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.three.add(floor);

    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.position.set(1, 2, 2);
    this.three.add(this.key, new THREE.AmbientLight(0xffffff, 0.6));

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
      this.expressionNames = vrm.expressionManager ? vrm.expressionManager.expressions.map(e => e.expressionName) : [];
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
      for (const { fn, opts, state } of this.motions) fn(vrm, m, opts, state);
      vrm.update(i === 0 ? 0 : dt);
    }
    // カメラ: 拍でわずかに寄り、盛り上がるとゆっくり回り込む
    const c = this.camCfg, target = new THREE.Vector3(...c.target);
    const off = new THREE.Vector3(...c.position).sub(target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 0.35) * c.orbit * Math.max(0, m.energy - 0.5));
    off.multiplyScalar(1 - c.beatZoom * m.beatPulse * m.energy);
    this.camera.position.copy(target).add(off);
    this.camera.lookAt(target);
    // 背景と照明
    Object.assign(this.bgUniforms.uTime, { value: t });
    this.bgUniforms.uBeat.value = m.beatPos;
    this.bgUniforms.uPulse.value = m.beatPulse;
    this.bgUniforms.uEnergy.value = m.energy;
    this.floorMat.emissiveIntensity = m.beatPulse * 0.6 * m.energy;
    this.key.intensity = 2.0 + m.beatPulse * 0.6 * m.energy;

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

  // プレビュー用: 物理の積み上げを諦めて任意フレームへ飛ぶ
  jump(i) { this.next = Math.max(0, Math.min(i, this.frameCount - 1)); }

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
