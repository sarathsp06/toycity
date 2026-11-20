# Aerial mosaic for each 2 km overview tile: the 4 x 4 small square photos (512 px each) stitched and
# scaled to 1024 px (about 2 m per pixel). Run after tools/overview.mjs.
# Usage: tools/.venv/bin/python tools/overview_aerial.py SLUG
import json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
slug = sys.argv[1]
web = os.path.join(HERE, "web", "regions", slug)
info = json.load(open(os.path.join(web, "tiles.json")))
n = info["overview"]["n"]
have = {(i, j) for i, j in info["squares"]}
for oi, oj in info["overview"]["tiles"]:
    img = Image.new("RGB", (512 * n, 512 * n), (118, 128, 104))
    for a in range(n):
        for b in range(n):
            i, j = oi * n + a, oj * n + b
            src = os.path.join(web, "a", f"{i}_{j}_s.jpg")
            if (i, j) in have and os.path.exists(src):
                img.paste(Image.open(src).convert("RGB").resize((512, 512)), (512 * a, 512 * (n - 1 - b)))
    img.resize((1024, 1024), Image.LANCZOS).save(os.path.join(web, "o", f"{oi}_{oj}.jpg"), quality=80, optimize=True)
    print(oi, oj)
