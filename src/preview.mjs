// ブラウザで確認するための簡易サーバー。
// 使い方: node src/preview.mjs examples/demo/scene.json → 表示された URL を開く
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, fsPath } from './server.mjs';
import { ensureSceneMotions } from './motions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scene = path.resolve(process.argv[2] || 'examples/demo/scene.json');
await ensureSceneMotions(scene);
const { port } = await startServer({ port: 5173 }); // 使用中なら次の番号を使う
console.log(`http://localhost:${port}${fsPath(path.join(ROOT, 'runtime/preview.html'))}?scene=${encodeURIComponent(fsPath(scene))}`);
