const COLUMN_LETTERS = ['B', 'I', 'N', 'G', 'O'];

/**
 * ===========================================================================
 * BINGO CARD — the visual hero of the app
 * ===========================================================================
 * `card` is a flat 25-number array (0 = FREE). `drawnNumbers` determines
 * which cells light up as called. `onCellTap` fires when the player taps
 * a cell to mark it — marking is for the player's own visual tracking
 * only; the server independently validates any win claim against its own
 * draw history regardless of what the player has marked client-side.
 * ===========================================================================
 */
export function BingoCard({ card, drawnNumbers = [], marked = [], onCellTap }) {
  const drawnSet = new Set(drawnNumbers);
  const markedSet = new Set(marked);

  return (
    <div className="bingo-card">
      <div className="bingo-card__header">
        {COLUMN_LETTERS.map((letter) => (
          <div key={letter} className="bingo-card__letter">
            {letter}
          </div>
        ))}
      </div>
      <div className="bingo-card__grid">
        {card.map((value, idx) => {
          const isFree = value === 0;
          const isDrawn = isFree || drawnSet.has(value);
          const isMarked = isFree || markedSet.has(value);

          return (
            <button
              key={idx}
              type="button"
              disabled={isFree || !isDrawn}
              onClick={() => onCellTap?.(value, idx)}
              className={[
                'bingo-cell',
                isFree && 'bingo-cell--free',
                isDrawn && 'bingo-cell--drawn',
                isMarked && 'bingo-cell--marked',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={isFree ? 'Free space' : `Number ${value}${isMarked ? ', marked' : ''}`}
            >
              {isFree ? '★' : value}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ===========================================================================
 * CALLED NUMBERS STRIP — shown above the card during a live game
 * ===========================================================================
 */
export function CalledNumbersStrip({ drawnNumbers = [] }) {
  const latest = drawnNumbers[drawnNumbers.length - 1];
  const history = drawnNumbers.slice(0, -1).slice(-8).reverse();

  return (
    <div className="called-strip">
      {latest !== undefined && (
        <div className="called-strip__latest" key={latest}>
          {letterFor(latest)}
          <span className="called-strip__latest-number">{latest}</span>
        </div>
      )}
      <div className="called-strip__history">
        {history.map((n) => (
          <div key={n} className="called-strip__chip">
            {n}
          </div>
        ))}
      </div>
    </div>
  );
}

function letterFor(n) {
  if (n <= 15) return 'B';
  if (n <= 30) return 'I';
  if (n <= 45) return 'N';
  if (n <= 60) return 'G';
  return 'O';
}
