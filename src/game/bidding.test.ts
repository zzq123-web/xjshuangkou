import { describe, expect, it } from 'vitest';
import { createGameState, passBid, recordBid, resolveBidding, revealedBids } from './engine.js';
import type { Card, Rank, Suit } from './types.js';

function pair(suit: Suit, rank: Rank): readonly [Card, Card] {
  return [
    { id: `${suit}-${rank}-1`, suit, rank, copy: 1 },
    { id: `${suit}-${rank}-2`, suit, rank, copy: 2 }
  ];
}

describe('independent sealed calls', () => {
  it('accepts weaker and equal pairs, keeping all calls sealed until the final comparison', () => {
    const calls = [pair('clubs', 'K'), pair('hearts', 'Q'), pair('spades', 'K'), pair('diamonds', 'J')] as const;
    const initial = createGameState(calls, 0);
    let state = initial;
    for (const cards of calls) {
      state = recordBid(state, cards);
      expect(state.dealer).toBeNull();
      expect(revealedBids(state)).toEqual([]);
    }
    expect(initial.bids).toEqual([]);
    expect(initial.bidTurn).toBe(0);
    expect(state.bids).toHaveLength(4);

    const resolved = resolveBidding(state);
    expect(resolved.dealer).toBe(0);
    expect(resolved.trumpSuit).toBe('clubs');
    expect(revealedBids(resolved)).toHaveLength(4);
    expect(resolved.pendingExchange).toEqual([1, 2, 3]);
  });

  it('chooses the strongest pair after everyone has submitted or passed', () => {
    const calls = [pair('clubs', 'Q'), pair('hearts', 'J'), pair('spades', 'K'), []] as const;
    let state = createGameState(calls, 0);
    state = recordBid(state, calls[0]);
    expect(() => resolveBidding(state)).toThrow();
    state = recordBid(state, calls[1]);
    state = recordBid(state, calls[2]);
    state = passBid(state);

    const resolved = resolveBidding(state);
    expect(resolved.dealer).toBe(2);
    expect(resolved.trumpSuit).toBe('spades');
    expect(resolved.pendingExchange).toEqual([0, 1]);
  });

  it.each([4, 6] as const)('locks the first %i-card tractor shape but accepts a weaker matching tractor', count => {
    const tractor = [...pair('hearts', 'K'), ...pair('hearts', 'Q'), ...(count === 6 ? pair('hearts', 'J') : [])];
    const pairK = pair('clubs', 'K');
    const weaker = [...pair('spades', '9'), ...pair('spades', '8'), ...(count === 6 ? pair('spades', '7') : [])];
    const first = recordBid(createGameState([tractor, [...pairK, ...weaker], [], []], 0), tractor);
    expect(() => recordBid(first, pairK)).toThrow('首家已锁定');
    expect(recordBid(first, weaker).bids).toHaveLength(2);
    expect(first.bidRequirement).toEqual({ kind: 'tractor', cardCount: count });
    expect(first.bidTurn).toBe(1);
  });

  it('uses arrival order instead of seat order, and prevents duplicate bids or passes', () => {
    const calls = [pair('clubs', 'K'), pair('hearts', 'Q'), pair('spades', 'K'), pair('diamonds', 'J')] as const;
    let state = createGameState(calls, 0);
    state = recordBid(state, calls[2], 2);
    expect(state.bidRequirement).toEqual({ kind: 'pair', cardCount: 2 });
    expect(state.bidResponded).toEqual([2]);
    expect(() => recordBid(state, calls[2], 2)).toThrow('已完成');
    expect(() => passBid(state, 2)).toThrow('已完成');
    state = passBid(state, 3);
    expect(() => recordBid(state, calls[3], 3)).toThrow('已完成');
    state = recordBid(state, calls[0], 0);
    state = recordBid(state, calls[1], 1);
    expect(state.bidResponded).toEqual([2, 3, 0, 1]);
    expect(resolveBidding(state).dealer).toBe(2);
  });

  it('does not lock a shape on a pass or an invalid call, and rejects a tractor after a pair', () => {
    const ownPair = pair('clubs', 'K');
    const tractor = [...pair('hearts', 'K'), ...pair('hearts', 'Q')];
    let state = createGameState([ownPair, tractor, [], []], 0);
    state = passBid(state, 3);
    expect(state.bidRequirement).toBeNull();
    expect(() => recordBid(state, [ownPair[0]], 0)).toThrow('请选择同花色');
    expect(state.bidRequirement).toBeNull();
    state = recordBid(state, ownPair, 0);
    expect(() => recordBid(state, tractor, 1)).toThrow('对子（2张）');
    expect(state.bidResponded).toEqual([3, 0]);
  });

  it('requires later tractors to use the same number of cards', () => {
    const four = [...pair('clubs', 'K'), ...pair('clubs', 'Q')];
    const six = [...pair('hearts', 'K'), ...pair('hearts', 'Q'), ...pair('hearts', 'J')];
    const first = recordBid(createGameState([four, six, [], []], 0), four);
    expect(() => recordBid(first, six, 1)).toThrow('4张拖拉机');
  });

  it('still rejects non-pairs, duplicate card IDs, and cards outside the caller hand', () => {
    const ownPair = pair('clubs', 'K');
    const otherPair = pair('hearts', 'K');
    const state = createGameState([[...ownPair, otherPair[0]], [], [], []], 0);

    expect(() => recordBid(state, [ownPair[0]])).toThrow('请选择同花色');
    expect(() => recordBid(state, [ownPair[0], otherPair[0]])).toThrow('请选择同花色');
    expect(() => recordBid(state, [ownPair[0], ownPair[0]])).toThrow('同一张牌不能重复选择');
    expect(() => recordBid(state, otherPair)).toThrow('请选择自己手中的牌');
  });
});
