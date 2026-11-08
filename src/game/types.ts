export const PLAYER_IDS = [0, 1, 2, 3] as const;

export type PlayerId = (typeof PLAYER_IDS)[number];
export type TeamId = 0 | 1;
export type Suit = 'clubs' | 'spades' | 'hearts' | 'diamonds';
export type JokerRank = 'BJ' | 'SJ';
export type Rank = 'A' | 'K' | 'Q' | 'J' | '10' | '9' | '8' | '7' | '6' | '5' | '4' | '3' | '2';
export type CardRank = Rank | JokerRank;
export type CardSuit = Suit | 'joker';
export type PlayKind = 'single' | 'pair' | 'tractor' | 'other';
export type GamePhase = 'dealing' | 'bidding' | 'exchange' | 'partner-call' | 'play' | 'round-end' | 'tribute';

export interface Card {
  readonly id: string;
  readonly suit: CardSuit;
  readonly rank: CardRank;
  readonly copy: 1 | 2;
}

export interface CardFace {
  readonly suit: CardSuit;
  readonly rank: CardRank;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly hand: readonly Card[];
}

export interface Bid {
  readonly player: PlayerId;
  readonly cards: readonly Card[];
  readonly kind: 'pair' | 'tractor';
  readonly cardCount: 2 | 4 | 6;
  readonly strength: number;
  readonly sequence: number;
}

export interface Play {
  readonly player: PlayerId;
  readonly cards: readonly Card[];
}

export interface TributeExchangeSummary {
  readonly from: PlayerId;
  readonly to: PlayerId;
  readonly offered: readonly Card[];
  readonly returned: readonly Card[];
}

export type SeatValues<T> = readonly [T, T, T, T];

export interface TributeProgress {
  readonly stage: 'offering' | 'returning' | 'complete';
  readonly winners: readonly [PlayerId, PlayerId];
  readonly losers: readonly [PlayerId, PlayerId];
  readonly offerCounts: SeatValues<number>;
  readonly receiveCounts: SeatValues<number>;
  readonly offers: SeatValues<readonly Card[] | null>;
  readonly returns: SeatValues<readonly Card[] | null>;
  readonly antiSupply: boolean;
}

export interface GameEvent {
  readonly round: number;
  readonly kind: 'tribute-offer' | 'tribute-receive' | 'tribute-return' | 'return-receive' | 'bid-return' | 'bid-receive' | 'play';
  readonly player: PlayerId;
  readonly cards: readonly Card[];
  /** null means public; private events are delivered only to this seat. */
  readonly viewer: PlayerId | null;
}

export interface GameState {
  /** Optional for compatibility with rooms saved before interactive exchanges. */
  readonly tribute?: TributeProgress | null;
  readonly events?: readonly GameEvent[];
  readonly roundNumber?: number;
  readonly bidExchangeCollected?: boolean;
  readonly phase: GamePhase;
  readonly players: readonly [PlayerState, PlayerState, PlayerState, PlayerState];
  readonly dealer: PlayerId | null;
  readonly previousDealer: PlayerId;
  readonly previousLosingTeam: readonly [PlayerId, PlayerId] | null;
  readonly fullSupply: boolean;
  readonly currentPlayer: PlayerId;
  readonly bidOrder: readonly PlayerId[];
  readonly bidTurn: number;
  readonly bidResponded: readonly PlayerId[];
  readonly bidRequirement: Pick<Bid, 'kind' | 'cardCount'> | null;
  readonly forcedBidder: PlayerId | null;
  readonly trumpSuit: Suit | null;
  readonly partner: PlayerId | null;
  readonly calledCard: CardFace | null;
  readonly bids: readonly Bid[];
  readonly bidsRevealed: boolean;
  readonly pendingExchange: readonly PlayerId[];
  readonly currentTrick: readonly Play[];
  readonly lead: Play | null;
  readonly trickLeader: PlayerId | null;
  readonly trickCount: number;
  readonly scores: readonly [number, number];
  readonly winnerTeam: TeamId | null;
  readonly tributeExchanges: readonly TributeExchangeSummary[];
}

export interface ClassifiedPlay {
  readonly kind: PlayKind;
  readonly suit: CardSuit | null;
  readonly mainTrump: boolean;
  readonly tractorStart: Rank | null;
  readonly cardCount: number;
}
