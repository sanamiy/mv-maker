# mv-maker で作業するエージェントへ

- MVを作る・直すときは、`.claude/skills/make-mv/SKILL.md` の手順に従う（Claude Code ではスキル `make-mv` として読み込まれる）。
- 1曲 = `songs/<名前>/` の1フォルダ。曲の作業ではそのフォルダの中だけを変更し、出力はその中の `out/` に置く。
- 書き出しが通っただけでは完成ではない。`node src/check.mjs` がエラー0で、コマ一覧（`out/contact.png`）を見て
  `out/qa.md` の目視チェックを埋め、音の確認を依頼者に頼むまでが1本の制作。
- 曲・歌詞・VRM・モーション素材はコミットしない（`docs/assets.md`）。
- Node.js 24 以上。書き方の決まりは README の「書き方」。

## 書き出しはどこでするか

- **本番の書き出し（`node src/render.mjs` で曲全体）は、GPU のある実機（利用者の Mac / Windows、レンダリング用の PC など）で行う。**
  Mac は Metal、Windows は Direct3D 11 で描くので、3 分ほどの曲が数分で書き出せる。
- **GPU の無いクラウド環境では本番の書き出しをしない。** CPU（SwiftShader）で描くと 3 分の曲で 1 時間ほどかかる。
  `render.mjs` も GPU が無いと分かると 10 秒を超える書き出しを止める（`--allow-cpu` を付ければ続けるが、使わない）。
- クラウドでしてよいのは次のような軽い確認だけ:
  - 静止画の一覧: `node src/stills.mjs scene.json out/sheet.png --every 4`
  - 10 秒までの短い確認: `node src/render.mjs scene.json out/quick.mp4 --frames 300 --scale 0.5`
- クラウドで作業したときは、シーンの変更を push したうえで、GPU のある実機での書き出しコマンドを利用者に伝える。
