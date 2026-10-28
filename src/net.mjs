// ローカルサーバーを空いているポートで立ち上げる。
// 希望のポートが使用中なら次の番号を順に試すので、複数の曲のプレビューを同時に開ける。
// PORT 環境変数で明示したときはそのポートだけを使う（使用中ならエラー）。
export function listenFree(server, preferred, host = '127.0.0.1', tries = 50) {
  const fixed = process.env.PORT ? Number(process.env.PORT) : null;
  let port = fixed ?? preferred;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      server.once('error', err => {
        if (err.code === 'EADDRINUSE' && fixed == null && port < preferred + tries) { port++; attempt(); } else reject(err);
      });
      server.listen(port, host, () => resolve(port));
    };
    attempt();
  });
}
