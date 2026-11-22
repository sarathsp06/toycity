// The map grid: where the scene sits in RD metres, the 500 m squares the region is cut into, and the
// 0.5 m bitmaps baked per square (collision, hedges, water). One place for the sums every module did by hand.
//
// Coordinates: RD metres X east, Y north; the scene is x = X - ORX, z = ORY - Y (three.js z points south).
// A square i, j covers X in [i T, (i + 1) T) and Y in [j T, (j + 1) T); its key is "i_j" (file names,
// tiles, car and door keys all use it). A bitmap is 1000 x 1000 cells of 0.5 m from the square's
// south-west corner, row by row northwards: bit = row * 1000 + col, 8 bits a byte, 125000 bytes.
//
//   const grid = createGrid(ORX, ORY, T)
//   grid.toRD(x, z) -> [X, Y]     grid.fromRD(X, Y) -> [x, z]
//   grid.keyAt(x, z), grid.keyAtRD(X, Y) -> "i_j"     squareKey(i, j)
//   grid.cellBit(X, Y, i, j)      the bit of the cell holding RD point X, Y in square i, j
//   getBit(bits, bit), setBit(bits, bit), newBitmap()
//
// Nothing here touches three.js, so the unit tests (tests/grid.test.mjs) run it in node.

export const CELL = 0.5, SIDE = 1000, BYTES = SIDE * SIDE / 8;
export const squareKey = (i, j) => i + '_' + j;
export const getBit = (bits, bit) => (bits[bit >> 3] >> (bit & 7)) & 1;
export const setBit = (bits, bit) => { bits[bit >> 3] |= 1 << (bit & 7); };
export const newBitmap = () => new Uint8Array(BYTES);

export function createGrid(ORX, ORY, T) {
  const keyAtRD = (X, Y) => squareKey(Math.floor(X / T), Math.floor(Y / T));
  return {
    ORX, ORY, T,
    toRD: (x, z) => [x + ORX, ORY - z],
    fromRD: (X, Y) => [X - ORX, ORY - Y],
    keyAtRD,
    keyAt: (x, z) => keyAtRD(x + ORX, ORY - z),
    cellBit: (X, Y, i, j) => Math.floor((Y - j * T) / CELL) * SIDE + Math.floor((X - i * T) / CELL),
  };
}
