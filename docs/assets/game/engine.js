import { classifyBid, hasAnyBidCandidate, resolveWinningBid } from './bid.js';
                                       
import { shuffleCards } from './deck.js';
import { compareTrickPlays } from './play/compare.js';
import { validateFollow } from './play/follow.js';
import { awardTrick } from './score.js';
import { preservesEverySuit, recordCardEvent } from './tribute.js';
                                                                             

                                  
                                
                                                                     
 

export function createGameState(hands       , previousDealer          , priorRules                  = {})            {
  const bidOrder = [0, 1, 2, 3].map(offset => ((previousDealer + offset) % 4)            );
  const players                       = [
    { id: 0, hand: hands[0] }, { id: 1, hand: hands[1] },
    { id: 2, hand: hands[2] }, { id: 3, hand: hands[3] }
  ];
  return {
    tribute: null, events: [], roundNumber: 1, bidExchangeCollected: false,
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

export function canRespondToBid(state           , player          )          {
  if (state.phase !== 'bidding') return false;
  if (state.forcedBidder !== null) return state.forcedBidder === player;
  return state.bidTurn < 4 && !state.bidResponded.includes(player);
}

export function recordBid(state           , cards                 , player           = state.currentPlayer)            {
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
  const bid      = {
    player, cards: [...cards], kind: shape.kind, cardCount: shape.cardCount,
    strength: shape.strength, sequence: state.bidTurn
  };
  // Calls are sealed independently; compare them only when all four turns finish.
  const bids = [...state.bids, bid];
  const bidRequirement = requirement ?? { kind: shape.kind, cardCount: shape.cardCount };
  if (isForcedCall) return { ...state, bids, bidRequirement, forcedBidder: null };
  return advanceBid({ ...state, bids, bidRequirement }, player);
}

export function passBid(state           , player           = state.currentPlayer)            {
  if (state.phase !== 'bidding' || state.bidTurn >= 4) throw new Error('Bidding is not accepting passes.');
  if (state.forcedBidder !== null) throw new Error('The forced caller must choose a bid.');
  if (!canRespondToBid(state, player)) throw new Error('你已完成本轮叫庄选择，不能重复提交。');
  return advanceBid(state, player);
}

export function resolveBidding(state           )            {
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
  const resolved            = {
    ...state,
    phase: pendingExchange.length ? 'exchange' : 'partner-call',
    bidsRevealed: true,
    dealer: winning.player,
    currentPlayer: winning.player,
    trumpSuit: trumpSuit        ,
    pendingExchange, bidExchangeCollected: false
  };
  return pendingExchange.length ? collectBidCards(resolved) : resolved;
}

export function revealedBids(state           )                 {
  return state.bidsRevealed ? state.bids : [];
}

export function collectBidCards(state           )            {
  if (state.phase !== 'exchange' || state.dealer === null || state.bidExchangeCollected) return state;
  const players = copyPlayers(state);
  const incoming         = [];
  for (const id of state.pendingExchange) {
    const bid = state.bids.find(item => item.player === id);
    if (!bid || !containsCards(players[id].hand, bid.cards)) throw new Error('争庄牌不在玩家手中。');
    players[id] = { ...players[id], hand: removeCards(players[id].hand, bid.cards) };
    incoming.push(...bid.cards);
  }
  players[state.dealer] = { ...players[state.dealer], hand: [...players[state.dealer].hand, ...incoming] };
  return recordCardEvent({ ...state, players, bidExchangeCollected: true }, 'bid-receive', state.dealer, incoming);
}

export function bidReturnCount(state           )         {
  return state.bids.filter(bid => state.pendingExchange.includes(bid.player)).reduce((total, bid) => total + bid.cards.length, 0);
}

export function exchangeBidCards(state           , returned                 , randomValues                    = [])            {
  state = collectBidCards(state);
  if (state.phase !== 'exchange' || state.dealer === null || state.trumpSuit === null) throw new Error('当前没有需要完成的争庄还牌。');
  const count = bidReturnCount(state);
  if (!count || returned.length !== count) throw new Error(`请一次选齐${count}张还牌。`);
  const hand = state.players[state.dealer].hand;
  if (!preservesEverySuit(hand, returned, state.trumpSuit)) throw new Error('请选择自己的牌，还牌不能还绝任何一门副牌。');
  const pool = shuffleCards(returned, randomValues);
  const players = copyPlayers(state);
  players[state.dealer] = { ...players[state.dealer], hand: removeCards(hand, returned) };
  let next = recordCardEvent(state, 'bid-return', state.dealer, returned);
  let cursor = 0;
  for (const id of state.pendingExchange) {
    const bid = state.bids.find(item => item.player === id);
    if (!bid) throw new Error('缺少争庄记录。');
    const received = pool.slice(cursor, cursor + bid.cards.length);
    cursor += received.length;
    players[id] = { ...players[id], hand: [...players[id].hand, ...received] };
    next = recordCardEvent(next, 'bid-receive', id, received);
  }
  return { ...next, players, pendingExchange: [], phase: 'partner-call' };
}

export function resumeAfterTribute(state           )            {
  if (state.phase !== 'tribute' || (state.tribute && state.tribute.stage !== 'complete')) throw new Error('请先完成所有上供和还牌。');
  const hands        = [state.players[0].hand, state.players[1].hand, state.players[2].hand, state.players[3].hand];
  if (hands.some(hand => hand.length !== 27)) throw new Error('每人必须恢复27张牌后才能开局。');
  return { ...createGameState(hands, state.dealer ?? state.previousDealer, {
    fullSupply: state.fullSupply, previousLosingTeam: state.previousLosingTeam
  }), events: state.events ?? [], roundNumber: state.roundNumber ?? 1 };
}

export function callPartner(state           , called      )            {
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

export function playTurn(state           , player          , cards                 )            {
  if (state.phase !== 'play' || state.trumpSuit === null) throw new Error('The game is not accepting plays.');
  if (player !== state.currentPlayer) throw new Error('It is another player turn.');
  const hand = state.players[player].hand;
  const validation = validateFollow(hand, cards, state.lead, state.trumpSuit);
  if (!validation.legal) throw new Error(validation.reason ?? 'Illegal play.');

  state = recordCardEvent(state, 'play', player, cards);

  const play       = { player, cards: [...cards] };
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
    compareTrickPlays(challenger, best, lead, state.trumpSuit        ) > 0 ? challenger : best, currentTrick[0]);
  const isLastTrick = players.every(item => item.hand.length === 0);
  const allCards = currentTrick.flatMap(item => item.cards);
  const scored = awardTrick({ ...state, players, lead, currentTrick }, winner.player, allCards, lead.cards.length, isLastTrick);
  if (isLastTrick) return scored;
  return {
    ...scored, phase: 'play', currentPlayer: winner.player,
    trickLeader: winner.player, currentTrick: [], lead: null
  };
}

function advanceBid(state           , player          )            {
  const bidResponded = [...state.bidResponded, player];
  const currentPlayer = state.bidOrder.find(id => !bidResponded.includes(id)) ?? player;
  return { ...state, bidResponded, bidTurn: bidResponded.length, currentPlayer };
}

function copyPlayers(state           )                                                                                                       {
  return [state.players[0], state.players[1], state.players[2], state.players[3]];
}

function containsCards(hand                 , cards                 )          {
  const handIds = new Set(hand.map(card => card.id));
  return new Set(cards.map(card => card.id)).size === cards.length && cards.every(card => handIds.has(card.id));
}

function removeCards(hand                 , cards                 )         {
  const removed = new Set(cards.map(card => card.id));
  return hand.filter(card => !removed.has(card.id));
}

function sameFace(a      , b      )          {
  return a.suit === b.suit && a.rank === b.rank;
}

function nextPlayer(player          )           {
  return ((player + 1) % 4)            ;
}
