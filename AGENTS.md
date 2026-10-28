# mv-maker で作業するエージェントへ

- MVを作る・直すときは、`.claude/skills/make-mv/SKILL.md` の手順に従う（Claude Code ではスキル `make-mv` として読み込まれる）。
- 1曲 = `songs/<名前>/` の1フォルダ。曲の作業ではそのフォルダの中だけを変更し、出力はその中の `out/` に置く。
- 書き出しが通っただけでは完成ではない。`node src/check.mjs` がエラー0で、コマ一覧（`out/contact.png`）を見て
  `out/qa.md` の目視チェックを埋め、音の確認を依頼者に頼むまでが1本の制作。
- 曲・歌詞・VRM・モーション素材はコミットしない（`docs/assets.md`）。
- Node.js 24 以上。書き方の決まりは README の「書き方」。
