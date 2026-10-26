#!/usr/bin/env python3
"""歌詞テキストを音源に合わせ、単語ごとの時刻を JSON に書き出す（強制アライメント）。

Whisper を手元で動かすだけなので API キーや有料サービスは不要。初回だけモデルをダウンロードする。

準備（初回のみ）:
    python3 -m venv .venv && .venv/bin/pip install stable-ts
    .venv/bin/pip install demucs          # --separate を使うときだけ（ボーカルを抜き出してから合わせる。精度が上がる）

使い方:
    .venv/bin/python tools/align_lyrics.py song.mp3 lyrics.txt aligned.json [--model medium] [--language en] [--separate]

出力: {"words": [{"text", "start", "end"}], "model", "language"}
→ node src/lyrics.mjs build lyrics.txt --timing aligned.json で lyrics.json にする（prepare.mjs なら自動）。
"""
import argparse
import json
import re
import sys


def lyric_lines(path):
    """[Verse] などの見出しと空行を除いた歌詞の行"""
    with open(path, encoding="utf-8") as f:
        lines = [l.strip() for l in f]
    return [l for l in lines if l and not re.fullmatch(r"\[[^\]]+\]", l)]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio")
    p.add_argument("lyrics")
    p.add_argument("output")
    p.add_argument("--model", default="medium", help="tiny / base / small / medium / large-v3（大きいほど正確で遅い）")
    p.add_argument("--language", default=None, help="en / ja など。省略時は歌詞の文字から推定（かな・漢字があれば ja、無ければ en）")
    p.add_argument("--separate", action="store_true", help="demucs でボーカルを抜き出してから合わせる")
    p.add_argument("--device", default=None, help="cpu / cuda（省略時は自動）")
    a = p.parse_args()

    try:
        import stable_whisper
    except ImportError:
        sys.exit("stable-ts が入っていません: pip install stable-ts")

    text = "\n".join(lyric_lines(a.lyrics))
    if not text:
        sys.exit("歌詞が空です")
    model = stable_whisper.load_model(a.model, device=a.device)
    lang = a.language or ("ja" if re.search(r"[\u3040-\u30ff\u4e00-\u9fff]", text) else "en")
    kw = dict(language=lang, original_split=True)
    if a.separate:
        kw["denoiser"] = "demucs"
    print(f"aligning with whisper-{a.model}{' + demucs' if a.separate else ''} ...", file=sys.stderr)
    result = model.align(a.audio, text, **kw)
    if result is None:
        sys.exit("合わせられませんでした。--separate や --model large-v3 を試してください")

    words = []
    for seg in result.segments:
        for w in seg.words:
            t = w.word.strip()
            if t:
                words.append({"text": t, "start": round(float(w.start), 3), "end": round(float(w.end), 3)})
    with open(a.output, "w", encoding="utf-8") as f:
        json.dump({"words": words, "model": a.model, "language": lang}, f, ensure_ascii=False, indent=1)
    print(f"{len(words)} words -> {a.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
