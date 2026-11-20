#!/usr/bin/env python3
"""Fetch the free PDOK aerial photo (8 cm, Actueel_orthoHR) for the detail zone as a grid of
tiles and record their bounds in the block's local metres, so the renderer can project them onto roofs.
The WMS caps one image at 2500 px, so the zone is split into TILE_M metre tiles at about 10 cm/px.

Usage: aerial.py BLOCK.json OUT_DIR
Writes block["detail"]["aerial"] = [{"src": path relative to the page, "x0", "y0", "x1", "y1"}, ...].
"""
import json
import math
import os
import sys
import urllib.request

WMS = ("https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?service=WMS&version=1.3.0&request=GetMap"
       "&layers=Actueel_orthoHR&styles=&crs=EPSG:4326&format=image/jpeg")


TILE_M = 200
TILE_PX = 2000


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "toycity-proto/0.1"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = resp.read()
    if not data.startswith(b"\xff\xd8"):
        raise SystemExit("aerial request failed: " + data[:300].decode("utf8", "replace"))
    return data


def main():
    path, out_dir = sys.argv[1], sys.argv[2]
    block = json.load(open(path))
    det = block["detail"]
    lat0, lon0 = block["center"]["lat"], block["center"]["lon"]
    kx, ky = 111_320.0 * math.cos(math.radians(lat0)), 111_320.0
    r = det["r"] + 10
    n_t = math.ceil(2 * r / TILE_M)
    x0, y0 = det["c"][0] - n_t * TILE_M / 2, det["c"][1] - n_t * TILE_M / 2
    os.makedirs(out_dir, exist_ok=True)
    web_dir = os.path.dirname(os.path.abspath(path))
    tiles = []
    for i in range(n_t):
        for j in range(n_t):
            tx0, ty0 = x0 + i * TILE_M, y0 + j * TILE_M
            tx1, ty1 = tx0 + TILE_M, ty0 + TILE_M
            s, w, n, e = lat0 + ty0 / ky, lon0 + tx0 / kx, lat0 + ty1 / ky, lon0 + tx1 / kx
            f = os.path.join(out_dir, f"aerial_{i}_{j}.jpg")
            if not os.path.exists(f):
                open(f, "wb").write(fetch(f"{WMS}&bbox={s:.7f},{w:.7f},{n:.7f},{e:.7f}&width={TILE_PX}&height={TILE_PX}"))
            tiles.append({"src": os.path.relpath(f, web_dir), "x0": tx0, "y0": ty0, "x1": tx1, "y1": ty1})
    det["aerial"] = tiles
    json.dump(block, open(path, "w"), separators=(",", ":"))
    print("aerial tiles", len(tiles), "at", TILE_M / TILE_PX, "m/px")


if __name__ == "__main__":
    main()
