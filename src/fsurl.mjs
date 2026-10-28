import path from 'node:path';
// ブラウザからはローカルファイルを http://mv.local/@fs/<絶対パス> として見せる
export const ORIGIN = 'http://mv.local';
export const toUrl = p => `${ORIGIN}/@fs${path.resolve(p).split(path.sep).map(encodeURIComponent).join('/')}`;
export const fromUrl = u => decodeURIComponent(new URL(u).pathname.replace(/^\/@fs/, ''));
export const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
