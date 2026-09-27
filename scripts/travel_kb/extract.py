# -*- coding: utf-8 -*-
"""Caption video du lịch → sự kiện có cấu trúc cho kho tri thức.

**Chỉ lấy SỰ KIỆN, không chép nguyên văn.** Lời thuyết minh và câu chữ của
người sáng tạo là tài sản của họ; tên quán, địa chỉ, khoảng giá thì không ai
độc quyền được. Mỗi bản ghi giữ link video gốc để ghi nguồn.

Đầu vào là JSON do `crawl.py` sinh ra. Gemini đọc theo lô để đỡ số lời gọi.
"""
import json
import os
import re
import sys
import time
import urllib.request

MODEL = "gemini-3.8-flash"
BATCH = 12

SCHEMA_HINT = """Mỗi phần tử đầu ra:
{
  "videoId": "<đúng id đã cho>",
  "places": [
    {
      "name": "tên địa điểm/quán, viết đúng chính tả tiếng Việt có dấu",
      "city": "thành phố/tỉnh, null nếu không rõ",
      "category": "CAFE|FOOD|STAY|ATTRACTION|ACTIVITY|OTHER",
      "priceHint": "khoảng giá nếu caption có nêu, dạng chữ, null nếu không",
      "note": "1 câu NGẮN mô tả vì sao đáng đến, viết lại bằng lời của bạn"
    }
  ]
}"""


def _gemini(prompt: str, key: str, attempts: int = 3) -> dict | None:
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0,
        },
    }).encode()
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{MODEL}:generateContent?key={key}"
    )
    for i in range(attempts):
        if i:
            time.sleep(2 ** i)
        try:
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=180) as r:
                out = json.load(r)
            text = out["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except Exception as e:  # noqa: BLE001
            print(f"  … Gemini lỗi {i + 1}/{attempts}: {str(e)[:120]}",
                  file=sys.stderr)
    return None


def clean_caption(text: str) -> tuple[str, list[str]]:
    """Tách hashtag ra khỏi câu. Hashtag là tín hiệu riêng, đừng để lẫn."""
    tags = re.findall(r"#([\wÀ-ỹ]+)", text or "")
    body = re.sub(r"#[\wÀ-ỹ]+", " ", text or "")
    return re.sub(r"\s+", " ", body).strip(), tags


def extract(videos: list[dict], key: str) -> list[dict]:
    """Trả về danh sách bản ghi địa điểm kèm nguồn."""
    out: list[dict] = []
    for i in range(0, len(videos), BATCH):
        chunk = videos[i:i + BATCH]
        items = []
        for v in chunk:
            body, tags = clean_caption(v.get("title") or v.get("description") or "")
            if not body and not tags:
                continue
            items.append({
                "videoId": v["id"],
                "caption": body[:600],
                "hashtags": tags[:12],
            })
        if not items:
            continue

        prompt = "\n".join([
            "Bạn đọc caption video du lịch TikTok và rút ra ĐỊA ĐIỂM có thật.",
            "",
            "Quy tắc nghiêm ngặt:",
            "- Chỉ ghi địa điểm caption THỰC SỰ nhắc tới. Không suy đoán,",
            "  không thêm địa điểm nổi tiếng mà caption không nói.",
            "- Caption không nêu địa điểm cụ thể nào thì trả places rỗng.",
            "- KHÔNG chép nguyên văn caption vào trường note. Viết lại ngắn.",
            "- Giá chỉ ghi khi caption có con số hoặc mức giá.",
            "",
            SCHEMA_HINT,
            "",
            'Trả về JSON: {"results": [ ... ]}',
            "",
            "Dữ liệu:",
            json.dumps(items, ensure_ascii=False),
        ])
        res = _gemini(prompt, key)
        if not res:
            continue
        by_id = {v["id"]: v for v in chunk}
        for r in res.get("results") or []:
            src = by_id.get(r.get("videoId"))
            if not src:
                continue
            for p in r.get("places") or []:
                name = (p.get("name") or "").strip()
                if not name:
                    continue
                out.append({
                    "name": name,
                    "city": p.get("city"),
                    "category": p.get("category") or "OTHER",
                    "priceHint": p.get("priceHint"),
                    "note": (p.get("note") or "").strip(),
                    # Ghi nguồn: bắt buộc, và để người dùng bấm xem video gốc.
                    "sourceUrl": src.get("url"),
                    "sourceAuthor": src.get("author"),
                    "views": src.get("views"),
                    "likes": src.get("likes"),
                })
        print(f"  lô {i // BATCH + 1}: {len(out)} địa điểm tích luỹ")
    return out


if __name__ == "__main__":
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        print("Thiếu GEMINI_API_KEY"); sys.exit(1)
    src = json.load(open(sys.argv[1], encoding="utf-8"))
    rows = extract(src if isinstance(src, list) else src.get("videos", []), key)
    dst = sys.argv[2] if len(sys.argv) > 2 else "places.json"
    json.dump(rows, open(dst, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"ghi {len(rows)} địa điểm → {dst}")
