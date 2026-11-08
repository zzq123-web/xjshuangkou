import type { Card, CardRank, Rank, Suit } from './types.js';

export const SUITS: readonly Suit[] = ['clubs', 'spades', 'hearts', 'diamonds'];
export const RANKS: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];

export type Hands = readonly [readonly Card[], readonly Card[], readonly Card[], readonly Card[]];

export function createDeck(): readonly Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push(makeCard(suit, rank, 1), makeCard(suit, rank, 2));
    }
  }
  cards.push(makeCard('joker', 'BJ', 1), makeCard('joker', 'BJ', 2));
  cards.push(makeCard('joker', 'SJ', 1), makeCard('joker', 'SJ', 2));
  return cards;
}

export function shuffleCards(cards: readonly Card[], randomValues: readonly number[]): readonly Card[] {
  if (randomValues.length < cards.length - 1) throw new RangeError('Provide one random value for each shuffle step.');
  const shuffled = [...cards];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const sample = randomValues[shuffled.length - 1 - i];
    if (sample === undefined || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError('Random values must be finite numbers in [0, 1).');
    }
    const j = Math.floor(sample * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function dealHands(cards: readonly Card[]): Hands {
  if (cards.length !== 108) throw new RangeError(`Expected 108 cards, received ${cards.length}.`);
  if (new Set(cards.map(card => card.id)).size !== 108) throw new Error('Card IDs must be unique.');
  return [cards.slice(0, 27), cards.slice(27, 54), cards.slice(54, 81), cards.slice(81, 108)];
}

export function shuffleAndDeal(randomValues: readonly number[]): Hands {
  return dealHands(shuffleCards(createDeck(), randomValues));
}

function makeCard(suit: Card['suit'], rank: CardRank, copy: 1 | 2): Card {
  return { id: `${suit}-${rank}-${copy}`, suit, rank, copy };
}
