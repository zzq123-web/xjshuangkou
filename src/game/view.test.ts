import { describe, expect, it } from 'vitest';
import { createGameState } from './engine.js';
import { createDeck, dealHands } from './deck.js';
import { eventLabel, gameForPlayer, visibleEvents } from './view.js';
import type { GameState } from './types.js';

describe('per-player information', () => {
  it('redacts private events and both submission pools from every other seat', () => {
    const base = createGameState(dealHands(createDeck()), 0);
    const secret = base.players[0].hand[0];
    const state: GameState = { ...base, phase: 'tribute', partner: 2,
      events: [{ kind: 'tribute-offer', player: 0, viewer: 0, cards: [secret], round: 2 }],
      tributeExchanges: [{ from: 0, to: 1, offered: [secret], returned: [] }],
      tribute: { stage: 'returning', winners: [1, 3], losers: [0, 2], offerCounts: [1, 0, 0, 0], receiveCounts: [0, 1, 0, 0], offers: [[secret], [], [], []], returns: [[secret], null, [], []], antiSupply: false }
    };
    const before = JSON.stringify(state);
    for (const viewer of [1, 2, 3] as const) {
      const projected = gameForPlayer(state, viewer);
      expect(JSON.stringify(projected)).not.toContain(secret.id);
      expect(projected.tribute?.offers[0]).toEqual([]);
      expect(projected.tribute?.returns[1]).toBeNull();
      expect(projected.events).toEqual([]);
    }
    expect(gameForPlayer(state, 0).events).toEqual(state.events);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('shows public play cards to everyone and never makes old private events public at round end', () => {
    const base = createGameState(dealHands(createDeck()), 0);
    const cards = base.players[0].hand.slice(0, 2);
    const state: GameState = { ...base, phase: 'round-end', events: [
      { round: 1, kind: 'bid-return', player: 0, viewer: 0, cards },
      { round: 1, kind: 'play', player: 0, viewer: null, cards }
    ] };
    expect(visibleEvents(state, 1).map(event => event.kind)).toEqual(['play']);
    expect(eventLabel(visibleEvents(state, 1)[0], '甲')).toContain('甲出牌：♣A ♣A');
  });
});
