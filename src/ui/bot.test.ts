import { describe, expect, it } from 'vitest';
import { classifyBid } from '../game/bid.js';
import { createDeck, dealHands } from '../game/deck.js';
import { createGameState, recordBid } from '../game/engine.js';
import { validateFollow } from '../game/play/follow.js';
import { beginInteractiveTribute, preservesEverySuit, submitTributeOffer, submitTributeReturn } from '../game/tribute.js';
import type { Card, GameState } from '../game/types.js';
import { chooseBotBid, chooseBotCalledCard, chooseBotExchange, chooseBotPlay, chooseBotReturn, chooseBotTribute } from './bot.js';

function card(suit: Card['suit'], rank: Card['rank'], copy: 1 | 2 = 1): Card {
  const found = createDeck().find(item => item.suit === suit && item.rank === rank && item.copy === copy);
  if (!found) throw new Error(`Missing card ${suit} ${rank} ${copy}.`);
  return found;
}

function playState(leadCards: readonly Card[], hand: readonly Card[]): GameState {
  const state = createGameState(dealHands(createDeck()), 0);
  return {
    ...state,
    phase: 'play',
    dealer: 0,
    partner: 2,
    currentPlayer: 1,
    trumpSuit: 'clubs',
    lead: { player: 0, cards: leadCards },
    currentTrick: [{ player: 0, cards: leadCards }],
    players: [
      { id: 0, hand: [] },
      { id: 1, hand },
      { id: 2, hand: [] },
      { id: 3, hand: [] }
    ]
  };
}

describe('single-player bot decisions', () => {
  it.each(['higher pair', 'equal pair'] as const)('calls independently of a hidden %s', priorKind => {
    const ownPair = [card('clubs', 'Q'), card('clubs', 'Q', 2)];
    const priorRank = priorKind === 'equal pair' ? 'Q' : 'K';
    const priorCards = [card('hearts', priorRank), card('hearts', priorRank, 2)];
    const initial = createGameState([priorCards, ownPair, [], []], 0);
    const state = recordBid(initial, priorCards);

    expect(chooseBotBid(state)).toEqual(ownPair);
    expect(chooseBotBid(state)).toEqual(chooseBotBid({ ...state, bids: [] }));
    expect(recordBid(state, ownPair).bidTurn).toBe(2);
  });

  it('can race from any seat and respects the shape already locked by another player', () => {
    const ownPair = [card('clubs', 'K'), card('clubs', 'K', 2)];
    const tractor = [card('hearts', 'K'), card('hearts', 'K', 2), card('hearts', 'Q'), card('hearts', 'Q', 2)];
    const initial = createGameState([tractor, [], ownPair, []], 0);
    expect(chooseBotBid(initial, 2)).toEqual(ownPair);
    const locked = recordBid(initial, tractor, 0);
    expect(chooseBotBid(locked, 2)).toBeNull();
    const submitted = recordBid(initial, ownPair, 2);
    expect(chooseBotBid(submitted, 2)).toBeNull();
  });

  it('chooses a valid bid when the rules force it to call', () => {
    const initial = createGameState(dealHands(createDeck()), 0);
    const forced: GameState = { ...initial, forcedBidder: 0, currentPlayer: 0, bidTurn: 4 };
    const bid = chooseBotBid(forced);

    expect(bid).not.toBeNull();
    expect(classifyBid(bid ?? [])).not.toBeNull();
    expect(recordBid(forced, bid ?? []).forcedBidder).toBeNull();
  });

  it('follows the led side suit when it has that suit', () => {
    const lead = card('hearts', 'A');
    const hand = [card('hearts', '4'), card('spades', 'K')];
    const state = playState([lead], hand);
    const chosen = chooseBotPlay(state);

    expect(chosen).toHaveLength(1);
    expect(chosen[0].suit).toBe('hearts');
    expect(validateFollow(hand, chosen, state.lead, 'clubs').legal).toBe(true);
  });

  it('follows the required pairs when a tractor is led', () => {
    const lead = [card('hearts', 'A'), card('hearts', 'A', 2), card('hearts', 'K'), card('hearts', 'K', 2)];
    const hand = [
      card('hearts', 'Q'), card('hearts', 'Q', 2),
      card('hearts', 'J'), card('hearts', 'J', 2),
      card('hearts', '9'), card('hearts', '8')
    ];
    const state = playState(lead, hand);
    const chosen = chooseBotPlay(state);

    expect(chosen).toHaveLength(4);
    expect(validateFollow(hand, chosen, state.lead, 'clubs').legal).toBe(true);
  });

  it('returns the required number of cards without emptying a suit', () => {
    const state = createGameState(dealHands(createDeck()), 0);
    const dealerHand = [
      card('clubs', '4'), card('clubs', '4', 2),
      card('hearts', '4'), card('hearts', '4', 2),
      card('spades', '4'), card('diamonds', '4')
    ];
    const bidCards = [card('spades', 'A'), card('spades', 'A', 2)] as const;
    const shape = classifyBid(bidCards);
    if (!shape) throw new Error('Expected a pair bid.');
    const exchanging: GameState = {
      ...state,
      phase: 'exchange',
      currentPlayer: 0,
      dealer: 0,
      trumpSuit: 'clubs',
      pendingExchange: [1],
      bids: [{ player: 1, cards: bidCards, kind: 'pair', cardCount: 2, strength: shape.strength, sequence: 0 }],
      players: [
        { id: 0, hand: dealerHand },
        { id: 1, hand: bidCards },
        { id: 2, hand: [] },
        { id: 3, hand: [] }
      ]
    };
    const returned = chooseBotExchange(exchanging);

    expect(returned).toHaveLength(2);
    expect(preservesEverySuit(dealerHand, returned)).toBe(true);
  });

  it('calls a valid side-suit card held by exactly one other player', () => {
    const state = createGameState(dealHands(createDeck()), 0);
    const called = card('hearts', 'A');
    const duplicate = card('hearts', 'A', 2);
    const calling: GameState = {
      ...state,
      phase: 'partner-call',
      dealer: 0,
      currentPlayer: 0,
      trumpSuit: 'clubs',
      players: [
        { id: 0, hand: [called] },
        { id: 1, hand: [duplicate] },
        { id: 2, hand: [] },
        { id: 3, hand: [] }
      ]
    };

    expect(chooseBotCalledCard(calling)?.id).toBe(called.id);
  });
});

describe('bot interactive exchanges', () => {
  it('prefers small side cards, retains each side suit, and can fall back to trumps', () => {
    const hand = [card('clubs', '4'), card('clubs', 'K'), card('spades', 'A'), card('hearts', '4'), card('joker', 'BJ')];
    const returned = chooseBotReturn(hand, 3, 'hearts');
    expect(returned).toEqual([hand[0], hand[3], hand[4]]);
    expect(preservesEverySuit(hand, returned, 'hearts')).toBe(true);
  });

  it('makes a legal individual choice in each tribute stage', () => {
    const base = createGameState(dealHands(createDeck()), 0);
    let state = beginInteractiveTribute({ ...base, phase: 'round-end', dealer: 0, partner: 2, winnerTeam: 0, trumpSuit: 'hearts', scores: [140, 60] }, base.players);
    const random = Array.from({ length: 107 }, () => 0.6);
    for (let steps = 0; state.tribute?.stage !== 'complete' && steps < 4; steps++) {
      const cards = chooseBotTribute(state);
      state = state.tribute?.stage === 'offering'
        ? submitTributeOffer(state, state.currentPlayer, cards, random)
        : submitTributeReturn(state, state.currentPlayer, cards, random);
    }
    expect(state.tribute?.stage).toBe('complete');
    expect(state.players.map(player => player.hand.length)).toEqual([27, 27, 27, 27]);
  });
});
