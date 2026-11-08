import { classifyBid } from '../game/bid.js';
import { RANKS } from '../game/deck.js';
import { bidReturnCount, callPartner, recordBid } from '../game/engine.js';
import { classifyPlay } from '../game/play/classify.js';
import { validateFollow } from '../game/play/follow.js';
import { compareCardValues, isTrump } from '../game/trump.js';
import { chooseTributeCards, preservesEverySuit } from '../game/tribute.js';
import type { Card, GameState, PlayerId, Suit } from '../game/types.js';

function exactPairs(cards: readonly Card[]): readonly (readonly [Card, Card])[] {
  const groups = new Map<string, Card[]>();
  for (const card of cards) {
    const key = `${card.suit}:${card.rank}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length >= 2).map(group => [group[0], group[1]] as const);
}

function bidCandidates(hand: readonly Card[]): readonly (readonly Card[])[] {
  const pairs = new Map<string, readonly [Card, Card]>();
  for (const pair of exactPairs(hand)) pairs.set(`${pair[0].suit}:${pair[0].rank}`, pair);
  const candidates: Card[][] = [...pairs.values()].map(pair => [...pair]);
  const suits = ['clubs', 'spades', 'hearts', 'diamonds'] as const;
  for (const suit of suits) {
    for (const pairLength of [2, 3] as const) {
      for (let start = 0; start < RANKS.length; start += 1) {
        const tractor: Card[] = [];
        for (let offset = 0; offset < pairLength; offset += 1) {
          const rank = RANKS[(start + offset) % RANKS.length];
          const pair = pairs.get(`${suit}:${rank}`);
          if (pair) tractor.push(...pair);
        }
        if (tractor.length === pairLength * 2) candidates.push(tractor);
      }
    }
  }
  const unique = new Map<string, readonly Card[]>();
  for (const cards of candidates) unique.set(cards.map(card => card.id).sort().join('|'), cards);
  return [...unique.values()];
}

export function chooseBotBid(state: GameState, player: PlayerId = state.currentPlayer): readonly Card[] | null {
  if (state.phase !== 'bidding') return null;
  const legal = bidCandidates(state.players[player].hand).filter(cards => {
    try {
      recordBid(state, cards, player);
      return true;
    } catch {
      return false;
    }
  });
  legal.sort((a, b) => {
    const shapeA = classifyBid(a);
    const shapeB = classifyBid(b);
    if (!shapeA || !shapeB) return 0;
    return shapeB.cardCount - shapeA.cardCount || shapeB.strength - shapeA.strength;
  });
  const best = legal[0];
  if (!best) return null;
  const shape = classifyBid(best);
  if (!shape) return null;
  if (state.forcedBidder !== null) return best;
  return shape.strength >= 7 ? best : null;
}

function lowestCards(cards: readonly Card[], count: number, trumpSuit: Suit): readonly Card[] {
  return [...cards].sort((a, b) => compareCardValues(a, b, trumpSuit) || a.id.localeCompare(b.id)).slice(0, count);
}

function padCards(cards: readonly Card[], hand: readonly Card[], count: number, trumpSuit: Suit): readonly Card[] {
  const ids = new Set(cards.map(card => card.id));
  return [...cards, ...lowestCards(hand.filter(card => !ids.has(card.id)), count - cards.length, trumpSuit)];
}

function preferredFollow(hand: readonly Card[], lead: NonNullable<GameState['lead']>, trumpSuit: Suit): readonly Card[] {
  const shape = classifyPlay(lead.cards, trumpSuit);
  const count = lead.cards.length;
  const leadIsTrump = shape.mainTrump || (shape.kind === 'single' && isTrump(lead.cards[0], trumpSuit));
  const base = leadIsTrump
    ? hand.filter(card => isTrump(card, trumpSuit))
    : hand.filter(card => card.suit === lead.cards[0].suit && !isTrump(card, trumpSuit));
  if (shape.kind === 'single') return lowestCards(base.length ? base : hand, 1, trumpSuit);
  if (shape.kind === 'pair') {
    const pairs = exactPairs(base);
    const chosen = pairs.length
      ? [...pairs[0]]
      : [...base].sort((a, b) => compareCardValues(b, a, trumpSuit)).slice(0, Math.min(2, base.length));
    return padCards(chosen, hand, count, trumpSuit);
  }
  if (shape.kind === 'tractor') {
    if (shape.mainTrump) return padCards(lowestCards(base, Math.min(count, base.length), trumpSuit), hand, count, trumpSuit);
    if (base.length < count) return padCards(lowestCards(base, base.length, trumpSuit), hand, count, trumpSuit);
    const pairs = exactPairs(base);
    const pairCount = Math.min(count / 2, pairs.length);
    const chosenPairs = pairs.slice(0, pairCount);
    const allPairIds = new Set(pairs.flat().map(card => card.id));
    const singlesNeeded = count - pairCount * 2;
    const singles = [...base]
      .filter(card => !allPairIds.has(card.id))
      .sort((a, b) => compareCardValues(b, a, trumpSuit))
      .slice(0, singlesNeeded);
    const chosen = [...chosenPairs.flat(), ...singles];
    if (chosen.length < count) return padCards(chosen, hand, count, trumpSuit);
    return chosen;
  }
  return lowestCards(hand, count, trumpSuit);
}

function findLegalFollow(hand: readonly Card[], count: number, trumpSuit: Suit, lead: NonNullable<GameState['lead']>): readonly Card[] | null {
  const ordered = [...hand].sort((a, b) => compareCardValues(a, b, trumpSuit) || a.id.localeCompare(b.id));
  let found: readonly Card[] | null = null;
  const chosen: Card[] = [];
  function visit(start: number): boolean {
    if (chosen.length === count) {
      if (validateFollow(hand, chosen, lead, trumpSuit).legal) {
        found = [...chosen];
        return true;
      }
      return false;
    }
    const remaining = count - chosen.length;
    for (let index = start; index <= ordered.length - remaining; index += 1) {
      chosen.push(ordered[index]);
      if (visit(index + 1)) return true;
      chosen.pop();
    }
    return false;
  }
  visit(0);
  return found;
}

export function chooseBotPlay(state: GameState): readonly Card[] {
  const hand = state.players[state.currentPlayer].hand;
  const trump = state.trumpSuit;
  if (state.phase !== 'play' || trump === null) throw new Error('当前不能由人机出牌。');
  if (!state.lead) return lowestCards(hand, 1, trump);
  const preferred = preferredFollow(hand, state.lead, trump);
  if (validateFollow(hand, preferred, state.lead, trump).legal) return preferred;
  const fallback = findLegalFollow(hand, state.lead.cards.length, trump, state.lead);
  if (!fallback) throw new Error('人机无法找到合法跟牌。');
  return fallback;
}

export function chooseBotExchange(state: GameState): readonly Card[] {
  if (state.phase !== 'exchange' || state.dealer === null || state.trumpSuit === null) throw new Error('人机无法读取还牌信息。');
  return chooseBotReturn(state.players[state.dealer].hand, bidReturnCount(state), state.trumpSuit);
}

export function chooseBotTribute(state: GameState): readonly Card[] {
  const progress = state.tribute;
  const trump = state.trumpSuit;
  if (state.phase !== 'tribute' || !progress || trump === null) throw new Error('当前不能由人机上供或还牌。');
  const player = state.currentPlayer;
  const hand = state.players[player].hand;
  if (progress.stage === 'offering') return chooseTributeCards(hand, progress.offerCounts[player], trump);
  if (progress.stage === 'returning') return chooseBotReturn(hand, progress.receiveCounts[player], trump);
  throw new Error('上供还牌已经完成。');
}

export function chooseBotReturn(hand: readonly Card[], count: number, trump: Suit): readonly Card[] {
  const returned: Card[] = [];
  const ordered = [...hand].sort((a, b) => Number(isTrump(a, trump)) - Number(isTrump(b, trump)) || compareCardValues(a, b, trump));
  for (const card of ordered) {
    if (returned.length === count) break;
    const candidate = [...returned, card];
    if (preservesEverySuit(hand, candidate, trump)) returned.push(card);
  }
  if (returned.length !== count) throw new Error('人机无法选出符合副牌保留规则的还牌。');
  return returned;
}

export function chooseBotCalledCard(state: GameState): Card | undefined {
  const dealer = state.dealer;
  const trump = state.trumpSuit;
  if (state.phase !== 'partner-call' || dealer === null || trump === null) return undefined;
  const candidates = [...state.players[dealer].hand].sort((a, b) => compareCardValues(a, b, trump));
  return candidates.find(card => {
    if (card.suit === 'joker' || card.suit === trump || ['2', '3', '5'].includes(card.rank)) return false;
    const holders = state.players.filter(player => player.id !== dealer && player.hand.some(other => other.suit === card.suit && other.rank === card.rank));
    if (holders.length !== 1) return false;
    try {
      callPartner(state, card);
      return true;
    } catch {
      return false;
    }
  });
}
