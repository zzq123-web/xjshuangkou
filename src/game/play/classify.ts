import { tractorStart } from '../bid.js';
import { isTrump, isSpecialTrumpRank } from '../trump.js';
import type { Card, ClassifiedPlay, Suit } from '../types.js';

export function classifyPlay(cards: readonly Card[], trumpSuit: Suit): ClassifiedPlay {
  if (cards.length === 0) return { kind: 'other', suit: null, mainTrump: false, tractorStart: null, cardCount: 0 };
  if (cards.length === 1) {
    return { kind: 'single', suit: cards[0].suit, mainTrump: isTrump(cards[0], trumpSuit), tractorStart: null, cardCount: 1 };
  }
  if (cards.length === 2 && isPair(cards)) {
    return { kind: 'pair', suit: cards[0].suit, mainTrump: isTrump(cards[0], trumpSuit), tractorStart: null, cardCount: 2 };
  }
  const start = tractorStart(cards);
  if (start !== null) {
    const mainTrump = cards[0].suit === trumpSuit && !cards.some(card => isSpecialTrumpRank(card.rank));
    return { kind: 'tractor', suit: cards[0].suit, mainTrump, tractorStart: start, cardCount: cards.length };
  }
  return { kind: 'other', suit: null, mainTrump: false, tractorStart: null, cardCount: cards.length };
}

export function isPair(cards: readonly Card[]): boolean {
  return cards.length === 2 && cards[0].suit === cards[1].suit && cards[0].rank === cards[1].rank;
}
