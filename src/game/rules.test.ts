import { describe, expect, it } from 'vitest';
import { classifyBid, compareBidShapes } from './bid.js';
import { createDeck, dealHands, shuffleCards } from './deck.js';
import { callPartner, createGameState, passBid, recordBid, resolveBidding, revealedBids } from './engine.js';
import { classifyPlay } from './play/classify.js';
import { compareTrickPlays } from './play/compare.js';
import { validateFollow } from './play/follow.js';
import { lastTrickMultiplier, scoreCards, scoreTrick } from './score.js';
import { beginTributePhase, hasAntiSupply, chooseTributeCards, preservesEverySuit, supplyCount, splitTeamQuota } from './tribute.js';
import { compareTrumpCards, isTrump, sortHandForDisplay } from './trump.js';
import type { Card, CardRank, CardSuit, GameState, Play } from './types.js';

function card(suit: CardSuit, rank: CardRank, copy: 1 | 2 = 1): Card {
  return { id: `${suit}-${rank}-${copy}`, suit, rank, copy };
}

describe('deck', () => {
  it('creates and deals two standard decks', () => {
    const cards = createDeck();
    expect(cards).toHaveLength(108);
    expect(new Set(cards.map(item => item.id)).size).toBe(108);
    expect(dealHands(cards).map(hand => hand.length)).toEqual([27, 27, 27, 27]);
  });

  it('shuffles a copy without changing the source deck', () => {
    const cards = createDeck();
    const shuffled = shuffleCards(cards, Array.from({ length: 107 }, () => 0.42));
    expect(cards[0].id).toBe('clubs-A-1');
    expect(new Set(shuffled.map(item => item.id)).size).toBe(108);
    expect(shuffled).not.toEqual(cards);
  });
});

describe('game state transitions', () => {
  it('resolves a pair call and assigns the unique holder of the called card', () => {
    const hands = dealHands(createDeck());
    let state = createGameState(hands, 0);
    const openingPair = hands[0].filter(item => item.suit === 'clubs' && item.rank === 'A');
    state = recordBid(state, openingPair);
    expect(state.bidsRevealed).toBe(false);
    expect(revealedBids(state)).toHaveLength(0);
    state = passBid(state);
    state = passBid(state);
    state = passBid(state);
    state = resolveBidding(state);
    expect(state.bidsRevealed).toBe(true);
    expect(revealedBids(state)).toHaveLength(1);
    expect(state.dealer).toBe(0);
    expect(state.trumpSuit).toBe('clubs');
    const called = hands[0].find(item => item.suit === 'spades' && item.rank === 'A');
    if (!called) throw new Error('Expected the first hand to contain a spade ace.');
    state = callPartner(state, called);
    expect(state.partner).toBe(1);
    expect(state.phase).toBe('play');
  });

  it('forces the first eligible player in dealer order to call after four passes', () => {
    const hands = dealHands(createDeck());
    let state = createGameState(hands, 1);
    state = passBid(state);
    state = passBid(state);
    state = passBid(state);
    state = passBid(state);
    state = resolveBidding(state);
    expect(state.forcedBidder).toBe(1);
    expect(state.currentPlayer).toBe(1);
    const pair = hands[1].filter(item => item.suit === 'spades' && item.rank === 'K');
    state = recordBid(state, pair);
    state = resolveBidding(state);
    expect(state.dealer).toBe(1);
    expect(state.bidsRevealed).toBe(true);
  });

  it('applies full-supply calling limits to the prior winning team', () => {
    const hands = dealHands(createDeck());
    const winnerStarts = createGameState(hands, 1, { fullSupply: true, previousLosingTeam: [0, 2] });
    const winnerPair = hands[1].filter(item => item.suit === 'spades' && item.rank === 'K');
    expect(() => recordBid(winnerStarts, winnerPair)).toThrow('满供时只能由上一局输家先叫庄');
    const loserStarts = createGameState(hands, 0, { fullSupply: true, previousLosingTeam: [0, 2] });
    const loserPair = hands[0].filter(item => item.suit === 'clubs' && item.rank === 'A');
    expect(recordBid(loserStarts, loserPair).bids).toHaveLength(1);
  });
});

describe('trumps and bids', () => {
  it('orders special trumps before ordinary main-suit cards', () => {
    const cards = [
      card('hearts', '5'), card('joker', 'BJ'), card('joker', 'SJ'),
      card('clubs', '5'), card('hearts', '3'), card('clubs', '3'),
      card('hearts', '2'), card('clubs', '2'), card('hearts', 'A')
    ];
    expect(cards.every(item => isTrump(item, 'hearts'))).toBe(true);
    for (let index = 0; index < cards.length - 1; index += 1) {
      expect(compareTrumpCards(cards[index], cards[index + 1], 'hearts')).toBeGreaterThan(0);
    }
  });

  it('keeps pair and tractor bids in separate comparison groups', () => {
    const pairK = classifyBid([card('clubs', 'K', 1), card('clubs', 'K', 2)]);
    const pairA = classifyBid([card('spades', 'A', 1), card('spades', 'A', 2)]);
    const tractor = classifyBid([
      card('hearts', '7', 1), card('hearts', '7', 2),
      card('hearts', '6', 1), card('hearts', '6', 2)
    ]);
    expect(pairK).not.toBeNull();
    expect(pairA).not.toBeNull();
    expect(tractor).not.toBeNull();
    if (pairK && pairA && tractor) {
      expect(compareBidShapes(pairK, pairA)).toBeGreaterThan(0);
      expect(compareBidShapes(pairK, tractor)).toBeNull();
    }
  });

  it('sorts pre-trump hands by suit and ascending value, then trump-first by strength', () => {
    const hand = [
      card('hearts', 'A'), card('clubs', '4'), card('clubs', '2'),
      card('spades', 'A'), card('spades', '4'), card('diamonds', '5'), card('joker', 'BJ')
    ];
    const beforeTrump = sortHandForDisplay(hand, null);
    expect(beforeTrump.slice(0, 3).map(item => item.id)).toEqual(['clubs-2-1', 'diamonds-5-1', 'joker-BJ-1']);
    expect(beforeTrump.slice(3).map(item => item.id)).toEqual(['clubs-4-1', 'spades-4-1', 'spades-A-1', 'hearts-A-1']);
    const afterTrump = sortHandForDisplay(hand, 'hearts');
    expect(afterTrump.slice(0, 4).map(item => item.id)).toEqual(['joker-BJ-1', 'diamonds-5-1', 'clubs-2-1', 'hearts-A-1']);
    expect(afterTrump.slice(4).map(item => item.id)).toEqual(['clubs-4-1', 'spades-A-1', 'spades-4-1']);
  });
});

describe('play rules', () => {
  it('recognizes a tractor and marks special-rank tractors as side tractors', () => {
    const mainTractor = [
      card('hearts', '7', 1), card('hearts', '7', 2),
      card('hearts', '6', 1), card('hearts', '6', 2)
    ];
    const specialTractor = [
      card('hearts', '3', 1), card('hearts', '3', 2),
      card('hearts', '2', 1), card('hearts', '2', 2)
    ];
    expect(classifyPlay(mainTractor, 'hearts').mainTrump).toBe(true);
    expect(classifyPlay(specialTractor, 'hearts').mainTrump).toBe(true);
  });

  it('treats a 2233 tractor in a side suit as a trump lead', () => {
    const lead: Play = {
      player: 0,
      cards: [card('spades', '2', 1), card('spades', '2', 2), card('spades', '3', 1), card('spades', '3', 2)]
    };
    const hand = [
      card('hearts', 'A'), card('hearts', 'K'),
      card('spades', 'A'), card('diamonds', 'A')
    ];
    expect(validateFollow(hand, [hand[2], hand[3]], lead, 'hearts').legal).toBe(false);
    expect(validateFollow(hand, [hand[0], hand[1], hand[2], hand[3]], lead, 'hearts').legal).toBe(true);
  });

  it('requires a player to follow the led side suit when held', () => {
    const led = card('clubs', 'K');
    const hand = [card('clubs', 'A'), card('spades', 'A')];
    const lead: Play = { player: 0, cards: [led] };
    expect(validateFollow(hand, [hand[1]], lead, 'hearts').legal).toBe(false);
    expect(validateFollow(hand, [hand[0]], lead, 'hearts').legal).toBe(true);
  });

  it('does not count a same-suit 2/3/5 trump as following a side-suit pair', () => {
    const lead: Play = {
      player: 0,
      cards: [card('clubs', '9', 1), card('clubs', '9', 2)]
    };
    const hand = [
      card('clubs', '3', 1), card('clubs', '3', 2),
      card('spades', 'Q'), card('diamonds', 'A')
    ];
    expect(validateFollow(hand, [hand[2], hand[3]], lead, 'hearts').legal).toBe(true);
  });

  it('compares a main tractor above a side tractor', () => {
    const lead: Play = {
      player: 0,
      cards: [card('clubs', 'A', 1), card('clubs', 'A', 2), card('clubs', 'K', 1), card('clubs', 'K', 2)]
    };
    const main: Play = {
      player: 1,
      cards: [card('hearts', '7', 1), card('hearts', '7', 2), card('hearts', '6', 1), card('hearts', '6', 2)]
    };
    const side: Play = {
      player: 2,
      cards: [card('clubs', 'A', 1), card('clubs', 'A', 2), card('clubs', 'K', 1), card('clubs', 'K', 2)]
    };
    expect(compareTrickPlays(main, side, lead, 'hearts')).toBeGreaterThan(0);
  });
});

describe('score and tribute', () => {
  it('counts points and applies bottom multipliers only to the final trick', () => {
    const points = [card('clubs', 'K'), card('diamonds', '5')];
    expect(scoreCards(points)).toBe(15);
    expect(scoreTrick(points, 2, true)).toEqual({ points: 30, multiplier: 2 });
    expect(lastTrickMultiplier(4)).toBe(3);
    expect(lastTrickMultiplier(6)).toBe(4);
  });

  it('caps tribute, assigns an odd card by dealer proximity, and keeps pairs intact', () => {
    expect(supplyCount(19)).toBe(0);
    expect(supplyCount(180)).toBe(8);
    expect(splitTeamQuota(5, [0, 2], 1)).toEqual([2, 3]);
    const hand = [card('hearts', '5', 1), card('hearts', '5', 2), card('clubs', '3')];
    expect(chooseTributeCards(hand, 1, 'hearts')).toEqual([hand[2]]);
  });

  it('detects full-supply defense and prevents returning a whole suit', () => {
    const hand = [card('hearts', '5', 1), card('hearts', '5', 2)];
    expect(hasAntiSupply(hand, 'hearts')).toBe(true);
    const fourSuits = [card('clubs', 'A'), card('spades', 'A'), card('hearts', 'A'), card('diamonds', 'A')];
    expect(preservesEverySuit(fourSuits, [fourSuits[0]])).toBe(false);
    expect(preservesEverySuit(fourSuits, [fourSuits[0], fourSuits[1]])).toBe(false);
  });

  it('enters a visible tribute phase after exchanging cards', () => {
    const roundEnd: GameState = {
      ...createGameState(dealHands(createDeck()), 0),
      phase: 'round-end', dealer: 0, partner: 2, trumpSuit: 'clubs', winnerTeam: 0
    };
    const returned = card('hearts', '4');
    const offered = card('hearts', '5');
    const dealtPlayers: GameState['players'] = [
      { id: 0, hand: [card('clubs', '4'), card('spades', '4'), returned, card('hearts', 'K'), card('diamonds', '4')] },
      { id: 1, hand: [offered] },
      { id: 2, hand: [] },
      { id: 3, hand: [] }
    ];

    const tribute = beginTributePhase(roundEnd, dealtPlayers, [
      { from: 1, to: 0, offered: [offered], returned: [returned] }
    ]);

    expect(tribute.phase).toBe('tribute');
    expect(tribute.tributeExchanges).toHaveLength(1);
    expect(tribute.players[0].hand.map(item => item.id)).toContain(offered.id);
    expect(tribute.players[1].hand.map(item => item.id)).toContain(returned.id);
  });
});
