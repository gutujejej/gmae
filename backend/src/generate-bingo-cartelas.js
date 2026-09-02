/* ====================================================================== */
/*  generate-bingo-cartelas.js                                            */
/*  ONE-TIME script - generates 100 standard 75-ball bingo cards (numbers  */
/*  1-100 as card_number, each holding a random valid 5x5 B/I/N/G/O grid)  */
/*  and inserts them into bingo_cartelas. Run once; the same 100 cards are */
/*  reused by every round forever after, same as physical cards being      */
/*  reused at a real bingo hall - this is NOT meant to be re-run once the  */
/*  game is live (it would fail on the existing card_number rows, by       */
/*  design, so it can't accidentally wipe out cards mid-use).              */
/*                                                                         */
/*  Standard column ranges: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75.    */
/*  Center square (row 3, col N) is the FREE space - stored as null.       */
/*                                                                         */
/*  USAGE:                                                                 */
/*    cd backend                                                          */
/*    node scripts/generate-bingo-cartelas.js                             */
/* ====================================================================== */

const { query, pool } = require('../src/core');

const COLUMN_RANGES = [
  [1, 15], // B
  [16, 30], // I
  [31, 45], // N
  [46, 60], // G
  [61, 75], // O
];

const CARD_COUNT = 100;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds one card as a flat 25-element row-major array: indices 0-4 are
// row 1, 5-9 row 2, etc. Column c's numbers land at indices c, c+5, c+10,
// c+15, c+20 - standard bingo layout. Center (index 12, row 3 col N) is
// the FREE square.
function generateCard() {
  const columns = COLUMN_RANGES.map(([min, max]) => {
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);
    return shuffle(pool).slice(0, 5);
  });

  const flat = new Array(25).fill(null);
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 5; row++) {
      flat[row * 5 + col] = columns[col][row];
    }
  }
  flat[12] = null; // FREE space, center of the N column

  return flat;
}

async function main() {
  console.log(`Generating ${CARD_COUNT} bingo cartelas...`);

  for (let cardNumber = 1; cardNumber <= CARD_COUNT; cardNumber++) {
    const numbers = generateCard();
    await query(`INSERT INTO bingo_cartelas (card_number, numbers) VALUES ($1, $2)`, [
      cardNumber,
      JSON.stringify(numbers),
    ]);
    if (cardNumber % 20 === 0) console.log(`  ...${cardNumber}/${CARD_COUNT}`);
  }

  console.log('Done. 100 cartelas inserted into bingo_cartelas.');
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to generate cartelas:', err.message);
  process.exit(1);
});
