# -*- coding: utf-8 -*-
"""Tìm blog/bài viết du lịch trên internet → rút sự kiện cho kho tri thức Matey.

KHÔNG có danh sách website nào trong code. Nguồn được **khám phá** bằng cách
gõ câu tìm kiếm (DuckDuckGo, dự phòng Bing) cho từng điểm đến, rồi crawl các
trang trả về. Điểm đến lấy từ tham số dòng lệnh hoặc một file văn bản.

Tái dùng bộ crawl của Reelforge (E:\\Video_tiktok\\Tool): `safe_fetch` (chặn
SSRF, giới hạn byte, kiểm redirect), `DomainThrottle` (1 lượt/giây/tên miền)
và trafilatura để rút phần thân bài. Chạy bằng môi trường uv của Reelforge:

  uv run --project E:/Video_tiktok/Tool/backend python discover.py \\
      --dest "Đà Lạt" --dest "Hội An" --out web_places.jsonl

  # hoặc mỗi dòng một điểm đến
  uv run --project E:/Video_tiktok/Tool/backend python discover.py \\
      --dest-file destinations.txt

Rồi nạp: npx ts-node scripts/travel_kb/ingest.ts scripts/travel_kb/web_places.jsonl

Chỉ lấy SỰ KIỆN (tên, địa chỉ, giá, giờ, thứ tự đi chơi), viết lại bằng lời
của model, không chép nguyên văn bài. Mỗi dòng giữ link bài gốc để ghi nguồn.
Ảnh chỉ lưu LINK (ảnh đại diện og:image hoặc ảnh trong bài), không tải về.
"""
import argparse
import base64
import io
import json
import os
import random
import re
import sys
import time
import urllib.request
from html import unescape
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlsplit

import httpx

try:
    from reelforge.research.sources import (
        PAGE_POLICY,
        SourceDoc,
        SourceFetcher,
        domain_of,
        extract_article,
    )
    from reelforge.security.safe_fetch import FetchError, FetchPolicy, fetch
except ImportError:
    print("Chạy bằng: uv run --project E:/Video_tiktok/Tool/backend python discover.py ...")
    sys.exit(1)

MODEL = "gemini-3.8-flash"
GEMINI_KEY = ""  # gán trong main()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Safari/537.36")

# Câu tìm kiếm theo CHỦ ĐỀ, không theo trang. `{d}` là điểm đến.
QUERIES = [
    "kinh nghiệm du lịch {d} tự túc chi phí",
    "lịch trình du lịch {d} 3 ngày 2 đêm",
    "địa điểm check in {d} giá vé giờ mở cửa",
    "quán ăn ngon {d} giá bình dân",
    "quán cà phê đẹp {d}",
    "homestay khách sạn {d} giá rẻ review",
]

# Trang không phải bài viết: công cụ tìm kiếm, mạng xã hội, video, sàn TMĐT.
# Đây là bộ lọc theo LOẠI trang, không phải danh sách nguồn.
NOT_ARTICLE = re.compile(
    r"(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|facebook\.com|"
    r"instagram\.com|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|"
    r"pinterest\.[a-z.]+|shopee\.vn|lazada\.vn|threads\.net|scribd\.com)$"
)

SEARCH_POLICY = FetchPolicy(
    allow_any_public_host=True,
    max_bytes=2 * 1024 * 1024,
    allowed_types=frozenset({"text/html"}),
)


# ─── tìm kiếm ─────────────────────────────────────────────────────────────
def _strip(s: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _fold(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFD", s.lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn").replace("đ", "d")


def search_ddg(client: httpx.Client, q: str) -> list[dict]:
    r = client.post("https://html.duckduckgo.com/html/",
                    data={"q": q, "kl": "vn-vi"}, headers={"User-Agent": UA})
    # 202 = tường chống bot của DDG: trang trắng, không phải "không có kết quả".
    if r.status_code != 200:
        raise RuntimeError(f"DDG {r.status_code}")
    out = []
    for m in re.finditer(
        r'class="result__a" href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'class="result__snippet"[^>]*>(.*?)</a>', r.text, re.S):
        url = unescape(m.group(1))
        if "duckduckgo.com/l/" in url:
            url = parse_qs(urlsplit(urljoin("https://duckduckgo.com", url)).query
                           ).get("uddg", [""])[0]
        if not url or "duckduckgo.com/y.js" in url:
            continue
        out.append({"url": url, "title": _strip(m.group(2)),
                    "snippet": _strip(m.group(3))})
    return out


def search_bing(client: httpx.Client, q: str) -> list[dict]:
    r = client.get(f"https://www.bing.com/search?q={quote_plus(q)}&setlang=vi&cc=VN",
                   headers={"User-Agent": UA})
    out = []
    for block in r.text.split('<li class="b_algo"')[1:]:
        a = re.search(r'<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not a:
            continue
        url = unescape(a.group(1))
        if "bing.com/ck/a" in url:
            u = parse_qs(urlsplit(url).query).get("u", [""])[0]
            if not u.startswith("a1"):
                continue
            pad = "=" * (-len(u[2:]) % 4)
            url = base64.urlsafe_b64decode(u[2:] + pad).decode("utf-8", "replace")
        p = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
        out.append({"url": url, "title": _strip(a.group(2)),
                    "snippet": _strip(p.group(1)) if p else ""})
    return out


def search_google(client: httpx.Client, q: str) -> list[dict]:
    """Google Search qua Gemini (công cụ google_search chính thức).

    Cào HTML của công cụ tìm kiếm từ máy này không trụ được: DDG trả 202,
    Mojeek/Startpage đòi captcha, Bing trả kết quả lạc đề. Gemini trả link
    nguồn trong groundingMetadata (dạng link chuyển hướng) — mở ra lấy URL thật.
    """
    body = json.dumps({
        "contents": [{"parts": [{"text":
            f"Tìm các bài blog, cẩm nang, bài review du lịch tiếng Việt cho: {q}. "
            "Liệt kê ngắn tên các bài tìm được."}]}],
        "tools": [{"google_search": {}}],
    }).encode()
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{MODEL}:generateContent?key={GEMINI_KEY}",
        data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    out = []
    for ch in (d.get("candidates") or [{}])[0].get("groundingMetadata", {}).get(
            "groundingChunks", []):
        web = ch.get("web") or {}
        uri = web.get("uri")
        if not uri:
            continue
        try:
            final = str(client.head(uri, headers={"User-Agent": UA}).url)
        except httpx.HTTPError:
            continue
        out.append({"url": final, "title": web.get("title") or "", "snippet": ""})
    return out


def search(client: httpx.Client, q: str, dest: str) -> list[dict]:
    """Google (qua Gemini) trước, DDG rồi Bing dự phòng; chỉ giữ bài có nhắc điểm đến."""
    results: list[dict] = []
    for engine in (search_google, search_ddg, search_bing):
        try:
            results = engine(client, q)
        except Exception as e:  # noqa: BLE001
            print(f"    {engine.__name__}: {str(e)[:80]}", file=sys.stderr)
            results = []
        if results:
            break
    want = _fold(dest)
    keep = []
    for r in results:
        host = (urlsplit(r["url"]).hostname or "").lower().removeprefix("www.")
        if not r["url"].startswith("http") or NOT_ARTICLE.search(host):
            continue
        # Bing nghi bot thì trả kết quả lạc đề — bắt buộc có tên điểm đến.
        hay = _fold(f"{r['title']} {r['snippet']} {unquote(r['url']).replace('-', ' ')}")
        if want not in hay and want.replace(" ", "") not in hay:
            continue
        keep.append(r)
    return keep


# ─── crawl ────────────────────────────────────────────────────────────────
def page_images(html: str, base: str, limit: int = 40) -> list[dict]:
    """Ảnh trong bài kèm alt và tiêu đề mục gần nhất phía trên.

    Alt thường chung chung ("... tự túc 3"); tiêu đề mục (h2/h3 kiểu
    "3. Hồ Tuyền Lâm") mới cho model biết ảnh thuộc địa điểm nào.
    """
    out, seen = [], set()
    heads = [(m.start(), _strip(m.group(1)))
             for m in re.finditer(r"<h[2-4][^>]*>(.*?)</h[2-4]>", html, re.I | re.S)]
    for m in re.finditer(r"<img\b[^>]*>", html, re.I):
        tag = m.group(0)
        # Ảnh lazy-load để ảnh giữ chỗ ở src, ảnh thật ở data-src/srcset.
        src = ""
        for attr in ("data-src", "data-lazy-src", "data-original", "src",
                     "data-srcset", "srcset"):
            a = re.search(rf'\s{attr}="([^"]+)"', tag)
            if a and not a.group(1).startswith("data:"):
                src = a.group(1).split(",")[0].strip().split(" ")[0]
                break
        alt = (re.search(r'\balt="([^"]*)"', tag) or [None, ""])[1]
        if not src:
            continue
        src = urljoin(base, unescape(src))
        if not src.startswith("https://") or src in seen:
            continue
        # Chú ý "(^|[/_-])ads?": không được khớp nhầm "uploads/".
        if re.search(r"logo|icon|avatar|banner|(^|[/_-])ads?[/_-]|pixel|badge|"
                     r"\.svg|\.gif", src, re.I):
            continue
        seen.add(src)
        section = next((h for pos, h in reversed(heads) if pos < m.start()), "")
        out.append({"url": src, "alt": _strip(alt)[:120], "section": section[:120]})
        if len(out) >= limit:
            break
    return out


def crawl(fetcher: SourceFetcher, client: httpx.Client, url: str) -> tuple[SourceDoc, list[dict]]:
    doc = SourceDoc(url=url, domain=domain_of(url), kind="article", discovered_by="search")
    try:
        if not fetcher.robots_allows(client, url):
            doc.status = "robots_disallowed"
            return doc, []
        body, _ctype, final = fetcher._get(client, url, PAGE_POLICY)  # noqa: SLF001
    except FetchError as exc:
        doc.status, doc.error = "failed", str(exc)
        return doc, []
    doc.url, doc.domain = final, domain_of(final)
    doc = extract_article(body, final, doc)
    return doc, page_images(body.decode("utf-8", "replace"), final)


# ─── rút sự kiện ──────────────────────────────────────────────────────────
PROMPT = """Bạn đọc một bài blog/bài viết du lịch tiếng Việt về "{dest}" và rút
SỰ KIỆN cho cẩm nang du lịch.

Quy tắc nghiêm ngặt:
- Chỉ ghi điều bài viết THỰC SỰ nêu. Không bổ sung kiến thức ngoài bài.
- KHÔNG chép nguyên văn. Viết lại ngắn gọn bằng lời của bạn.
- Giá/giờ/địa chỉ chỉ ghi khi bài có nêu. Không có thì null.
- "imageUrl" CHỈ được chọn từ danh sách ảnh cho sẵn, khi alt hoặc vị trí cho
  (hoặc "section") cho thấy ảnh đúng là địa điểm đó. Không chắc thì null.
  Không tự tạo link.
- Bỏ địa điểm ngoài "{dest}" và các mục quảng cáo không có thông tin.

Trả JSON đúng khuôn:
{{
  "places": [
    {{"name": "tên có dấu", "city": "thành phố/tỉnh", "address": "hoặc null",
      "category": "CAFE|FOOD|STAY|ATTRACTION|ACTIVITY|OTHER",
      "priceVnd": "khoảng giá dạng chữ, vd '30k-50k/người', hoặc null",
      "openHours": "hoặc null", "tips": ["mẹo ngắn, tối đa 3"],
      "note": "1-2 câu vì sao đáng đến", "imageUrl": "hoặc null"}}
  ],
  "itineraries": [
    {{"title": "vd 'Đà Lạt 3N2Đ tự túc'", "days": [
      {{"day": 1, "stops": [
        {{"time": "vd '08:00' hoặc 'sáng'", "place": "tên",
          "durationHint": "hoặc null", "costHint": "hoặc null"}}]}}],
      "totalBudgetHint": "tổng chi phí bài nêu, hoặc null",
      "bestTime": "mùa/tháng nên đi nếu bài nêu, hoặc null"}}
  ]
}}
`itineraries` chỉ điền khi bài thật sự kể lịch trình theo ngày/giờ.

Tiêu đề bài: {title}

Danh sách ảnh trong bài (url, alt, section = tiêu đề mục chứa ảnh):
{images}

Nội dung bài:
\"\"\"
{text}
\"\"\""""


def gemini(prompt: str, key: str) -> dict | None:
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }).encode()
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"{MODEL}:generateContent?key={key}")
    for i in range(3):
        if i:
            time.sleep(2 ** i)
        try:
            req = urllib.request.Request(url, data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                out = json.load(r)
            return json.loads(out["candidates"][0]["content"]["parts"][0]["text"])
        except Exception as e:  # noqa: BLE001
            print(f"    … Gemini lỗi {i + 1}/3: {str(e)[:120]}", file=sys.stderr)
    return None


def to_rows(res: dict, doc: SourceDoc, images: list[dict], dest: str) -> list[dict]:
    allowed = {i["url"] for i in images}
    if doc.image_url:
        allowed.add(doc.image_url)
    rows = []
    for p in res.get("places") or []:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        img = p.get("imageUrl")
        rows.append({
            "kind": "place",
            "name": name,
            "city": p.get("city") or dest,
            "address": p.get("address"),
            "category": p.get("category") or "OTHER",
            "priceVnd": p.get("priceVnd"),
            "openHours": p.get("openHours"),
            "tips": [t for t in (p.get("tips") or []) if t][:3],
            "note": (p.get("note") or "").strip(),
            # Model chỉ được chọn ảnh có thật trong trang — chặn link bịa.
            "imageUrl": img if img in allowed else None,
            "sourceUrl": doc.url,
            "sourceAuthor": doc.domain,
        })
    for it in res.get("itineraries") or []:
        days = it.get("days") or []
        if not days:
            continue
        lines = []
        for d in days:
            stops = "; ".join(
                " ".join(filter(None, [s.get("time"), s.get("place"),
                                       f"({s['durationHint']})" if s.get("durationHint") else None,
                                       f"~{s['costHint']}" if s.get("costHint") else None]))
                for s in d.get("stops") or [] if s.get("place"))
            if stops:
                lines.append(f"Ngày {d.get('day')}: {stops}")
        if not lines:
            continue
        rows.append({
            "kind": "itinerary",
            "name": (it.get("title") or f"Lịch trình {dest}").strip(),
            "city": dest,
            "category": "ITINERARY",
            "note": " | ".join(lines),
            "totalBudgetHint": it.get("totalBudgetHint"),
            "bestTime": it.get("bestTime"),
            "imageUrl": doc.image_url or None,
            "sourceUrl": doc.url,
            "sourceAuthor": doc.domain,
        })
    return rows


# ─── chạy ────────────────────────────────────────────────────────────────
def load_done(path: str) -> set[str]:
    done: set[str] = set()
    try:
        for line in io.open(path, encoding="utf-8"):
            if line.strip():
                done.add(json.loads(line).get("sourceUrl", ""))
    except FileNotFoundError:
        pass
    return done


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", action="append", default=[], help="điểm đến, lặp được")
    ap.add_argument("--dest-file", help="file mỗi dòng một điểm đến")
    ap.add_argument("--out", default="web_places.jsonl")
    ap.add_argument("--per-query", type=int, default=3, help="số bài crawl mỗi câu tìm")
    ap.add_argument("--max-pages", type=int, default=15, help="trần số bài mỗi điểm đến")
    args = ap.parse_args()

    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        env = Path(__file__).resolve().parents[2] / ".env"
        if env.exists():
            m = re.search(r'^GEMINI_API_KEY\s*=\s*"?([^"\r\n]+)', env.read_text("utf-8"), re.M)
            key = m.group(1).strip() if m else ""
    if not key:
        print("Thiếu GEMINI_API_KEY"); sys.exit(1)
    global GEMINI_KEY
    GEMINI_KEY = key

    dests = list(args.dest)
    if args.dest_file:
        dests += [l.strip() for l in io.open(args.dest_file, encoding="utf-8") if l.strip()]
    if not dests:
        print("Cần ít nhất một --dest hoặc --dest-file"); sys.exit(1)

    done = load_done(args.out)
    sink = io.open(args.out, "a", encoding="utf-8")
    fetcher = SourceFetcher(max_fetches=10_000, respect_robots=True)
    total = 0
    with httpx.Client(timeout=20, follow_redirects=True) as sclient, \
            fetcher.client_factory() as client:
        for dest in dests:
            print(f"\n■ {dest}")
            urls: dict[str, dict] = {}
            for q in QUERIES:
                qq = q.format(d=dest)
                hits = search(sclient, qq, dest)
                added = 0
                for h in hits:
                    if h["url"] in urls or h["url"] in done:
                        continue
                    # Một tên miền tối đa 2 bài mỗi điểm đến: đa dạng nguồn.
                    dom = domain_of(h["url"])
                    if sum(1 for u in urls if domain_of(u) == dom) >= 2:
                        continue
                    urls[h["url"]] = h
                    added += 1
                    if added >= args.per_query:
                        break
                print(f"  tìm «{qq}»: +{added} bài")
                time.sleep(random.uniform(3, 6))  # giãn nhịp để không bị chặn bot
            for url in list(urls)[: args.max_pages]:
                doc, images = crawl(fetcher, client, url)
                if doc.status != "ok":
                    print(f"  ✗ {doc.domain}: {doc.status}")
                    continue
                res = gemini(PROMPT.format(
                    dest=dest, title=doc.title,
                    images=json.dumps(images, ensure_ascii=False),
                    text=doc.text), key)
                rows = to_rows(res or {}, doc, images, dest)
                for r in rows:
                    sink.write(json.dumps(r, ensure_ascii=False) + "\n")
                sink.flush()
                total += len(rows)
                n_it = sum(1 for r in rows if r["kind"] == "itinerary")
                n_img = sum(1 for r in rows if r.get("imageUrl"))
                print(f"  ✓ {doc.domain}: {len(rows) - n_it} địa điểm, "
                      f"{n_it} lịch trình, {n_img} ảnh")
    sink.close()
    print(f"\nTổng: +{total} dòng → {args.out}")


if __name__ == "__main__":
    main()
