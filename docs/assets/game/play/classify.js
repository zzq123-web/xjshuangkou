import { tractorStart } from '../bid.js';
import { isTrump } from '../trump.js';
                                                              

export function classifyPlay(cards                 , trumpSuit      )                 {
  if (cards.length === 0) return { kind: 'other', suit: null, mainTrump: false, tractorStart: null, cardCount: 0 };
  if (cards.length === 1) {
    return { kind: 'single', suit: cards[0].suit, mainTrump: isTrump(cards[0], trumpSuit), tractorStart: null, cardCount: 1 };
  }
  if (cards.length === 2 && isPair(cards)) {
    return { kind: 'pair', suit: cards[0].suit, mainTrump: isTrump(cards[0], trumpSuit), tractorStart: null, cardCount: 2 };
  }
  const start = tractorStart(cards);
  if (start !== null) {
    const mainTrump = cards.every(card => isTrump(card, trumpSuit));
    return { kind: 'tractor', suit: cards[0].suit, mainTrump, tractorStart: start, cardCount: cards.length };
  }
  return { kind: 'other', suit: null, mainTrump: false, tractorStart: null, cardCount: cards.length };
}

export function isPair(cards                 )          {
  return cards.length === 2 && cards[0].suit === cards[1].suit && cards[0].rank === cards[1].rank;
}
