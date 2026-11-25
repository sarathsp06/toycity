# Rendering rules: bodies, solids and the camera

2026-11-25. Rules 1, 2 and 5 were fixed the same day (see each status). Each rule is written the way `walker.js` already works: one invariant, one function
that owns it, who obeys it, who still goes round it, and the test that pins it. "Status" says what the
code does today. Numbers marked *measured* were read from the models and the running page (model
bounding boxes, a ray down onto the road); the rest come from constants in the code.

The height datum everywhere is **metres above the road's top** (y 0.15 in the scene, `TOP.road` in
`tools/buildtiles.mjs`; the pavement is 0.12 higher). A body's group origin is at its feet.

## 1. Feet rest on the highest top under them

- **Invariant**: a body's y is the highest top under its feet: the ground's own height, a hedge, a car
  roof, a bench, a sofa. Nothing is ever drawn with its feet inside what it stands on.
- **Owner**: `walker.floorAt(x, z)` = max(ground, `solids.topAt`). `stepJump` lands on it and steps up
  onto anything within one step.
- **Obeys**: you (`city.js` sets `player.position.y` from `jump.h`); other players (presence sends
  the same height as `up`, `presence.js` uses max(up, ground)).
- **Goes round it**: passers-by (`peds.js`) use `ground` only, never `solids.topAt`; a knocked-down
  passer-by or player lands at ground level even when thrown onto a car or a hedge (`fling.h <= 0`).
- **Test**: `tests/walker.test.mjs` "one rule for everything you stand on".
- **Status**: **fixed**. Ground and cars were right (*measured*: on a parked car the feet go to y 1.60,
  the roof mesh is at 1.59 to 1.62). Hedges were not: the walker put the feet at a fixed 1.1 above
  the road (y 1.25) while a front-garden hedge's mesh tops out at y 0.94, so you stood 31 cm above
  it (*measured* at Schaatsbaan 43, Barendrecht). Now each square's hedge meshes are rasterised into
  a hedge-top map like the ground (`topMap` in `city.js`), the walker takes `hedge(x, z)`, and
  `HEDGE_TOP` is only the fallback where no hedge mesh is known. *Measured* after: feet 0.94, mesh 0.94.
- **Test**: `tests/walker.test.mjs` "a hedge is as high as its mesh".

## 2. A top is the surface you stand or sit on, not the bounding box

- **Invariant**: a footprint's `top` is the height of the surface a body actually rests on. A thing
  with two levels (a sofa's cushion and its back, a car's bonnet and roof) has one footprint per level
  or its `top` is the lower one.
- **Owner**: `FOOTPRINTS` in `solids.js`, `interior.json` `solids[].top` (written by
  `tools/interior_model.py`).
- **Status**: **fixed**. The generator meant sofa tops to be their seats, but the code that measures
  which way a seat faces reused the name `top` and overwrote it with the mesh's highest point, so
  every seat was one block as high as its back. `tools/interior_model.py` now gives each seat's
  footprint `parts`: the back strip, the arms and the cushion, each with the top a downward ray meets,
  through the seat points. `standOn` in `solids.js` uses the parts for standing and bumping; the
  whole footprint is kept only for the contact shadow. *Measured* in the room: on every one of the
  nine seats the feet stand within 2 cm of the cushion's mesh.
- **Test**: `tests/interior.test.mjs` "every seat is a cushion at its own height" and "you can stand
  on every cushion".

## 3. A solid blocks the body only while its top is more than a step above the feet

- **Invariant**: a kerb, a bench or a sofa is walked onto; a wall, a car or a tall shelf is bumped
  into; a hedge is jumped over. The body is a 0.3 m cross of probes (0.22 m indoors).
- **Owner**: `walker.blockedAs` (`STEP` 0.55 outside, `STEP_IN` 0.2 inside; `solids.hitAbove`).
- **Obeys**: you; AI players (`agent.js` uses the same walker); click-to-walk (`localPath`).
- **Goes round it**: passers-by walk a fixed 4.8 m right of the street's centre line and never ask
  `solids` or the collision bitmap, so on a narrow street they pass through parked cars, lamp posts,
  bins, hedges and house fronts; their side-step from you can carry them into a wall. Traffic has its
  own rule (the road graph, stops for people).
- **Test**: `tests/walker.test.mjs` probes, hedge and indoor tests.
- **Status**: solid for players, absent for passers-by.

## 4. Sitting: the hips over the seat point, the thighs on the cushion

- **Invariant**: a seated body is placed by its seat's height, not by animation alone: hips at
  `h + 0.08`, moved forward until they are over the seat point. Sitting down and standing up are moves
  (`seatMove`), never cuts, and the body steps onto the seat from a spot that is clear.
- **Owner**: `sitOffset(h)` in `mp/players.js`; `sitDown` / `standUp` / `seatStep` in `city.js`;
  `room.standSpot`.
- **Obeys**: you and other players (same `sitOffset`, same `seatK` easing).
- **Status**: right in shape (*measured*: seated on the three-seater the hips are 0.636 m over the
  floor against 0.64 wanted, 5 cm from the seat point), with three gaps left open.
  1. The offset is one number while the clips are retargeted with the hip height scaled per persona
     (`avatar.js`): a taller persona sits with their thighs in the cushion, a shorter one hovers.
  2. `E` or the Sit button (`sitDown()` with no argument) takes the nearest free seat within 1.4 m and
     glides straight to it. Only click-to-sit goes via `standSpot`. From behind a sofa that glide is
     through the backrest.
  3. A remote sitter is matched to a seat within 0.6 m, else given `h` 0.45: during the glide, or on a
     stale position, they sit at the wrong height.
- **Test to add**: for each `kind` in `interior.json`, the hip joint's world y after `sitOffset` is
  within 2 cm of `h + 0.08`, for every persona.

## 5. Wheels on the road

- **Invariant**: a car's wheels touch the surface it is on; the same car has the same height whether
  parked, driven, left behind, or someone else's.
- **Status**: **fixed**. The car you drive, the car you leave, a dented one, traffic, and other
  players' driven and parked cars all stood at y 0, wheels 16 cm into the road, because the first
  drivable car cancelled the player's 0.15 instead of matching the parked cars. One `ROAD` constant in
  `solids.js` now places them all. What sat relative to the old height moved with it: the driver's and
  passenger's eyes (`ROAD + 1.22`), and a passenger, now on the seat cushion measured on the model
  (`SEAT_H` in `vehicle.js`, 0.648 m) through `sitOffset`. The bike's rider, who was 15 cm over the
  saddle, now sits on it, and a parked bike's standing top is its leaning saddle (0.93). *Measured*:
  parked, driven, left and traffic cars all have their wheels at 0.15 to 0.16, on a road at 0.16;
  feet on a parked bike 1.08, its saddle 1.081.

## 6. The camera is never inside a solid

- **Invariant**: the camera hangs on a boom from the head; the boom shortens at walls and tall
  furniture, and the body is hidden rather than drawn inside out when the camera is against it.
- **Owner**: `room.camera(v, target)` in `interior.js`, `roomCam` in `city.js`.
- **Status**: indoors only. The outdoor `chaseCam` lerps to the orbit point with no test, so against a
  house front or under a tree the camera goes through the wall or sits inside the crown. The same
  `hitAbove` walk along the boom, against the collision bitmap and `solids`, would close it.

## 7. The head stays under the ceiling, the feet above the floor

- **Invariant**: a jump never puts the head through the ceiling; a floor is never seen from below.
- **Owner**: `walker` `ceiling()` (`room.ceiling` = 2.7 − `HEAD` 1.85); the overview ground sits 40 cm
  below the square's ground so it never shows through.
- **Status**: fine indoors. Outdoors tree crowns have no height: standing on a car roof under a tree
  (roof 1.45 + head 1.85) puts the head in the crown. Low priority.

## 8. One body per place

- **Invariant**: two bodies never share a spot: people are solid to each other, one person per seat,
  one car per parking spot.
- **Owner**: live footprints (`solids.live`), `takenSeats`, `hideUnderOthers` (parked car steps aside
  for a player's car).
- **Status**: you cannot walk into anyone, and passers-by step aside from people. Other players arrive
  by interpolation and are never pushed out of you. Two players who press `E` for the same seat in
  the same half second both sit on it (`takenSeats` is checked locally, no claim). Passers-by step
  aside from people but not from objects (rule 3).

## 9. Where a thing meets the floor there is a shadow

- **Invariant**: contact is drawn: a soft blob under every piece of furniture and every body indoors,
  shadow maps outdoors.
- **Owner**: `contactShadows`, `blobMesh` in `interior.js`; the sun's shadow camera follows the player.
- **Status**: done. The blob is a child of the body's group, so it stays on the floor under a seated
  body (right) and rises with the feet in a jump (the shadow floats; it should stay at `floorAt` or
  fade with height). Minor.

## What is left

1. Passers-by never ask `solids` or the collision bitmap (rule 3).
2. Sitting by `E` glides through a sofa's back from behind; seat height per persona; remote sitters'
   seat lookup (rule 4).
3. The outdoor camera has no solid test (rule 6); tree crowns have no height (rule 7).
4. Two players taking one seat at once (rule 8); a jumping body's shadow blob rises with it (rule 9).
