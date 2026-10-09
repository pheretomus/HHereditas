#!/usr/bin/env python
"""Re-measure the band positions of vendor gel photographs used by tools/oracle/gel_oracle.py.

The `gel` module (packages/core/src/gel) is validated against band positions measured on the
reference gel images that ladder vendors publish with their datasheets. Those positions are
hard-coded in gel_vendor_gels.py (VENDOR_GELS) so that the oracle runs offline in the plain oracle
venv. This script documents and reproduces how they were measured:

  1. download the vendor document/image (cached in tools/oracle/gel_cache/images/, git-ignored:
     the images are the vendors' copyrighted material and are never committed);
  2. extract the gel image (embedded PDF image chosen by its placement on the page, a rendered PDF
     clip, or a web image);
  3. average the grey levels over the central 50 % of the lane width, subtract a running-minimum
     background, find the local maxima (scipy.signal.find_peaks) and refine each maximum to
     sub-pixel precision with a parabola through the three samples around it;
  4. match every band of the hard-coded table to the nearest detected peak and report the
     difference (|delta| <= 1 px is expected).

Requirements (NOT in the oracle venv; this script is optional): Pillow and NumPy; SciPy and PyMuPDF for the
original entries ('pdf-image' and 'pdf-clip' need PyMuPDF). Without SciPy the peak search falls back to a
NumPy re-implementation of scipy.ndimage.minimum_filter1d / uniform_filter1d (mode 'reflect') and
scipy.signal.find_peaks (prominence, distance=2), which reproduces the SciPy rows of
thermo-sm1331-1pct-tae to 0.01 px. The 'pdf-xobject' and 'web' entries need neither SciPy nor PyMuPDF:
    python -m pip install pillow numpy scipy pymupdf
    python tools/oracle/gel_measure_bands.py                      # every photograph
    python tools/oracle/gel_measure_bands.py --only id1,id2       # some of them
Network access is needed on the first run only.
"""

from __future__ import annotations

import hashlib
import re
import sys
import urllib.request
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / "gel_cache" / "images"
sys.path.insert(0, str(HERE))
from gel_vendor_gels import VENDOR_GELS  # noqa: E402  (data lives in one place)

USER_AGENT = "Mozilla/5.0 (HHereditas oracle; band position measurement)"

# How to obtain each image and where its lane is. Keys are VENDOR_GELS ids.
#   kind 'pdf-image': embedded image on `page` (1-based) whose placement contains `point` (PDF pt)
#   kind 'pdf-clip':  page rendered at `zoom` inside `clip` (PDF pt)
#   kind 'web':       a web image (webp/jpg)
#   kind 'pdf-xobject': the embedded image of `size` (width, height) pixels, decoded without PyMuPDF
# lane = (x0, x1) pixel columns of the lane, rows = (y0, y1) analysed rows, prom = minimum peak
# prominence, bg = running-minimum window (pixels).
MANIFEST: dict[str, dict] = {
    "thermo-sm1331-1pct-tae": dict(kind="pdf-image", url="https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013047_GeneRuler_1kb_Plus_DNALadder_250ug_UG.pdf", page=2, point=(330, 200), lane=(36, 118), rows=(10, 623), prom=6, bg=41),
    "thermo-sm0311-1pct-tae": dict(kind="pdf-image", url="https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013004_GeneRuler_1kb_DNALadder_250ug_UG.pdf", page=2, point=(330, 200), lane=(31, 114), rows=(8, 619), prom=6, bg=41),
    "thermo-sm0331-1pct-tae": dict(kind="pdf-image", url="https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013012_GeneRuler_DNALadder_250ug_UG.pdf", page=2, point=(560, 200), lane=(33, 116), rows=(24, 635), prom=6, bg=41),
    "thermo-sm0321-1.7pct-tbe": dict(kind="pdf-image", url="https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013008_GeneRuler_100bp_Plus_DNALadder_50ug_UG.pdf", page=2, point=(330, 200), lane=(36, 118), rows=(15, 626), prom=6, bg=41),
    "neb-n3232-0.8pct-tae": dict(kind="web", url="https://media.neb.com/asset/3d5a04a1-4c3c-482e-a074-75faf40f01a0/Webp/N0552_N0468_N3272_N3232_1kbDNALadder.webp", lane=(150, 258), rows=(40, 800), prom=8, bg=31),
    "neb-n3200-1pct-tbe": dict(kind="web", url="https://media.neb.com/asset/3d29e0d3-905a-4157-abbb-ec093c91af16/Webp/N0559_N0550_N0469_N3270_N3200_1kbPlusDNALadder.webp", lane=(222, 338), rows=(40, 823), prom=8, bg=31),
    "neb-n3231-1.3pct-tae": dict(kind="web", url="https://media.neb.com/asset/7d3f8d46-7a55-439a-9232-371ac3438d07/Webp/N0551_N0467_N3271_N3231_100bpDNALadder.webp", lane=(174, 282), rows=(33, 666), prom=8, bg=31),
    "neb-n3012-1pct": dict(kind="web", url="https://media.neb.com/asset/ab14bce6-76ea-46cd-8ed6-4459add8810a/Webp/N3012_LambdaHindIIIDigestMarker.webp", lane=(150, 290), rows=(16, 801), prom=8, bg=31),
    "bioneer-d1040-1pct-tbe": dict(kind="pdf-image", url="https://www.bioneer.co.kr/literatures/manual/LaddersandMarkers/PM-338-En_DNA_ladder.pdf", page=2, point=(240, 375), lane=(4, 49), rows=(0, 261), prom=10, bg=21),
    "bioneer-d1030-1.5pct-tbe": dict(kind="pdf-image", url="https://www.bioneer.co.kr/literatures/manual/LaddersandMarkers/PM-338-En_DNA_ladder.pdf", page=2, point=(303, 170), lane=(4, 50), rows=(0, 243), prom=10, bg=21),
    "bioneer-d1035-1pct-tbe": dict(kind="pdf-image", url="https://www.bioneer.co.kr/literatures/manual/LaddersandMarkers/PM-338-En_DNA_ladder.pdf", page=2, point=(118, 375), lane=(4, 84), rows=(0, 346), prom=10, bg=21),
    "bioneer-d1020-2pct-tbe": dict(kind="pdf-image", url="https://www.bioneer.co.kr/literatures/manual/LaddersandMarkers/PM-338-En_DNA_ladder.pdf", page=2, point=(179, 170), lane=(4, 51), rows=(0, 320), prom=10, bg=21),
    "enzynomics-dm002-1pct": dict(kind="web", url="http://www.enzynomics.com/data/editor/2010/2213e6130e39ce03575bc14edc6da3f2_1603334080_1205.jpg", lane=(26, 69), rows=(57, 380), prom=10, bg=21),
    "enzynomics-dm003-1pct": dict(kind="web", url="http://www.enzynomics.com/data/editor/2010/2213e6130e39ce03575bc14edc6da3f2_1603334095_3267.jpg", lane=(44, 120), rows=(103, 692), prom=10, bg=21),
    "enzynomics-dm001-1pct": dict(kind="web", url="http://www.enzynomics.com/data/editor/2010/2213e6130e39ce03575bc14edc6da3f2_1603334063_3635.jpg", lane=(44, 119), rows=(103, 686), prom=10, bg=21),
    "promega-g8291-2pct": dict(kind="pdf-clip", url="https://www.promega.com/-/media/files/resources/white-papers/quality-and-stability-of-dna-ladders-shipped-at-ambient-temperature.pdf", page=3, clip=(40, 95, 577, 525), zoom=3, lane=(85, 155), rows=(60, 1284), prom=6, bg=41),
    "promega-g7511-2pct": dict(kind="pdf-clip", url="https://www.promega.com/-/media/files/resources/white-papers/quality-and-stability-of-dna-ladders-shipped-at-ambient-temperature.pdf", page=3, clip=(40, 95, 577, 525), zoom=3, lane=(1262, 1338), rows=(60, 1284), prom=6, bg=41),
    # added 2026-10-08 (review findings F8/F18)
    "thermo-sm1191-3pct-tbe": dict(kind="pdf-xobject", url="https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013037_GeneRuler_LowRange_DNALadder_RTU_UG.pdf", size=(677, 910), lane=(46, 128), rows=(10, 630), prom=6, bg=41),
    "thermo-sm0371-2.5pct-tbe": dict(kind="pdf-xobject", url="https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013016_GeneRuler_50bp_DNALadder_50ug_UG.pdf", size=(724, 915), lane=(38, 120), rows=(13, 625), prom=6, bg=41),
    "neb-n3236-3pct-tbe": dict(kind="web", url="https://media.neb.com/asset/55e19020-b081-4c83-9a24-cbd9fd6dd8f9/Webp/N0556_N3236_50bpDNALadder.webp", lane=(158, 268), rows=(20, 805), prom=8, bg=31),
}


def fetch(url: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(url.encode()).hexdigest()[:16] + Path(url.split("?")[0]).suffix
    path = CACHE / name
    if not path.exists():
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            path.write_bytes(resp.read())
    return path


def _unpredict_png(raw: bytes, width: int, colors: int, bpc: int) -> bytes:
    """Undo PNG row predictors (FlateDecode /Predictor >= 10)."""
    bpp = max(1, colors * bpc // 8)
    stride = (width * colors * bpc + 7) // 8
    rows, prev, i = [], bytearray(stride), 0
    while i + 1 + stride <= len(raw):
        ft, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if ft == 1:
                line[x] = (line[x] + a) & 255
            elif ft == 2:
                line[x] = (line[x] + b) & 255
            elif ft == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line
    return b"".join(rows)


def pdf_xobject_gray(path: Path, size: tuple[int, int]) -> np.ndarray:
    """Grey levels of the embedded image of exactly `size` (width, height) pixels: DCTDecode (JPEG) or
    FlateDecode DeviceRGB / DeviceGray, 8 bits per component. No PyMuPDF needed."""
    from PIL import Image
    import io

    data = path.read_bytes()
    w, h = size
    for m in re.finditer(rb"\d+\s+0\s+obj\s*<<(.*?)>>\s*stream\r?\n", data, re.S):
        d = m.group(1)
        if not re.search(rb"/Subtype\s*/Image", d):
            continue
        width = re.search(rb"/Width\s+(\d+)", d)
        height = re.search(rb"/Height\s+(\d+)", d)
        if not (width and height and int(width.group(1)) == w and int(height.group(1)) == h):
            continue
        raw = data[m.end():data.find(b"endstream", m.end())].rstrip(b"\r\n")
        if b"DCTDecode" in d:
            return np.asarray(Image.open(io.BytesIO(raw)).convert("L"), dtype=float)
        px = zlib.decompress(raw)
        colors = 3 if b"DeviceRGB" in d else 1
        if b"/Predictor" in d:
            px = _unpredict_png(px, w, colors, 8)
        arr = np.frombuffer(px[:w * h * colors], np.uint8).reshape((h, w, colors) if colors > 1 else (h, w))
        return np.asarray(Image.fromarray(arr).convert("L"), dtype=float)
    raise RuntimeError(f"no {w}x{h} image in {path}")


def load_gray(spec: dict) -> np.ndarray:
    from PIL import Image
    import io

    path = fetch(spec["url"])
    if spec["kind"] == "web":
        return np.asarray(Image.open(path).convert("L"), dtype=float)
    if spec["kind"] == "pdf-xobject":
        return pdf_xobject_gray(path, spec["size"])
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    page = doc[spec["page"] - 1]
    if spec["kind"] == "pdf-clip":
        z = spec["zoom"]
        pix = page.get_pixmap(matrix=fitz.Matrix(z, z), clip=fitz.Rect(*spec["clip"]))
        return np.asarray(Image.open(io.BytesIO(pix.tobytes("png"))).convert("L"), dtype=float)
    px, py = spec["point"]
    for img in page.get_images(full=True):
        xref = img[0]
        for rect in page.get_image_rects(xref):
            if rect.x0 <= px <= rect.x1 and rect.y0 <= py <= rect.y1:
                pix = fitz.Pixmap(doc, xref)
                if pix.n - pix.alpha >= 4 or pix.colorspace is None or pix.colorspace.n not in (1, 3):
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                arr = np.asarray(Image.open(io.BytesIO(pix.tobytes("png"))).convert("L"), dtype=float)
                # Some PDFs place images upside down (negative y scale); the vendor figures used
                # here are all upright, so the raw orientation is kept.
                return arr
    raise RuntimeError(f"no image at {spec['point']} on page {spec['page']} of {spec['url']}")


def _reflect(a: np.ndarray, n: int) -> np.ndarray:
    """Pad like SciPy's mode 'reflect' (d c b a | a b c d | d c b a)."""
    return np.concatenate([a[:n][::-1], a, a[-n:][::-1]])


def np_minimum_filter1d(a: np.ndarray, size: int) -> np.ndarray:
    p = _reflect(a, size // 2)
    return np.array([p[i:i + size].min() for i in range(len(a))])


def np_uniform_filter1d(a: np.ndarray, size: int) -> np.ndarray:
    p = _reflect(a, size // 2)
    c = np.concatenate([[0.0], np.cumsum(p)])
    return (c[size:size + len(a)] - c[:len(a)]) / size


def np_find_peaks(x: np.ndarray, prominence: float) -> np.ndarray:
    """scipy.signal.find_peaks(x, prominence=prominence, distance=2): local maxima (plateaus -> middle),
    the lower of two maxima closer than 2 samples dropped, then the prominence threshold."""
    found, i, n = [], 1, len(x)
    while i < n - 1:
        if x[i - 1] < x[i]:
            ahead = i + 1
            while ahead < n - 1 and x[ahead] == x[i]:
                ahead += 1
            if x[ahead] < x[i]:
                found.append((i + ahead - 1) // 2)
                i = ahead
        i += 1
    pk = np.array(found, int)
    keep = np.ones(len(pk), bool)
    for k in np.argsort(x[pk])[::-1]:
        if keep[k]:
            for j in range(len(pk)):
                if j != k and keep[j] and abs(pk[j] - pk[k]) < 2 and x[pk[j]] <= x[pk[k]]:
                    keep[j] = False
    pk = pk[keep]
    prom = []
    for p in pk:
        i, lmin = p, x[p]
        while i >= 0 and x[i] <= x[p]:
            lmin = min(lmin, x[i])
            i -= 1
        j, rmin = p, x[p]
        while j < n and x[j] <= x[p]:
            rmin = min(rmin, x[j])
            j += 1
        prom.append(x[p] - max(lmin, rmin))
    return pk[np.array(prom) >= prominence] if len(pk) else pk


def peaks(gray: np.ndarray, spec: dict) -> list[float]:
    try:
        from scipy.ndimage import minimum_filter1d, uniform_filter1d
        from scipy.signal import find_peaks
    except ImportError:  # NumPy fallback (same results, see the module docstring)
        minimum_filter1d, uniform_filter1d = np_minimum_filter1d, np_uniform_filter1d

        def find_peaks(x, prominence, distance):
            assert distance == 2
            return np_find_peaks(x, prominence), {}

    x0, x1 = spec["lane"]
    y0, y1 = spec["rows"]
    c0 = x0 + int(0.25 * (x1 - x0))
    c1 = x1 - int(0.25 * (x1 - x0))
    prof = gray[y0 : y1 + 1, c0:c1].mean(axis=1)
    bw = spec["bg"]
    sig = prof - uniform_filter1d(minimum_filter1d(prof, bw), bw)
    idx, _ = find_peaks(sig, prominence=spec["prom"], distance=2)
    out = []
    for p in idx:
        off = 0.0
        if 0 < p < len(sig) - 1:
            l, c, r = sig[p - 1], sig[p], sig[p + 1]
            den = l - 2 * c + r
            off = 0.5 * (l - r) / den if den != 0 else 0.0
        out.append(y0 + p + off)
    return out


def main() -> int:
    only = None
    if len(sys.argv) > 2 and sys.argv[1] == "--only":
        only = set(sys.argv[2].split(","))
        unknown = only - set(MANIFEST)
        if unknown:
            raise SystemExit(f"unknown ids: {sorted(unknown)}")
    worst = 0.0
    for gel in VENDOR_GELS:
        if only is not None and gel["id"] not in only:
            continue
        spec = MANIFEST[gel["id"]]
        found = peaks(load_gray(spec), spec)
        diffs = []
        for bp, y in gel["bands"]:
            nearest = min(found, key=lambda f: abs(f - y))
            diffs.append(nearest - y)
        d = max(abs(x) for x in diffs)
        worst = max(worst, d)
        print(f"{gel['id']:28s} bands={len(gel['bands']):2d} peaks={len(found):2d} max|delta|={d:.2f} px")
    print(f"worst |delta| = {worst:.2f} px")
    return 0 if worst <= 1.0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
