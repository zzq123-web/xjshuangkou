import { describe, expect, it } from 'vitest';
import { createDeck, dealHands } from './deck.js';
import { createGameState } from './engine.js';
import { beginInteractiveTribute, chooseTributeCards, preservesEverySuit, submitTributeOffer, submitTributeReturn, validateTributeSelection } from './tribute.js';
import type { Card, GameState } from './types.js';

const deck = createDeck();
const random = Array.from({ length: 107 }, () => 0.37);
const card = (id: string): Card => {
  const value = deck.find(item => item.id === id);
  if (!value) throw new Error(id);
  return value;
};
function end(): GameState {
  return { ...createGameState(dealHands(deck), 0), phase: 'round-end', dealer: 0, partner: 2, trumpSuit: 'hearts', winnerTeam: 0, scores: [140, 60] };
}
function dealWithShortage(): GameState['players'] {
  const regular = deck.filter(item => item.suit !== 'joker' && !['2', '3', '5'].includes(item.rank));
  const loser1 = [card('joker-SJ-1'), ...regular.slice(0, 26)];
  const loser3 = regular.slice(26, 53);
  const used = new Set([...loser1, ...loser3].map(item => item.id));
  const rest = deck.filter(item => !used.has(item.id));
  return [{ id: 0, hand: rest.slice(0, 27) }, { id: 1, hand: loser1 }, { id: 2, hand: rest.slice(27) }, { id: 3, hand: loser3 }];
}

describe('interactive tribute', () => {
  it('waits for each choice and distributes both pools only after their submissions', () => {
    const original = end();
    const copy = JSON.stringify(original);
    let state = beginInteractiveTribute(original, original.players);
    expect(state.players).toEqual(original.players);
    expect(state.tribute?.stage).toBe('offering');
    const initialHands = state.players.map(player => new Set(player.hand.map(item => item.id)));
    const first = state.currentPlayer;
    const chosen = chooseTributeCards(state.players[first].hand, state.tribute!.offerCounts[first], 'hearts');
    state = submitTributeOffer(state, first, chosen, random);
    expect(state.tribute?.stage).toBe('offering');
    expect(state.players[0].hand).toHaveLength(27);
    const second = state.currentPlayer;
    state = submitTributeOffer(state, second, chooseTributeCards(state.players[second].hand, state.tribute!.offerCounts[second], 'hearts'), random);
    expect(state.tribute?.stage).toBe('returning');
    expect(state.players[0].hand).toHaveLength(29);
    expect(() => submitTributeReturn(state, first, [], random)).toThrow();
    for (let turn = 0; turn < 2; turn++) {
      const id = state.currentPlayer;
      const incoming = state.players[id].hand.filter(item => !initialHands[id].has(item.id));
      state = submitTributeReturn(state, id, incoming, random);
      if (turn === 0) expect(state.players[first].hand).toHaveLength(25);
    }
    expect(state.tribute?.stage).toBe('complete');
    expect(state.players.map(player => player.hand.length)).toEqual([27, 27, 27, 27]);
    expect(new Set(state.players.flatMap(player => player.hand.map(item => item.id))).size).toBe(108);
    expect(state.events?.map(event => event.kind)).toEqual(['tribute-offer', 'tribute-offer', 'tribute-receive', 'tribute-receive', 'tribute-return', 'tribute-return', 'return-receive', 'return-receive']);
    expect(JSON.stringify(original)).toBe(copy);
  });

  it('uses actual tribute counts and returns exactly each loser’s contribution', () => {
    const players = dealWithShortage();
    let state = beginInteractiveTribute(end(), players);
    expect(state.tribute?.offerCounts).toEqual([0, 1, 0, 0]);
    state = submitTributeOffer(state, 1, [card('joker-SJ-1')], random);
    expect(state.tribute?.receiveCounts).toEqual([1, 0, 0, 0]);
    state = submitTributeReturn(state, 0, [card('joker-SJ-1')], random);
    expect(state.players.map(player => player.hand.length)).toEqual([27, 27, 27, 27]);
    expect(state.players[3].hand).toEqual(players[3].hand);
  });

  it('validates priority, ownership, duplicate choices and intact pairs', () => {
    const hand = [card('hearts-5-1'), card('hearts-5-2'), card('clubs-3-1'), card('clubs-2-1')];
    expect(() => validateTributeSelection(hand, [hand[0]], 1, 'hearts')).toThrow('对子');
    expect(() => validateTributeSelection(hand, [hand[3]], 1, 'hearts')).toThrow('优先');
    expect(() => validateTributeSelection(hand, [hand[2], hand[2]], 2, 'hearts')).toThrow();
    expect(() => validateTributeSelection(hand, [card('joker-BJ-1')], 1, 'hearts')).toThrow();
    expect(() => validateTributeSelection(hand, [hand[2]], 1, 'hearts')).not.toThrow();
  });

  it('accepts equally strong tribute faces chosen by the player', () => {
    const hand = [card('clubs-3-1'), card('spades-3-1')];
    expect(() => validateTributeSelection(hand, [hand[1]], 1, 'hearts')).not.toThrow();
  });

  it('protects side suits only, allowing all trumps including received tribute to be returned', () => {
    const hand = [card('clubs-4-1'), card('clubs-2-1'), card('hearts-A-1'), card('joker-BJ-1')];
    expect(preservesEverySuit(hand, [hand[0]], 'hearts')).toBe(false);
    expect(preservesEverySuit(hand, hand.slice(1), 'hearts')).toBe(true);
    expect(preservesEverySuit(hand, [hand[1], hand[1]], 'hearts')).toBe(false);
  });

  it('skips tribute on a draw without leaking or moving cards', () => {
    const state = beginInteractiveTribute({ ...end(), winnerTeam: null }, end().players);
    expect(state.tribute?.stage).toBe('complete');
    expect(state.players).toEqual(end().players);
    expect(state.events ?? []).toEqual([]);
  });
});
