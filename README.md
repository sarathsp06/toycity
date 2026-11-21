<div align="center">

# 🏘️ Toy City

**Walk the streets you once knew. In your browser. At 75 fps.**

A real Dutch town, every house, hedge, canal and parked car, rebuilt from open map data<br/>
and streamed into a tiny three.js world you can walk, run, jump and drive through.

### ▶ [Play it at toycity.pages.dev](https://toycity.pages.dev)

![Two players meeting on a street in Barendrecht and talking in a call](docs/img/talk.gif)

<sub>Two players in a call: the green ring under Joost lights up while he talks.</sub>

</div>

---

## What you can do

- 🚶 **Walk, run and jump** (yes, onto hedges; no, not through trees, cars or other people)
- 🖱️ **Click anywhere** and walk there, or **search an address** like *Schaatsbaan 43*
- 🚗 **Drive any parked car**: walk up to one and press `E` (or tap 🚗 Get in). Shift for 100 km/h, `E` again to get out; the car stays where you parked it, and friends see you drive by
- 🛩️ **Fly** (press `F`) high above the town and drop back in anywhere
- 🌅 **Change the time of day**, from morning to golden hour to night
- 📱 **Play on your phone** with a joystick, a jump button, drag to look and pinch to zoom
- 👋 **Meet people**: everyone nearby is drawn as themselves, with their name above their head, and each player gets their own random look. **Tap someone** (or 📞 *Talk to …*) to call them; invite more for a group call. You hear them from the direction they're standing in. Share a 📍 **meeting link** and everyone arrives at the same spot, a few steps apart. It's all browser to browser, with no server of ours ([how](docs/multiplayer.md))
- 🐦 **Hear the neighbourhood**: birds where it's green, traffic near busy streets, all made in the browser

| Keyboard | |
|---|---|
| `W` `A` `S` `D` / arrows | walk |
| `Shift` | run |
| `Space` | jump |
| `E` | get in / out of a parked car |
| `F` | fly |
| drag / scroll | look / zoom |

![A car park in Barendrecht](docs/img/carpark.jpg)

## Why it's fast

The browser never touches raw map data. Everything is baked ahead of time into tiny files that
go almost straight to the GPU:

- 🧱 **500 m squares on the Dutch RD grid**, at three levels of detail, plus a **2 km overview** that
  fills the view to the horizon, so you never see an empty hole
- 🔮 **Looks 4 seconds ahead** of where you're heading, and fetches that first
- 🧵 **Two background workers** download and unpack, and the page spends at most 6 ms per frame
  uploading
- 🚗 **Thousands of instanced cars and trees**, with detailed cars only right next to you
- 💾 **Remembers what you've seen**: a revisit loads in about 1 s instead of about 9 on mobile

| Simulated mobile connection | Before | After |
|---|---|---|
| Empty patches at 100 m/s | 16.4 % of the time | **0 %** |
| Missing detail at 100 m/s | 65.8 % | **10.5 %** |
| Missing detail at 30 m/s | 4.1 % | **0 %** |

The whole story, including what went wrong, is in **[How it works](docs/how-it-works.md)**. The
formal design is in **[Rendering architecture](docs/rendering-architecture.md)**.

![Loading screen](docs/img/loading.jpg)

## Build it yourself

```sh
# 1. Fetch and clip the open data for a town (PDOK, 3D BAG, OpenStreetMap)
python3 tilebake.py barendrecht --gemeente Barendrecht
#    another province needs its Geofabrik extract, and --bbox keeps part of a big city, e.g. Amsterdam inside the A10:
#    python3 tilebake.py amsterdam --gemeente Amsterdam --bbox 115500 481500 126000 491500 \
#        --osm data/extracts/noord-holland.osm.pbf --title Amsterdam --start "Dam 1, Amsterdam"

# 2. Bake the squares and the overview
node tools/buildtiles.mjs barendrecht
node tools/overview.mjs barendrecht
tools/.venv/bin/python tools/overview_aerial.py barendrecht

# 3. Play locally (no caching, so no ?v= hacks)
python3 tools/serve.py 8765        # then open http://127.0.0.1:8765/city.html

# 4. Make the static site
sh tools/build_site.sh             # → dist/site, with every region web/places.json uses

# 5. Tests
node --test tests/*.test.mjs
```

The site has two pages. The front page (`web/index.html`) lists the places to start from, and the
game page (`web/city.html?place=<id>`) shows only a small bar (back, place name, ☰ menu) plus the
controls you touch; time of day, quality, search, people and the meeting link are in the menu, and
the map (🗺️ or `M`) is off until you open it.

**Adding a place** is one entry in [`web/places.json`](web/places.json): an id, a name, a line about
it, the region that holds it, a start point in RD metres and a photo (any aerial square of the
region). Several places can share a region: Rotterdam and Barendrecht are both in the `rotterdam`
region, so you can walk from one to the other. A place in a new town needs that town baked first
(steps 1–2) and the region added to `build_site.sh`.

Handy test switches: `city.html?drive=100&net=80,20` drives through town at 100 m/s on a
simulated slow connection and reports the gaps, and `?touch=1` shows the phone controls on a
desktop.

## Hosting

It's just files. The live version runs on **Cloudflare Pages**: no server and no database. A code
change re-uploads only the files that changed. The only moving part is a tiny Worker that hands out
short-lived TURN credentials, so players on strict mobile networks can still reach each other.

## Coming soon™

- 🗣️ **Crowds**: an SFU for when more than a handful of people meet in one place
- 🚙 **More cars**: a Skoda Superb, a VW Passat and a BMW 5 GT are waiting in the garage
- 🦆 Ducks in the canals (not promised, but strongly hoped for)

## Sources and credits

Toy City is built entirely from open data and openly licensed work. Thank you to everyone who
publishes it.

### Map data

Everything is fetched once by `tilebake.py`, clipped per 500 m square of the Dutch RD grid
(EPSG:28992) and baked into the game's own files. The browser never calls these services while
you play, except for the minimap tiles.

| Source | What it gives the game | Licence |
|---|---|---|
| [3D BAG](https://3dbag.nl) (TU Delft 3D geoinformation group) | Every building: its footprint, a simple LoD 1.2 block for the distance and the LoD 2.2 roof shape up close. Built from the Dutch building register (BAG) and the national height map (AHN). | [CC BY 4.0](https://docs.3dbag.nl/en/copyright/) |
| [BGT](https://www.pdok.nl/introductie/-/article/basisregistratie-grootschalige-topografie-bgt-), via [PDOK](https://www.pdok.nl) | The ground itself: roads, pavements, gardens, grass and water surfaces, plus hedges, walls, trees, lamp posts and street furniture. This is why every garden path and canal edge is where it really is. | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) / Kadaster |
| [BAG addresses](https://www.kadaster.nl/zakelijk/registraties/basisregistraties/bag), via PDOK | House numbers and the address search index, so *Schaatsbaan 43* takes you to the right front door. | [Public Domain Mark](https://creativecommons.org/publicdomain/mark/1.0/) / Kadaster |
| PDOK [aerial photographs](https://www.pdok.nl/introductie/-/article/luchtfoto-pdok) (Beeldmateriaal Nederland) | 25 cm imagery draped over the ground and roofs near you, and lower resolution further out. | [CC BY 4.0](https://www.beeldmateriaal.nl) |
| PDOK [administrative boundaries](https://www.pdok.nl/introductie/-/article/bestuurlijke-gebieden) | Municipality outlines, which decide which squares belong to a town. | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) / Kadaster |
| PDOK [Locatieserver](https://www.pdok.nl/introductie/-/article/pdok-locatieserver) | Finding a town or address while baking. | Free public service |
| [OpenStreetMap](https://www.openstreetmap.org/copyright), via the [Geofabrik](https://download.geofabrik.de) Zuid-Holland extract | Street names, shops and other named places, what kind of building each is (church, school…), street furniture, and bus stops (kept only when a bus route actually serves them). OSM tiles also draw the minimap. | © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/) |

### 3D models

| Model | Author | Licence |
|---|---|---|
| [Generic SUV ZYX0](https://blendswap.com/blend/29795) | 1DInc | CC0 |
| Zuri (persona), from [BlenderKit](https://www.blenderkit.com) | Richie Kirui | CC0 |
| Xbot (the classic figure and the shared walk, run and idle animations) | from the [three.js examples](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf) | as distributed with three.js |

Every parked car is this one SUV in a different paint, so the car file is 1.8 MB and every car you drive opens its door; the Golf, Camry, Fiat 500, Jeep and van conversions are still in `tools/blendswap_cars.py` (`IN_GAME`) if variety is wanted back. The car was simplified by `tools/`, and Zuri's Rigify skeleton was
renamed to Mixamo bones by `tools/personas.py`, so every person shares the same animations. The
full list is in [CREDITS.txt](web/models/CREDITS.txt).

### Software and services

- [three.js](https://threejs.org) draws everything (MIT).
- [Leaflet](https://leafletjs.com) draws the minimap (BSD-2-Clause).
- [polygon-clipping](https://github.com/mfogel/polygon-clipping) merges building footprints into
  neighbourhood blocks for the overview (MIT).
- [osmium](https://osmcode.org/osmium-tool/) cuts and filters the OpenStreetMap extract (GPL-3.0,
  used only while baking).
- [Trystero](https://github.com/dmotz/trystero) connects players browser to browser over public
  [Nostr](https://nostr.com) relays (MIT). It's bundled with a small patch, see
  [multiplayer.md](docs/multiplayer.md).
- [Cloudflare Pages](https://pages.cloudflare.com) hosts the site, and
  [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) relays calls for
  players whose networks block direct connections.
- Birds, wind, leaves and traffic are synthesised in the browser with the Web Audio API. There are
  no sound files to credit.

<div align="center"><sub>Made with stroopwafels and an unreasonable love for hedges. 🌳</sub></div>
