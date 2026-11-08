import { classifyBid, hasAnyBidCandidate, resolveWinningBid } from './bid.js';
import type { Hands } from './deck.js';
import { compareTrickPlays } from './play/compare.js';
import { validateFollow } from './play/follow.js';
import { awardTrick } from './score.js';
import { preservesEverySuit } from './tribute.js';
import type { Bid, Card, GameState, Play, PlayerId, Suit } from './types.js';

export interface PriorRoundRules {
  readonly fullSupply?: boolean;
  readonly previousLosingTeam?: readonly [PlayerId, PlayerId] | null;
}

export function createGameState(hands: Hands, previousDealer: PlayerId, priorRules: PriorRoundRules = {}): GameState {
  const bidOrder = [0, 1, 2, 3].map(offset => ((previousDealer + offset) % 4) as PlayerId);
  const players: GameState['players'] = [
    { id: 0, hand: hands[0] }, { id: 1, hand: hands[1] },
    { id: 2, hand: hands[2] }, { id: 3, hand: hands[3] }
  ];
  return {
    phase: 'bidding', players, dealer: null, previousDealer,
    previousLosingTeam: priorRules.previousLosingTeam ?? null,
    fullSupply: priorRules.fullSupply ?? false,
    currentPlayer: previousDealer, bidOrder, bidTurn: 0, forcedBidder: null, trumpSuit: null,
    bidResponded: [], bidRequirement: null,
    partner: null, calledCard: null, bids: [], bidsRevealed: false, pendingExchange: [],
    currentTrick: [], lead: null, trickLeader: null, trickCount: 0,
    scores: [0, 0], winnerTeam: null, tributeExchanges: []
  };
}

export function canRespondToBid(state: GameState, player: PlayerId): boolean {
  if (state.phase !== 'bidding') return false;
  if (state.forcedBidder !== null) return state.forcedBidder === player;
  return state.bidTurn < 4 && !state.bidResponded.includes(player);
}

export function recordBid(state: GameState, cards: readonly Card[], player: PlayerId = state.currentPlayer): GameState {
  const isForcedCall = state.forcedBidder !== null;
  if (state.phase !== 'bidding' || (!isForcedCall && state.bidTurn >= 4)) throw new Error('当前不是叫庄阶段。');
  if (!canRespondToBid(state, player)) throw new Error('你已完成本轮叫庄选择，或当前不能由你叫庄。');
  if (state.fullSupply && state.bidRequirement === null && !isForcedCall && !state.previousLosingTeam?.includes(player)) {
    throw new Error('满供时只能由上一局输家先叫庄，之后赢家可以参与叫庄。');
  }
  if (!containsCards(state.players[player].hand, cards)) throw new Error('请选择自己手中的牌，同一张牌不能重复选择。');
  const shape = classifyBid(cards);
  if (!shape) throw new Error('请选择同花色、同点数的对子，或同花色的4张/6张拖拉机。');
  const requirement = state.bidRequirement;
  if (requirement && (shape.kind !== requirement.kind || shape.cardCount !== requirement.cardCount)) {
    const label = requirement.kind === 'pair' ? '对子（2张）' : `${requirement.cardCount}张拖拉机`;
    throw new Error(`首家已锁定${label}，请按相同牌型和张数叫庄；点数不必更大。`);
  }
  const bid: Bid = {
    player, cards: [...cards], kind: shape.kind, cardCount: shape.cardCount,
    strength: shape.strength, sequence: state.bidTurn
  };
  // Calls are sealed independently; compare them only when all four turns finish.
  const bids = [...state.bids, bid];
  const bidRequirement = requirement ?? { kind: shape.kind, cardCount: shape.cardCount };
  if (isForcedCall) return { ...state, bids, bidRequirement, forcedBidder: null };
  return advanceBid({ ...state, bids, bidRequirement }, player);
}

export function passBid(state: GameState, player: PlayerId = state.currentPlayer): GameState {
  if (state.phase !== 'bidding' || state.bidTurn >= 4) throw new Error('Bidding is not accepting passes.');
  if (state.forcedBidder !== null) throw new Error('The forced caller must choose a bid.');
  if (!canRespondToBid(state, player)) throw new Error('你已完成本轮叫庄选择，不能重复提交。');
  return advanceBid(state, player);
}

export function resolveBidding(state: GameState): GameState {
  if (state.phase !== 'bidding' || state.bidTurn !== 4) throw new Error('All four players must finish their bidding turn first.');
  const winning = resolveWinningBid(state.bids);
  if (!winning) {
    const forcedBidder = state.bidOrder.find(player => hasAnyBidCandidate(state.players[player].hand));
    if (forcedBidder === undefined) return { ...state, phase: 'dealing', bidsRevealed: true };
    return { ...state, phase: 'bidding', currentPlayer: forcedBidder, forcedBidder, bidsRevealed: false };
  }
  const trumpSuit = winning.cards[0].suit;
  if (trumpSuit === 'joker') throw new Error('Jokers cannot establish the trump suit.');
  const pendingExchange = state.bids.filter(bid => bid.player !== winning.player).map(bid => bid.player);
  return {
    ...state,
    phase: pendingExchange.length ? 'exchange' : 'partner-call',
    bidsRevealed: true,
    dealer: winning.player,
    currentPlayer: winning.player,
    trumpSuit: trumpSuit as Suit,
    pendingExchange
  };
}

export function revealedBids(state: GameState): readonly Bid[] {
  return state.bidsRevealed ? state.bids : [];
}

export function exchangeBidCards(state: GameState, returned: readonly Card[]): GameState {
  if (state.phase !== 'exchange' || state.dealer === null) throw new Error('There is no bid exchange to complete.');
  const loser = state.pendingExchange[0];
  if (loser === undefined) throw new Error('No losing caller is waiting for an exchange.');
  const losingBid = state.bids.find(bid => bid.player === loser);
  if (!losingBid) throw new Error('The losing caller has no recorded bid.');
  const dealerHand = state.players[state.dealer].hand;
  const loserHand = state.players[loser].hand;
  if (returned.length !== losingBid.cards.length) throw new Error('Return the same number of cards as the exposed bid.');
  const incomingDealerHand = [...dealerHand, ...losingBid.cards];
  if (returned.length !== losingBid.cards.length || !containsCards(incomingDealerHand, returned)) {
    throw new Error('Return the same number of cards after collecting the exposed bid.');
  }
  if (!preservesEverySuit(incomingDealerHand, returned)) throw new Error('A return cannot leave a suit empty.');
  if (!containsCards(loserHand, losingBid.cards)) throw new Error('The losing caller no longer holds the exposed bid cards.');

  const players = copyPlayers(state);
  players[loser] = { ...players[loser], hand: removeCards(loserHand, losingBid.cards).concat(returned) };
  players[state.dealer] = { ...players[state.dealer], hand: removeCards(incomingDealerHand, returned) };
  const pendingExchange = state.pendingExchange.slice(1);
  return {
    ...state, players, pendingExchange,
    phase: pendingExchange.length ? 'exchange' : 'partner-call'
  };
}

export function callPartner(state: GameState, called: Card): GameState {
  if (state.phase !== 'partner-call' || state.dealer === null || state.trumpSuit === null) throw new Error('The game is not ready to call a teammate.');
  const dealerHand = state.players[state.dealer].hand;
  if (!containsCards(dealerHand, [called])) throw new Error('The dealer must call a card in their own hand.');
  if (called.suit === 'joker' || called.suit === state.trumpSuit || ['2', '3', '5'].includes(called.rank)) {
    throw new Error('The called card must be a副牌 outside the trump suit and special trump ranks.');
  }
  const holders = state.players.filter(player => player.id !== state.dealer && player.hand.some(card => sameFace(card, called)));
  if (holders.length !== 1) throw new Error('The other copy must be held by exactly one opposing player.');
  const partner = holders[0].id;
  if (state.fullSupply && state.previousLosingTeam?.includes(partner)) {
    throw new Error('满供后不能叫上一局输家做队友，请重新叫牌。');
  }
  return {
    ...state, phase: 'play', partner,
    calledCard: { suit: called.suit, rank: called.rank },
    currentPlayer: state.dealer, trickLeader: state.dealer,
    currentTrick: [], lead: null
  };
}

export function playTurn(state: GameState, player: PlayerId, cards: readonly Card[]): GameState {
  if (state.phase !== 'play' || state.trumpSuit === null) throw new Error('The game is not accepting plays.');
  if (player !== state.currentPlayer) throw new Error('It is another player turn.');
  const hand = state.players[player].hand;
  const validation = validateFollow(hand, cards, state.lead, state.trumpSuit);
  if (!validation.legal) throw new Error(validation.reason ?? 'Illegal play.');

  const play: Play = { player, cards: [...cards] };
  const players = copyPlayers(state);
  players[player] = { ...players[player], hand: removeCards(hand, cards) };
  const lead = state.lead ?? play;
  const currentTrick = [...state.currentTrick, play];
  if (currentTrick.length < 4) {
    return {
      ...state, players, lead, currentTrick,
      currentPlayer: nextPlayer(player)
    };
  }

  const winner = currentTrick.slice(1).reduce((best, challenger) =>
    compareTrickPlays(challenger, best, lead, state.trumpSuit as Suit) > 0 ? challenger : best, currentTrick[0]);
  const isLastTrick = players.every(item => item.hand.length === 0);
  const allCards = currentTrick.flatMap(item => item.cards);
  const scored = awardTrick({ ...state, players, lead, currentTrick }, winner.player, allCards, lead.cards.length, isLastTrick);
  if (isLastTrick) return scored;
  return {
    ...scored, phase: 'play', currentPlayer: winner.player,
    trickLeader: winner.player, currentTrick: [], lead: null
  };
}

function advanceBid(state: GameState, player: PlayerId): GameState {
  const bidResponded = [...state.bidResponded, player];
  const currentPlayer = state.bidOrder.find(id => !bidResponded.includes(id)) ?? player;
  return { ...state, bidResponded, bidTurn: bidResponded.length, currentPlayer };
}

function copyPlayers(state: GameState): [GameState['players'][0], GameState['players'][1], GameState['players'][2], GameState['players'][3]] {
  return [state.players[0], state.players[1], state.players[2], state.players[3]];
}

function containsCards(hand: readonly Card[], cards: readonly Card[]): boolean {
  const handIds = new Set(hand.map(card => card.id));
  return new Set(cards.map(card => card.id)).size === cards.length && cards.every(card => handIds.has(card.id));
}

function removeCards(hand: readonly Card[], cards: readonly Card[]): Card[] {
  const removed = new Set(cards.map(card => card.id));
  return hand.filter(card => !removed.has(card.id));
}

function sameFace(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

function nextPlayer(player: PlayerId): PlayerId {
  return ((player + 1) % 4) as PlayerId;
}
