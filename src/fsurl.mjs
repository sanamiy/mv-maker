import path from 'node:path';
// ブラウザからはローカルファイルを http://mv.local/@fs/<絶対パス> として見せる
// （Windows の C:\a\b は /@fs/C%3A/a/b、Mac / Linux の /a/b は /@fs/a/b）
export const ORIGIN = 'http://mv.local';
export const fsPath = p => '/@fs/' + path.resolve(p).split(path.sep).filter((s, i) => i > 0 || s).map(encodeURIComponent).join('/');
export const fsFile = pathname => { const rest = pathname.slice('/@fs/'.length).split('/').map(decodeURIComponent).join(path.sep); return path.isAbsolute(rest) ? rest : path.sep + rest; };
export const toUrl = p => ORIGIN + fsPath(p);
export const fromUrl = u => fsFile(new URL(u).pathname);
export const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
