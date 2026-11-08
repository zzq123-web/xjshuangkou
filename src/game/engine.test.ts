import { describe, expect, it } from 'vitest';
import { createDeck, dealHands } from './deck.js';
import { bidReturnCount, createGameState, exchangeBidCards, playTurn, recordBid, resolveBidding, resumeAfterTribute } from './engine.js';
import { isTrump } from './trump.js';
import { beginInteractiveTribute } from './tribute.js';
import type { Card, GameState } from './types.js';

function fourBids(): GameState {
  const deck = createDeck();
  const calls = (['clubs', 'spades', 'hearts', 'diamonds'] as const).map((suit, index) => deck.filter(card => card.suit === suit && card.rank === (index === 0 ? 'K' : 'Q')));
  const used = new Set(calls.flatMap(cards => cards.map(card => card.id)));
  const rest = deck.filter(card => !used.has(card.id));
  const hands = calls.map((cards, index) => [...cards, ...rest.slice(index * 25, (index + 1) * 25)]);
  let state = createGameState([hands[0], hands[1], hands[2], hands[3]], 0);
  for (const id of [0, 1, 2, 3] as const) state = recordBid(state, calls[id], id);
  return resolveBidding(state);
}

describe('pooled bidding exchange and events', () => {
  it('collects all exposed bids, then waits for one complete manual selection', () => {
    const state = fourBids();
    expect(state.players.map(player => player.hand.length)).toEqual([33, 25, 25, 25]);
    expect(bidReturnCount(state)).toBe(6);
    expect(state.phase).toBe('exchange');
    const returned = state.players[0].hand.filter(card => isTrump(card, 'clubs')).slice(0, 6);
    expect(() => exchangeBidCards(state, returned.slice(0, 2), [0, 0, 0, 0, 0])).toThrow('一次选齐6张');
    const before = JSON.stringify(state);
    const next = exchangeBidCards(state, returned, [0, 0, 0, 0, 0]);
    expect(next.players.map(player => player.hand.length)).toEqual([27, 27, 27, 27]);
    expect(new Set(next.players.flatMap(player => player.hand.map(card => card.id))).size).toBe(108);
    expect(next.phase).toBe('partner-call');
    expect(next.pendingExchange).toEqual([]);
    expect(next.events?.find(event => event.kind === 'bid-return')?.cards).toEqual(returned);
    for (const id of [1, 2, 3]) expect(next.events?.find(event => event.player === id && event.kind === 'bid-receive')?.cards).toHaveLength(2);
    const another = exchangeBidCards(state, returned, [0.99, 0.99, 0.99, 0.99, 0.99]);
    expect(another.players[1].hand).not.toEqual(next.players[1].hand);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('records every public play including the last play that clears the trick', () => {
    const cards = createDeck().filter(card => card.suit === 'clubs' && ['A', 'K', 'Q', 'J'].includes(card.rank) && card.copy === 1);
    let state: GameState = { ...createGameState([[cards[0]], [cards[1]], [cards[2]], [cards[3]]], 0), phase: 'play', dealer: 0, partner: 2, trumpSuit: 'hearts' };
    for (const id of [0, 1, 2, 3] as const) state = playTurn(state, id, [cards[id]]);
    expect(state.events?.filter(event => event.kind === 'play')).toHaveLength(4);
    expect(state.events?.at(-1)).toMatchObject({ player: 3, viewer: null, cards: [cards[3]] });
  });

  it('keeps private exchange history when the next bidding round begins', () => {
    const previous: GameState = { ...createGameState(dealHands(createDeck()), 0), phase: 'round-end', winnerTeam: null,
      events: [{ kind: 'bid-return', round: 1, player: 0, viewer: 0, cards: [] as Card[] }] };
    const staged = beginInteractiveTribute(previous, previous.players);
    const next = resumeAfterTribute(staged);
    expect(next.phase).toBe('bidding');
    expect(next.events).toEqual(previous.events);
    expect(next.roundNumber).toBe(2);
  });
});
