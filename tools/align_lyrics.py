#!/usr/bin/env python3
"""歌詞テキストを音源に合わせ、単語ごとの時刻を JSON に書き出す（強制アライメント）。

合わせ処理は「バックエンド」として差し替えられる。今あるもの:
  stable-ts  Whisper（OpenAI の公開モデル）を手元で動かす。既定。API キー不要、初回にモデルをダウンロード
  command    任意の外部コマンドに任せる。{audio} {lyrics} {output} を置き換えて実行し、
             output に {"words": [{"text","start","end"}]} を書いてもらう（他の言語・他のモデルを試すとき用）

新しいモデルを足すときは、下の BACKENDS に「(audio, lines, args) → [{"text","start","end"}]」の関数を1つ追加する。
出力の形さえ同じなら、後段（src/lyrics.mjs）は何も変えずに使える。

準備（stable-ts を使うとき、初回のみ）:
    python3 -m venv .venv && .venv/bin/pip install stable-ts
    .venv/bin/pip install demucs          # --separate を使うときだけ（ボーカルを抜き出してから合わせる）

使い方:
    .venv/bin/python tools/align_lyrics.py song.mp3 lyrics.txt aligned.json [--model small] [--language en] [--separate]
    .venv/bin/python tools/align_lyrics.py song.mp3 lyrics.txt aligned.json --backend command --command "my-aligner {audio} {lyrics} {output}"

出力: {"words": [{"text", "start", "end"}], "backend", "model", "language"}
→ node src/lyrics.mjs build lyrics.txt --timing aligned.json で lyrics.json にする（prepare.mjs なら自動）。
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile


def lyric_lines(path):
    """[Verse] などの見出しと空行を除いた歌詞の行"""
    with open(path, encoding="utf-8") as f:
        lines = [l.strip() for l in f]
    return [l for l in lines if l and not re.fullmatch(r"\[[^\]]+\]", l)]


def guess_language(text):
    return "ja" if re.search(r"[぀-ヿ一-鿿]", text) else "en"


def align_stable_ts(audio, lines, a):
    try:
        import stable_whisper
    except ImportError:
        sys.exit("stable-ts が入っていません: pip install stable-ts")
    text = "\n".join(lines)
    model = stable_whisper.load_model(a.model or "small", device=a.device)
    kw = dict(language=a.language, original_split=True)
    if a.separate:
        kw["denoiser"] = "demucs"
    result = model.align(audio, text, **kw)
    if result is None:
        sys.exit("合わせられませんでした。--separate や --model medium を試してください")
    return [
        {"text": w.word.strip(), "start": float(w.start), "end": float(w.end)}
        for seg in result.segments for w in seg.words if w.word.strip()
    ]


def align_command(audio, lines, a):
    if not a.command:
        sys.exit('--backend command には --command "コマンド {audio} {lyrics} {output}" が必要です')
    with tempfile.TemporaryDirectory() as d:
        lyrics, output = os.path.join(d, "lyrics.txt"), os.path.join(d, "out.json")
        with open(lyrics, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        cmd = [part.format(audio=audio, lyrics=lyrics, output=output, language=a.language) for part in shlex.split(a.command)]
        subprocess.run(cmd, check=True)
        with open(output, encoding="utf-8") as f:
            j = json.load(f)
    words = j.get("words") or [w for s in j.get("segments", []) for w in s.get("words", [])]
    return [{"text": str(w.get("text", w.get("word", ""))).strip(), "start": float(w["start"]), "end": float(w["end"])} for w in words]


BACKENDS = {
    "stable-ts": align_stable_ts,
    "command": align_command,
}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio")
    p.add_argument("lyrics")
    p.add_argument("output")
    p.add_argument("--backend", default=os.environ.get("MV_ALIGN_BACKEND", "stable-ts"), choices=sorted(BACKENDS))
    p.add_argument("--model", default=None, help="バックエンドのモデル名。stable-ts なら tiny / base / small（既定）/ medium / large-v3")
    p.add_argument("--language", default=None, help="en / ja など。省略時は歌詞の文字から推定（かな・漢字があれば ja、無ければ en）")
    p.add_argument("--separate", action="store_true", help="demucs でボーカルを抜き出してから合わせる（stable-ts）")
    p.add_argument("--device", default=None, help="cpu / cuda / mps（省略時は自動）")
    p.add_argument("--command", default=None, help="--backend command で実行するコマンド")
    a = p.parse_args()

    lines = lyric_lines(a.lyrics)
    if not lines:
        sys.exit("歌詞が空です")
    a.language = a.language or guess_language("\n".join(lines))
    print(f"aligning with {a.backend}{f' ({a.model})' if a.model else ''}{' + demucs' if a.separate else ''} ...", file=sys.stderr)
    words = [
        {"text": w["text"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
        for w in BACKENDS[a.backend](a.audio, lines, a) if w["text"]
    ]
    with open(a.output, "w", encoding="utf-8") as f:
        json.dump({"words": words, "backend": a.backend, "model": a.model, "language": a.language}, f, ensure_ascii=False, indent=1)
    print(f"{len(words)} words -> {a.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
