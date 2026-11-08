import type { Card, CardFace, GameEvent, GameState, PlayerId, SeatValues } from './types.js';

export function visibleEvents(state: GameState, viewer: PlayerId): readonly GameEvent[] {
  return (state.events ?? []).filter(event => event.viewer === null || event.viewer === viewer);
}

export function gameForPlayer(state: GameState, viewer: PlayerId): GameState {
  const players = state.players.map(player => ({ ...player,
    hand: player.id === viewer || state.phase === 'round-end' ? player.hand : hiddenCards(player.hand.length, player.id)
  }));
  const tribute = state.tribute;
  const hideSubmissions = (values: SeatValues<readonly Card[] | null>): SeatValues<readonly Card[] | null> => {
    const hide = (id: PlayerId) => id === viewer ? values[id] : values[id] === null ? null : [];
    return [hide(0), hide(1), hide(2), hide(3)];
  };
  return {
    ...state,
    players: [players[0], players[1], players[2], players[3]],
    bids: state.bidsRevealed ? state.bids : [],
    partner: state.phase === 'round-end' || state.partner === viewer ? state.partner : null,
    events: visibleEvents(state, viewer), tributeExchanges: [],
    tribute: tribute ? { ...tribute, offers: hideSubmissions(tribute.offers), returns: hideSubmissions(tribute.returns) } : null
  };
}

export function cardFaceLabel(card: CardFace): string {
  if (card.rank === 'BJ') return '大王';
  if (card.rank === 'SJ') return '小王';
  const suits = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦', joker: '★' };
  return `${suits[card.suit]}${card.rank}`;
}

export function eventLabel(event: GameEvent, playerName: string): string {
  const labels: Record<GameEvent['kind'], string> = {
    'tribute-offer': '上供', 'tribute-receive': '收到供牌', 'tribute-return': '还牌',
    'return-receive': '收到还牌', 'bid-return': '争庄还牌', 'bid-receive': '争庄收到牌', play: '出牌'
  };
  return `第${event.round}局 · ${playerName}${labels[event.kind]}：${event.cards.map(cardFaceLabel).join(' ')}${event.viewer === null ? '' : '（仅自己可见）'}`;
}

function hiddenCards(count: number, player: PlayerId): readonly Card[] {
  return Array.from({ length: count }, (_, index) => ({ id: `hidden-${player}-${index}`, suit: 'clubs', rank: '4', copy: index % 2 === 0 ? 1 : 2 }));
}
