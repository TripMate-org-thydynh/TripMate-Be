# -*- coding: utf-8 -*-
"""Nghe tiếng + đọc chữ trên hình của video du lịch → sự kiện chi tiết.

Vì sao cần: caption chỉ nêu tên quán. Giá vé, giờ mở cửa, lịch trình từng
ngày đều nằm trong **lời nói** hoặc **chữ cháy lên hình**, không có ở đâu
trong metadata. Reelforge không đọc cả hai — `dissector.py:110` gán thẳng
`transcript = caption` nên trường "transcript" của nó chỉ là caption chép lại.

Cách làm: tải video → tách audio → cắt vài khung hình → đưa **cả audio lẫn
hình** cho Gemini trong MỘT lời gọi, rồi ép ra JSON sự kiện.

Vẫn chỉ lấy SỰ KIỆN, không chép nguyên văn lời người ta nói.

Đi chậm có chủ ý: TikTok khoá IP sau khoảng 10 lượt tải liên tiếp.
"""
import base64
import io
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

MODEL = "gemini-3.8-flash"
FRAMES = 5
MAX_AUDIO_MB = 18
# Nghỉ giữa các video. TikTok chặn theo nhịp chứ không theo tổng số.
PAUSE_S = (8, 15)


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )


def download(url: str, workdir: Path) -> Path | None:
    """Tải video về. Giới hạn chất lượng cho nhẹ — ta cần nội dung, không cần nét."""
    out = workdir / "v.mp4"
    for i in range(3):
        if i:
            time.sleep(2 ** i + random.uniform(0, 2))
        r = _run(
            ["yt-dlp", "--no-warnings", "--ignore-config",
             "-f", "mp4", "-o", str(out), url],
            timeout=240,
        )
        if out.exists() and out.stat().st_size > 0:
            return out
        print(f"  … tải lại {i + 1}/3: {(r.stderr or '')[:120]}", file=sys.stderr)
    return None


def to_audio(video: Path) -> Path | None:
    """Tách audio mono 16kHz — đủ cho nhận dạng tiếng nói, nhẹ hơn nhiều."""
    out = video.with_suffix(".m4a")
    r = _run(
        ["ffmpeg", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "48k", str(out)],
        timeout=180,
    )
    if out.exists() and out.stat().st_size > 0:
        if out.stat().st_size > MAX_AUDIO_MB * 1024 * 1024:
            print("  ! audio quá lớn, bỏ qua", file=sys.stderr)
            return None
        return out
    print(f"  ! ffmpeg lỗi: {(r.stderr or '')[-160:]}", file=sys.stderr)
    return None


def keyframes(video: Path, n: int = FRAMES) -> list[Path]:
    """Cắt n khung rải đều. Chữ cháy lên hình thường đổi theo cảnh."""
    dur = 0.0
    p = _run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(video)],
        timeout=60,
    )
    try:
        dur = float((p.stdout or "0").strip())
    except ValueError:
        pass
    if dur <= 0:
        return []
    shots: list[Path] = []
    for i in range(n):
        t = dur * (i + 0.5) / n
        f = video.parent / f"f{i}.jpg"
        _run(["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", str(video),
              "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", str(f)],
             timeout=60)
        if f.exists() and f.stat().st_size > 0:
            shots.append(f)
    return shots


PROMPT = """Bạn phân tích một video du lịch tiếng Việt để rút SỰ KIỆN cho
cẩm nang du lịch.

Bạn nhận được: bản ghi âm của video, và vài khung hình (chữ quan trọng
thường được cháy lên hình: tên quán, giá, giờ mở cửa, địa chỉ).

Quy tắc nghiêm ngặt:
- Chỉ ghi điều video THỰC SỰ nói hoặc hiện chữ. Không suy đoán, không bổ
  sung kiến thức bên ngoài.
- KHÔNG chép nguyên văn lời thuyết minh. Viết lại ngắn gọn bằng lời bạn.
- Giá/giờ chỉ ghi khi nghe thấy con số hoặc nhìn thấy chữ. Không thì để null.
- Không chắc thì để null, đừng đoán bừa.

Trả JSON đúng khuôn:
{
  "places": [
    {
      "name": "tên địa điểm, tiếng Việt có dấu",
      "city": "thành phố/tỉnh hoặc null",
      "address": "địa chỉ nếu video nêu, hoặc null",
      "category": "CAFE|FOOD|STAY|ATTRACTION|ACTIVITY|OTHER",
      "priceVnd": "khoảng giá dạng chữ (vd '50k-80k/người') hoặc null",
      "openHours": "giờ mở cửa hoặc null",
      "tips": ["mẹo ngắn, tối đa 3 cái"],
      "note": "1-2 câu vì sao đáng đến, viết lại bằng lời bạn"
    }
  ],
  "itinerary": [
    {"order": 1, "place": "tên", "timeOfDay": "sáng|trưa|chiều|tối|null",
     "durationHint": "vd '1-2 tiếng' hoặc null"}
  ],
  "totalBudgetHint": "tổng chi phí video nêu, hoặc null",
  "confidence": 0.0
}

`itinerary` chỉ điền khi video thật sự kể một chuỗi đi chơi theo thứ tự.
Video chỉ review một chỗ thì để mảng rỗng."""


def analyze(audio: Path | None, frames: list[Path], key: str,
            caption: str) -> dict | None:
    parts: list[dict] = [{"text": PROMPT + f"\n\nCaption của video: {caption[:400]}"}]
    if audio:
        parts.append({
            "inline_data": {
                "mime_type": "audio/mp4",
                "data": base64.b64encode(audio.read_bytes()).decode(),
            }
        })
    for f in frames:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(f.read_bytes()).decode(),
            }
        })

    body = json.dumps({
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0,
        },
    }).encode()
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"{MODEL}:generateContent?key={key}")
    for i in range(3):
        if i:
            time.sleep(2 ** i)
        try:
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                out = json.load(r)
            return json.loads(out["candidates"][0]["content"]["parts"][0]["text"])
        except Exception as e:  # noqa: BLE001
            print(f"  … Gemini lỗi {i + 1}/3: {str(e)[:130]}", file=sys.stderr)
    return None


def process(video: dict, key: str) -> list[dict]:
    url = video["url"]
    caption = video.get("title") or ""
    print(f"  ▸ {url[-19:]}  {caption[:44]}")
    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        mp4 = download(url, wd)
        if not mp4:
            print("    bỏ qua: không tải được")
            return []
        audio = to_audio(mp4)
        frames = keyframes(mp4)
        print(f"    audio={'có' if audio else 'không'}  khung hình={len(frames)}")
        res = analyze(audio, frames, key, caption)
    if not res:
        return []

    rows = []
    order = {i["place"]: i for i in (res.get("itinerary") or [])
             if isinstance(i, dict) and i.get("place")}
    for p in res.get("places") or []:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        step = order.get(name) or {}
        rows.append({
            "name": name,
            "city": p.get("city"),
            "address": p.get("address"),
            "category": p.get("category") or "OTHER",
            "priceVnd": p.get("priceVnd"),
            "openHours": p.get("openHours"),
            "tips": [t for t in (p.get("tips") or []) if t][:3],
            "note": (p.get("note") or "").strip(),
            "timeOfDay": step.get("timeOfDay"),
            "durationHint": step.get("durationHint"),
            "totalBudgetHint": res.get("totalBudgetHint"),
            "confidence": res.get("confidence"),
            "sourceUrl": url,
            "sourceAuthor": video.get("author"),
            "views": video.get("views"),
        })
    print(f"    rút được {len(rows)} địa điểm")
    return rows


def load_done(path: str) -> set[str]:
    """URL đã rút xong ở lần chạy trước. Chạy lại không tốn công và không tốn quota."""
    done: set[str] = set()
    try:
        for line in io.open(path, encoding="utf-8"):
            line = line.strip()
            if line:
                done.add(json.loads(line).get("sourceUrl", ""))
    except FileNotFoundError:
        pass
    return done


if __name__ == "__main__":
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        print("Thiếu GEMINI_API_KEY"); sys.exit(1)
    src = json.load(io.open(sys.argv[1], encoding="utf-8"))
    vids = src if isinstance(src, list) else src.get("videos", [])
    dst = sys.argv[2] if len(sys.argv) > 2 else "deep_places.jsonl"
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else len(vids)

    done = load_done(dst)
    todo = [v for v in vids if v.get("url") not in done][:limit]
    print(f"{len(done)} video đã xong trước đó, còn {len(todo)} video lượt này")

    sink = io.open(dst, "a", encoding="utf-8")
    kept = miss = streak = 0
    for idx, v in enumerate(todo):
        rows = process(v, key)
        if rows:
            streak = 0
            for r in rows:
                # Ghi ngay từng dòng: bị chặn giữa chừng vẫn giữ được phần đã làm.
                sink.write(json.dumps(r, ensure_ascii=False) + "\n")
            sink.flush()
            kept += len(rows)
        else:
            miss += 1
            streak += 1
            # Ghi lại cả video hỏng để lần sau không mò lại vô ích... nhưng
            # KHÔNG đánh dấu là xong: hỏng thường do bị chặn, không phải do video.
        if streak >= 3:
            # Ba lần liên tiếp là dấu hiệu bị chặn theo IP, không phải xui.
            cool = 180
            print(f"  ! hỏng {streak} lần liên tiếp — nghỉ {cool}s cho hạ nhiệt",
                  file=sys.stderr)
            time.sleep(cool)
            streak = 0
        if idx < len(todo) - 1:
            time.sleep(random.uniform(*PAUSE_S))
    sink.close()
    print(f"lượt này: +{kept} địa điểm, {miss} video không lấy được → {dst}")
