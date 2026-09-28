# -*- coding: utf-8 -*-
"""Quét kênh TikTok của KOL du lịch → chọn video nổi bật.

Vì sao không dùng trực tiếp adapter của Reelforge: cả ba đường của nó
(`yt-dlp @handle`, TikTok embed, TikWM) đều đã chết — TikTok đổi trang user,
embed trả 400, TikWM trả 403. Đường còn sống là `tiktokuser:<channel_id>`,
và `channel_id` lấy được từ metadata của bất kỳ video nào thuộc kênh đó.
"""
import json
import random
import statistics
import subprocess
import sys
import time
from typing import Any

TIMEOUT_VIDEO = 120
TIMEOUT_CHANNEL = 240


def _ytdlp(
    args: list[str], timeout: int, attempts: int = 3
) -> dict[str, Any] | None:
    """Gọi yt-dlp, thử lại khi TikTok trả lời thất thường.

    TikTok chặn theo nhịp và thỉnh thoảng trả trang rỗng cho đúng URL vừa
    chạy được phút trước. Thử lại có giãn cách là bắt buộc chứ không phải
    cho chắc: một lần hỏng không có nghĩa là video đó không lấy được.
    """
    last = ""
    for i in range(attempts):
        if i:
            time.sleep(2 ** i + random.uniform(0, 1.5))
        res = subprocess.run(
            ["yt-dlp", "--no-warnings", "--ignore-config", *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
        out = (res.stdout or "").strip()
        if out:
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                last = out[:160]
        else:
            last = (res.stderr or "").strip()[:160]
        print(f"  … thử lại {i + 1}/{attempts}: {last}", file=sys.stderr)
    return None


def resolve_channel(video_url: str) -> tuple[str, str] | None:
    """Từ một video bất kỳ → (channel_id, tên hiển thị)."""
    d = _ytdlp(["--dump-json", video_url], TIMEOUT_VIDEO)
    if not d:
        return None
    cid = d.get("channel_id") or d.get("uploader_id")
    return (cid, d.get("channel") or d.get("uploader") or "") if cid else None


def scan_channel(channel_id: str, limit: int = 30) -> list[dict[str, Any]]:
    d = _ytdlp(
        ["--flat-playlist", "--dump-single-json",
         "--playlist-items", f"1-{limit}", f"tiktokuser:{channel_id}"],
        TIMEOUT_CHANNEL,
    )
    if not d:
        return []
    out = []
    for e in d.get("entries") or []:
        # yt-dlp trả None cho mục nó bỏ qua (video đã xoá, riêng tư).
        if not isinstance(e, dict):
            continue
        out.append({
            "id": e.get("id"),
            "url": e.get("url") or f"https://www.tiktok.com/@_/video/{e.get('id')}",
            "title": (e.get("title") or "").strip(),
            "views": e.get("view_count") or 0,
            "duration": e.get("duration"),
        })
    return out


def pick_outliers(videos: list[dict], min_ratio: float = 1.5) -> list[dict]:
    """Video nổi bật = lượt xem vượt hẳn mức thường của chính kênh đó.

    So với trung vị của kênh chứ không so với một ngưỡng tuyệt đối: kênh
    500k follow và kênh 50k follow có mặt bằng khác nhau hoàn toàn.
    """
    seen = [v["views"] for v in videos if v["views"]]
    if len(seen) < 5:
        return sorted(videos, key=lambda v: -v["views"])[:5]
    med = statistics.median(seen)
    for v in videos:
        v["ratio"] = round(v["views"] / med, 2) if med else 0
    hot = [v for v in videos if v.get("ratio", 0) >= min_ratio]
    return sorted(hot, key=lambda v: -v["views"])


if __name__ == "__main__":
    seed = sys.argv[1]
    got = resolve_channel(seed)
    if not got:
        print("Không lấy được channel_id"); sys.exit(1)
    cid, name = got
    print(f"kênh: {name}  channel_id={cid[:24]}…")
    vids = scan_channel(cid, int(sys.argv[2]) if len(sys.argv) > 2 else 30)
    print(f"lấy được {len(vids)} video")
    hot = pick_outliers(vids)
    print(f"nổi bật: {len(hot)}")
    for v in hot[:8]:
        print(f"  x{v.get('ratio','?'):<5} {v['views']:>9,}  {v['title'][:60]}")
