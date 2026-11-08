import { isSpecialTrumpRank, trumpStrength } from './trump.js';
import { teamOf } from './score.js';
import type { Card, GameState, PlayerId, Suit, TributeExchangeSummary } from './types.js';

export type TributeExchange = TributeExchangeSummary;

export function beginTributePhase(
  state: GameState,
  dealtPlayers: GameState['players'],
  exchanges: readonly TributeExchangeSummary[]
): GameState {
  if (state.phase !== 'round-end') throw new Error('Tribute can only begin after a round ends.');
  const dealtState = { ...state, players: dealtPlayers };
  const exchangedState = applyTributeExchange(dealtState, exchanges);
  return {
    ...exchangedState,
    phase: 'tribute',
    currentTrick: [],
    lead: null,
    trickLeader: null,
    tributeExchanges: exchanges.map(exchange => ({
      ...exchange,
      offered: [...exchange.offered],
      returned: [...exchange.returned]
    }))
  };
}

export function supplyCount(netWin: number): number {
  if (netWin <= 0) return 0;
  return Math.min(8, Math.floor(netWin / 20));
}

export function splitTeamQuota(count: number, team: readonly [PlayerId, PlayerId], previousDealer: PlayerId): readonly [number, number] {
  const half = Math.floor(count / 2);
  if (count % 2 === 0) return [half, half];
  const receiver = team.includes(previousDealer)
    ? previousDealer
    : clockwiseDistance(team[0], previousDealer) <= clockwiseDistance(team[1], previousDealer) ? team[0] : team[1];
  return receiver === team[0] ? [half + 1, half] : [half, half + 1];
}

export function hasAntiSupply(hand: readonly Card[], trumpSuit: Suit): boolean {
  const pairs = exactPairs(hand);
  const mainFive = pairs.some(([a]) => a.suit === trumpSuit && a.rank === '5');
  const bigJokers = pairs.some(([a]) => a.rank === 'BJ');
  const smallJokers = pairs.some(([a]) => a.rank === 'SJ');
  return mainFive || (bigJokers && smallJokers);
}

export function teamCanAntiSupply(state: GameState, team: readonly [PlayerId, PlayerId], trumpSuit: Suit): boolean {
  return team.some(player => hasAntiSupply(state.players[player].hand, trumpSuit));
}

export function chooseTributeCards(hand: readonly Card[], requested: number, trumpSuit: Suit): readonly Card[] {
  if (requested <= 0) return [];
  const eligible = hand.filter(card => card.suit === 'joker' || isSpecialTrumpRank(card.rank));
  const groups = new Map<string, Card[]>();
  for (const card of eligible) {
    const key = `${card.suit}:${card.rank}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => trumpStrength(b[0], trumpSuit) - trumpStrength(a[0], trumpSuit));
  const selected: Card[] = [];
  for (const group of ordered) {
    const groupSize = group.length >= 2 ? 2 : 1;
    if (selected.length + groupSize <= requested) selected.push(...group.slice(0, groupSize));
  }
  return selected;
}

export function preservesEverySuit(hand: readonly Card[], returned: readonly Card[]): boolean {
  const returnedIds = new Set(returned.map(card => card.id));
  if (returnedIds.size !== returned.length) return false;
  const handIds = new Set(hand.map(card => card.id));
  if (returned.some(card => !handIds.has(card.id))) return false;
  const before = suitCounts(hand);
  const after = suitCounts(hand.filter(card => !returnedIds.has(card.id)));
  return [...before.entries()].every(([suit, count]) => count === 0 || (after.get(suit) ?? 0) > 0);
}

export function applyTributeExchange(state: GameState, exchanges: readonly TributeExchange[]): GameState {
  const hands: [Card[], Card[], Card[], Card[]] = [
    [...state.players[0].hand], [...state.players[1].hand],
    [...state.players[2].hand], [...state.players[3].hand]
  ];
  for (const exchange of exchanges) {
    if (exchange.from === exchange.to) throw new Error('Tribute cannot be returned to the same player.');
    if (teamOf(state, exchange.from) === teamOf(state, exchange.to)) throw new Error('Tribute must cross between opposing teams.');
    if (exchange.offered.length !== exchange.returned.length) throw new Error('Returned card count must match tribute count.');

    const fromHand = hands[exchange.from];
    const toHand = hands[exchange.to];
    if (!containsCards(fromHand, exchange.offered)) throw new Error('Offering player does not hold all offered cards.');
    if (!containsCards(toHand, exchange.returned)) throw new Error('Receiving player does not hold all returned cards.');
    if (!preservesEverySuit(toHand, exchange.returned)) throw new Error('Returning these cards would leave a suit empty.');

    removeCards(fromHand, exchange.offered);
    toHand.push(...exchange.offered);
    removeCards(toHand, exchange.returned);
    fromHand.push(...exchange.returned);
  }
  const players: GameState['players'] = [
    { ...state.players[0], hand: hands[0] },
    { ...state.players[1], hand: hands[1] },
    { ...state.players[2], hand: hands[2] },
    { ...state.players[3], hand: hands[3] }
  ];
  return { ...state, players };
}

function exactPairs(hand: readonly Card[]): readonly (readonly [Card, Card])[] {
  const groups = new Map<string, Card[]>();
  for (const card of hand) {
    const key = `${card.suit}:${card.rank}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length >= 2).map(group => [group[0], group[1]] as const);
}

function suitCounts(cards: readonly Card[]): ReadonlyMap<Card['suit'], number> {
  const counts = new Map<Card['suit'], number>();
  for (const card of cards) {
    if (card.suit === 'joker') continue;
    counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
  }
  return counts;
}

function containsCards(hand: readonly Card[], cards: readonly Card[]): boolean {
  const ids = new Set(hand.map(card => card.id));
  return new Set(cards.map(card => card.id)).size === cards.length && cards.every(card => ids.has(card.id));
}

function removeCards(hand: Card[], cards: readonly Card[]): void {
  const ids = new Set(cards.map(card => card.id));
  for (let index = hand.length - 1; index >= 0; index -= 1) {
    if (ids.has(hand[index].id)) hand.splice(index, 1);
  }
}

function clockwiseDistance(player: PlayerId, from: PlayerId): number {
  return (player - from + 4) % 4;
}
