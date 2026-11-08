import type { Card, Rank, Suit } from './types.js';

const SPECIAL_TRUMP_RANKS: ReadonlySet<Rank> = new Set(['2', '3', '5']);
const SIDE_RANKS: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '4'];
const RANKS: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUIT_ORDER: readonly Suit[] = ['clubs', 'spades', 'hearts', 'diamonds'];
const ASCENDING_RANKS: readonly Rank[] = ['4', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ASCENDING_FIXED_TRUMPS: readonly Rank[] = ['2', '3', '5'];

export function isTrump(card: Card, trumpSuit: Suit): boolean {
  return card.suit === 'joker' || card.suit === trumpSuit || SPECIAL_TRUMP_RANKS.has(card.rank as Rank);
}

export function isSpecialTrumpRank(rank: Card['rank']): boolean {
  return rank !== 'BJ' && rank !== 'SJ' && SPECIAL_TRUMP_RANKS.has(rank);
}

export function trumpStrength(card: Card, trumpSuit: Suit): number {
  if (card.rank === '5' && card.suit === trumpSuit) return 1000;
  if (card.rank === 'BJ') return 990;
  if (card.rank === 'SJ') return 980;
  if (card.rank === '5') return 970;
  if (card.rank === '3' && card.suit === trumpSuit) return 960;
  if (card.rank === '3') return 950;
  if (card.rank === '2' && card.suit === trumpSuit) return 940;
  if (card.rank === '2') return 930;
  if (card.suit === trumpSuit) return 900 - RANKS.indexOf(card.rank as Rank);
  return -1;
}

export function sideStrength(card: Card): number {
  if (card.suit === 'joker' || isSpecialTrumpRank(card.rank)) return -1;
  const index = SIDE_RANKS.indexOf(card.rank as Rank);
  return index < 0 ? -1 : SIDE_RANKS.length - index;
}

export function compareTrumpCards(a: Card, b: Card, trumpSuit: Suit): number {
  if (!isTrump(a, trumpSuit) || !isTrump(b, trumpSuit)) {
    throw new Error('compareTrumpCards accepts only trump cards.');
  }
  return Math.sign(trumpStrength(a, trumpSuit) - trumpStrength(b, trumpSuit));
}

export function compareCardValues(a: Card, b: Card, trumpSuit: Suit): number {
  const aTrump = isTrump(a, trumpSuit);
  const bTrump = isTrump(b, trumpSuit);
  if (aTrump !== bTrump) return aTrump ? 1 : -1;
  if (aTrump) return compareTrumpCards(a, b, trumpSuit);
  return Math.sign(sideStrength(a) - sideStrength(b));
}

export function sortHandForDisplay(hand: readonly Card[], trumpSuit: Suit | null): readonly Card[] {
  return [...hand].sort((a, b) => trumpSuit === null
    ? compareBeforeTrump(a, b)
    : compareAfterTrump(a, b, trumpSuit));
}

function compareBeforeTrump(a: Card, b: Card): number {
  const aFixed = a.suit === 'joker' || isSpecialTrumpRank(a.rank);
  const bFixed = b.suit === 'joker' || isSpecialTrumpRank(b.rank);
  if (aFixed !== bFixed) return aFixed ? -1 : 1;
  if (aFixed && bFixed) {
    if (a.suit === 'joker' && b.suit !== 'joker') return 1;
    if (a.suit !== 'joker' && b.suit === 'joker') return -1;
    if (a.suit !== b.suit) return suitIndex(a.suit) - suitIndex(b.suit);
    return fixedRankAscending(a) - fixedRankAscending(b) || a.id.localeCompare(b.id);
  }
  if (a.suit !== b.suit) return suitIndex(a.suit) - suitIndex(b.suit);
  return ascendingRank(a) - ascendingRank(b) || a.id.localeCompare(b.id);
}

function compareAfterTrump(a: Card, b: Card, trumpSuit: Suit): number {
  const aTrump = isTrump(a, trumpSuit);
  const bTrump = isTrump(b, trumpSuit);
  if (aTrump !== bTrump) return aTrump ? -1 : 1;
  if (aTrump) {
    return trumpStrength(b, trumpSuit) - trumpStrength(a, trumpSuit)
      || suitIndex(a.suit) - suitIndex(b.suit)
      || a.id.localeCompare(b.id);
  }
  return suitIndex(a.suit) - suitIndex(b.suit)
    || sideStrength(b) - sideStrength(a)
    || a.id.localeCompare(b.id);
}

function suitIndex(suit: Card['suit']): number {
  return suit === 'joker' ? SUIT_ORDER.length : SUIT_ORDER.indexOf(suit);
}

function fixedRankAscending(card: Card): number {
  if (card.rank === 'SJ') return ASCENDING_FIXED_TRUMPS.length;
  if (card.rank === 'BJ') return ASCENDING_FIXED_TRUMPS.length + 1;
  return ASCENDING_FIXED_TRUMPS.indexOf(card.rank as Rank);
}

function ascendingRank(card: Card): number {
  return ASCENDING_RANKS.indexOf(card.rank as Rank);
}
