import { isSpecialTrumpRank, isTrump, trumpStrength } from './trump.js';
import { shuffleCards } from './deck.js';
import { teamOf } from './score.js';
                                                                                                                                  

                                                     

export function beginTributePhase(
  state           ,
  dealtPlayers                      ,
  exchanges                                   
)            {
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

export function supplyCount(netWin        )         {
  if (netWin <= 0) return 0;
  return Math.min(8, Math.floor(netWin / 20));
}

export function splitTeamQuota(count        , team                               , previousDealer          )                            {
  const half = Math.floor(count / 2);
  if (count % 2 === 0) return [half, half];
  const receiver = team.includes(previousDealer)
    ? previousDealer
    : clockwiseDistance(team[0], previousDealer) <= clockwiseDistance(team[1], previousDealer) ? team[0] : team[1];
  return receiver === team[0] ? [half + 1, half] : [half, half + 1];
}

export function hasAntiSupply(hand                 , trumpSuit      )          {
  const pairs = exactPairs(hand);
  const mainFive = pairs.some(([a]) => a.suit === trumpSuit && a.rank === '5');
  const bigJokers = pairs.some(([a]) => a.rank === 'BJ');
  const smallJokers = pairs.some(([a]) => a.rank === 'SJ');
  return mainFive || (bigJokers && smallJokers);
}

export function teamCanAntiSupply(state           , team                               , trumpSuit      )          {
  return team.some(player => hasAntiSupply(state.players[player].hand, trumpSuit));
}

export function chooseTributeCards(hand                 , requested        , trumpSuit      )                  {
  if (requested <= 0) return [];
  const eligible = hand.filter(card => card.suit === 'joker' || isSpecialTrumpRank(card.rank));
  const groups = new Map                ();
  for (const card of eligible) {
    const key = `${card.suit}:${card.rank}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => trumpStrength(b[0], trumpSuit) - trumpStrength(a[0], trumpSuit));
  const selected         = [];
  for (const group of ordered) {
    const groupSize = group.length >= 2 ? 2 : 1;
    if (selected.length + groupSize <= requested) selected.push(...group.slice(0, groupSize));
  }
  return selected;
}

export function preservesEverySuit(hand                 , returned                 , trumpSuit       )          {
  const returnedIds = new Set(returned.map(card => card.id));
  if (returnedIds.size !== returned.length) return false;
  const handIds = new Set(hand.map(card => card.id));
  if (returned.some(card => !handIds.has(card.id))) return false;
  const sideCards = trumpSuit ? hand.filter(card => !isTrump(card, trumpSuit)) : hand;
  const before = suitCounts(sideCards);
  const after = suitCounts(sideCards.filter(card => !returnedIds.has(card.id)));
  return [...before.entries()].every(([suit, count]) => count === 0 || (after.get(suit) ?? 0) > 0);
}

export function applyTributeExchange(state           , exchanges                            )            {
  const hands                                   = [
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
  const players                       = [
    { ...state.players[0], hand: hands[0] },
    { ...state.players[1], hand: hands[1] },
    { ...state.players[2], hand: hands[2] },
    { ...state.players[3], hand: hands[3] }
  ];
  return { ...state, players };
}

function exactPairs(hand                 )                                     {
  const groups = new Map                ();
  for (const card of hand) {
    const key = `${card.suit}:${card.rank}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length >= 2).map(group => [group[0], group[1]]         );
}

function suitCounts(cards                 )                                    {
  const counts = new Map                      ();
  for (const card of cards) {
    if (card.suit === 'joker') continue;
    counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
  }
  return counts;
}

function containsCards(hand                 , cards                 )          {
  const ids = new Set(hand.map(card => card.id));
  return new Set(cards.map(card => card.id)).size === cards.length && cards.every(card => ids.has(card.id));
}

function removeCards(hand        , cards                 )       {
  const ids = new Set(cards.map(card => card.id));
  for (let index = hand.length - 1; index >= 0; index -= 1) {
    if (ids.has(hand[index].id)) hand.splice(index, 1);
  }
}

function clockwiseDistance(player          , from          )         {
  return (player - from + 4) % 4;
}

/** Start the next deal without moving any player's chosen cards automatically. */
export function beginInteractiveTribute(state           , dealtPlayers                      )            {
  if (state.phase !== 'round-end') throw new Error('本局结束后才能开始上供。');
  assertCompleteDeal(dealtPlayers);
  const dealer = state.dealer ?? state.previousDealer;
  const validTeams = state.dealer !== null && state.partner !== null && state.winnerTeam !== null && state.trumpSuit !== null;
  const dealerTeam                                = validTeams ? [state.dealer , state.partner ] : [0, 2];
  const others = ([0, 1, 2, 3]         ).filter(id => !dealerTeam.includes(id));
  const otherTeam                                = [others[0], others[1]];
  const winners = state.winnerTeam === 1 ? otherTeam : dealerTeam;
  const losers = state.winnerTeam === 1 ? dealerTeam : otherTeam;
  const requested = validTeams ? supplyCount(Math.abs(state.scores[0] - state.scores[1])) : 0;
  const antiSupply = requested === 8 && state.trumpSuit !== null
    && teamCanAntiSupply({ ...state, players: dealtPlayers }, losers, state.trumpSuit);
  const quotas = splitTeamQuota(antiSupply ? 0 : requested, losers, dealer);
  const offerCounts                                   = [0, 0, 0, 0];
  losers.forEach((id, index) => {
    offerCounts[id] = state.trumpSuit ? chooseTributeCards(dealtPlayers[id].hand, quotas[index], state.trumpSuit).length : 0;
  });
  const offers                                                                                                   = [[], [], [], []];
  for (const id of losers) if (offerCounts[id] > 0) offers[id] = null;
  const first = losers.find(id => offers[id] === null);
  const tribute                  = {
    stage: first === undefined ? 'complete' : 'offering', winners, losers, offerCounts,
    receiveCounts: [0, 0, 0, 0], offers, returns: [[], [], [], []], antiSupply
  };
  return {
    ...state, players: dealtPlayers, phase: 'tribute', tribute, tributeExchanges: [],
    fullSupply: requested === 8 && !antiSupply, previousLosingTeam: requested === 8 && !antiSupply ? losers : null,
    currentPlayer: first ?? dealer, previousDealer: dealer, roundNumber: (state.roundNumber ?? 1) + 1,
    currentTrick: [], lead: null, trickLeader: null, calledCard: null, bids: [], pendingExchange: []
  };
}

export function validateTributeSelection(hand                 , selected                 , count        , trump      )       {
  if (!containsCards(hand, selected)) throw new Error('只能选择自己手中的牌，同一张牌不能重复选择。');
  const expected = chooseTributeCards(hand, count, trump);
  if (selected.length !== expected.length) throw new Error(`应上供${expected.length}张。`);
  if (selected.some(card => card.suit !== 'joker' && !isSpecialTrumpRank(card.rank))) throw new Error('只能上供2、3、5和大小王。');
  for (const pair of exactPairs(hand)) {
    const picked = pair.filter(card => selected.some(item => item.id === card.id)).length;
    if (picked === 1) throw new Error('上供不能拆对子。');
  }
  const strengths = (cards                 ) => cards.map(card => trumpStrength(card, trump)).sort((a, b) => b - a);
  if (strengths(selected).some((value, index) => value !== strengths(expected)[index])) throw new Error('上供必须优先选择最大的合格牌。');
}

export function submitTributeOffer(state           , player          , cards                 , randomValues                   )            {
  const progress = requireTributeTurn(state, player, 'offering');
  if (state.trumpSuit === null) throw new Error('上供缺少上一局主花色。');
  const hand = state.players[player].hand;
  validateTributeSelection(hand, cards, progress.offerCounts[player], state.trumpSuit);
  const players = mutablePlayers(state);
  players[player] = { ...players[player], hand: withoutCards(hand, cards) };
  const offers = replaceSeat(progress.offers, player, [...cards]);
  let next            = { ...state, players, tribute: { ...progress, offers } };
  next = recordCardEvent(next, 'tribute-offer', player, cards);
  const pending = progress.losers.find(id => offers[id] === null);
  if (pending !== undefined) return { ...next, currentPlayer: pending };

  const pool = shuffleCards(offers.flatMap(value => value ?? []), randomValues);
  const quotas = splitTeamQuota(pool.length, progress.winners, state.previousDealer);
  const receiveCounts                                   = [0, 0, 0, 0];
  let cursor = 0;
  for (const [index, id] of progress.winners.entries()) {
    const received = pool.slice(cursor, cursor + quotas[index]);
    cursor += received.length;
    receiveCounts[id] = received.length;
    players[id] = { ...players[id], hand: [...players[id].hand, ...received] };
    if (received.length) next = recordCardEvent(next, 'tribute-receive', id, received);
  }
  const returns                                                                                                   = [[], [], [], []];
  for (const id of progress.winners) if (receiveCounts[id]) returns[id] = null;
  const first = progress.winners.find(id => returns[id] === null);
  return { ...next, players, currentPlayer: first ?? state.previousDealer,
    tribute: { ...progress, offers, receiveCounts, returns, stage: first === undefined ? 'complete' : 'returning' } };
}

export function submitTributeReturn(state           , player          , cards                 , randomValues                   )            {
  const progress = requireTributeTurn(state, player, 'returning');
  if (state.trumpSuit === null) throw new Error('还牌缺少上一局主花色。');
  const hand = state.players[player].hand;
  if (cards.length !== progress.receiveCounts[player]) throw new Error(`应还${progress.receiveCounts[player]}张牌。`);
  if (!preservesEverySuit(hand, cards, state.trumpSuit)) throw new Error('请选择自己的牌，还牌不能还绝任何一门副牌。');
  const players = mutablePlayers(state);
  players[player] = { ...players[player], hand: withoutCards(hand, cards) };
  const returns = replaceSeat(progress.returns, player, [...cards]);
  let next            = { ...state, players, tribute: { ...progress, returns } };
  next = recordCardEvent(next, 'tribute-return', player, cards);
  const pending = progress.winners.find(id => returns[id] === null);
  if (pending !== undefined) return { ...next, currentPlayer: pending };
  const pool = shuffleCards(returns.flatMap(value => value ?? []), randomValues);
  let cursor = 0;
  for (const id of progress.losers) {
    const received = pool.slice(cursor, cursor + progress.offerCounts[id]);
    cursor += received.length;
    players[id] = { ...players[id], hand: [...players[id].hand, ...received] };
    if (received.length) next = recordCardEvent(next, 'return-receive', id, received);
  }
  assertCompleteDeal(players);
  return { ...next, players, currentPlayer: state.previousDealer, tribute: { ...progress, returns, stage: 'complete' } };
}

export function recordCardEvent(state           , kind                   , player          , cards                 )            {
  const event            = { round: state.roundNumber ?? 1, kind, player, cards: [...cards], viewer: kind === 'play' ? null : player };
  return { ...state, events: [...(state.events ?? []), event].slice(-500) };
}

function requireTributeTurn(state           , player          , stage                          )                  {
  const progress = state.tribute;
  if (state.phase !== 'tribute' || !progress || progress.stage !== stage || state.currentPlayer !== player) throw new Error('当前还没有轮到你上供或还牌。');
  return progress;
}

function mutablePlayers(state           )                                                                                                       {
  return [state.players[0], state.players[1], state.players[2], state.players[3]];
}

function replaceSeat   (values               , player          , value   )                {
  const result               = [values[0], values[1], values[2], values[3]];
  result[player] = value;
  return result;
}

function withoutCards(hand                 , cards                 )                  {
  const ids = new Set(cards.map(card => card.id));
  return hand.filter(card => !ids.has(card.id));
}

function assertCompleteDeal(players                      )       {
  const cards = players.flatMap(player => player.hand);
  if (players.some(player => player.hand.length !== 27) || new Set(cards.map(card => card.id)).size !== 108) throw new Error('换牌后必须每人27张，且108张牌没有重复或丢失。');
}
