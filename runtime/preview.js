// ブラウザでの確認用。音声を再生し、その再生位置に合わせてフレームを進める。
// 書き出し（render.mjs）とは違い実時間に追従するので、遅いPCではコマ落ちする。
const sceneUrl = new URL(new URLSearchParams(location.search).get('scene'), location.href).href;
await new Promise(r => (window.MV_READY ? r() : setTimeout(r, 0)));
const info = await window.MV.load(sceneUrl);
const canvas = document.getElementById('mv');
Object.assign(canvas.style, { width: '100vw', height: `${100 * info.height / info.width}vw`, maxHeight: '100vh', objectFit: 'contain' });
const audio = new Audio(info.audio);
const hint = Object.assign(document.createElement('div'), { textContent: 'クリックで再生 / 一時停止、←→で5秒移動' });
Object.assign(hint.style, { position: 'fixed', left: '12px', bottom: '12px', color: '#fff', font: '14px sans-serif', opacity: 0.7 });
document.body.append(hint);
addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
addEventListener('keydown', e => { if (e.key === 'ArrowRight') audio.currentTime += 5; if (e.key === 'ArrowLeft') audio.currentTime -= 5; });
await window.MV.frame(0);
(async function loop() {
  const target = Math.min(info.frameCount - 1, Math.floor(audio.currentTime * info.fps));
  const mv = window.MV;
  if (target < mv.next - 1 || target - mv.next > 15) mv.jump(target);
  while (mv.next <= target) await mv.frame(mv.next);
  requestAnimationFrame(loop);
})();
