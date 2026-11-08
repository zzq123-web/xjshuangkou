import type { Bid, Card, Rank } from './types.js';

const CALL_RANKS: readonly Rank[] = ['K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2', 'A'];
const TRACTOR_RING: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];

export type BidShape =
  | { readonly kind: 'pair'; readonly cardCount: 2; readonly strength: number }
  | { readonly kind: 'tractor'; readonly cardCount: 4 | 6; readonly startRank: Rank; readonly strength: number };

export function classifyBid(cards: readonly Card[]): BidShape | null {
  if (cards.length === 2 && isSameFace(cards[0], cards[1]) && cards[0].suit !== 'joker') {
    const strength = CALL_RANKS.length - CALL_RANKS.indexOf(cards[0].rank as Rank);
    return { kind: 'pair', cardCount: 2, strength };
  }
  const startRank = tractorStart(cards);
  if (startRank === null) return null;
  return {
    kind: 'tractor',
    cardCount: cards.length as 4 | 6,
    startRank,
    strength: TRACTOR_RING.length - TRACTOR_RING.indexOf(startRank)
  };
}

export function compareBidShapes(a: BidShape, b: BidShape): number | null {
  if (a.kind !== b.kind || a.cardCount !== b.cardCount) return null;
  return Math.sign(a.strength - b.strength);
}

export function compareBids(a: Bid, b: Bid): number | null {
  const shapeA = classifyBid(a.cards);
  const shapeB = classifyBid(b.cards);
  if (!shapeA || !shapeB) return null;
  const rankComparison = compareBidShapes(shapeA, shapeB);
  if (rankComparison === null || rankComparison !== 0) return rankComparison;
  return Math.sign(b.sequence - a.sequence);
}

export function canOutbid(candidate: Bid, highest: Bid | null): boolean {
  if (!classifyBid(candidate.cards)) return false;
  if (highest === null) return true;
  return compareBids(candidate, highest) === 1;
}

export function resolveWinningBid(bids: readonly Bid[]): Bid | null {
  if (bids.length === 0) return null;
  const firstShape = classifyBid(bids[0].cards);
  if (!firstShape) return null;
  const compatible = bids.filter(bid => {
    const shape = classifyBid(bid.cards);
    return shape !== null && compareBidShapes(shape, firstShape) !== null;
  });
  return compatible.reduce((highest, candidate) => {
    const comparison = compareBids(candidate, highest);
    return comparison !== null && comparison > 0 ? candidate : highest;
  });
}

export function hasAnyBidCandidate(hand: readonly Card[]): boolean {
  const counts = new Map<string, number>();
  for (const card of hand) {
    if (card.suit === 'joker') continue;
    const key = `${card.suit}:${card.rank}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some(count => count >= 2)) return true;
  for (const suit of ['clubs', 'spades', 'hearts', 'diamonds'] as const) {
    for (const pairCount of [2, 3]) {
      for (let start = 0; start < TRACTOR_RING.length; start += 1) {
        const ranks = Array.from({ length: pairCount }, (_, offset) => TRACTOR_RING[(start + offset) % TRACTOR_RING.length]);
        if (ranks.every(rank => (counts.get(`${suit}:${rank}`) ?? 0) >= 2)) return true;
      }
    }
  }
  return false;
}

export function tractorStart(cards: readonly Card[]): Rank | null {
  if (cards.length !== 4 && cards.length !== 6) return null;
  if (cards[0].suit === 'joker' || cards.some(card => card.suit !== cards[0].suit)) return null;

  const counts = new Map<Rank, number>();
  for (const card of cards) {
    const rank = card.rank as Rank;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  const pairCount = cards.length / 2;
  if (counts.size !== pairCount || [...counts.values()].some(count => count !== 2)) return null;

  const ranks = new Set(counts.keys());
  for (let index = 0; index < TRACTOR_RING.length; index += 1) {
    const sequence = Array.from({ length: pairCount }, (_, offset) => TRACTOR_RING[(index + offset) % TRACTOR_RING.length]);
    if (sequence.every(rank => ranks.has(rank))) return sequence[0];
  }
  return null;
}

function isSameFace(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}
