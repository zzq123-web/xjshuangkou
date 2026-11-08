import type { Card, GameState, PlayerId, TeamId } from './types.js';

export interface TrickScore {
  readonly points: number;
  readonly multiplier: number;
}

export function scoreCards(cards: readonly Card[]): number {
  return cards.reduce((points, card) => points + (card.rank === '5' ? 5 : card.rank === '10' || card.rank === 'K' ? 10 : 0), 0);
}

export function lastTrickMultiplier(cardCount: number): number {
  if (cardCount === 1 || cardCount === 2) return 2;
  if (cardCount === 4) return 3;
  if (cardCount === 6) return 4;
  return 1;
}

export function scoreTrick(cards: readonly Card[], cardCount: number, isLastTrick: boolean): TrickScore {
  const multiplier = isLastTrick ? lastTrickMultiplier(cardCount) : 1;
  return { points: scoreCards(cards) * multiplier, multiplier };
}

export function teamOf(state: GameState, player: PlayerId): TeamId {
  if (state.dealer === null || state.partner === null) throw new Error('Teams are not assigned yet.');
  return player === state.dealer || player === state.partner ? 0 : 1;
}

export function awardTrick(state: GameState, winner: PlayerId, cards: readonly Card[], cardCount: number, isLastTrick: boolean): GameState {
  const team = teamOf(state, winner);
  const scored = scoreTrick(cards, cardCount, isLastTrick);
  const scores: readonly [number, number] = team === 0
    ? [state.scores[0] + scored.points, state.scores[1]]
    : [state.scores[0], state.scores[1] + scored.points];
  const winnerTeam = isLastTrick ? (scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1) : state.winnerTeam;
  return {
    ...state,
    phase: isLastTrick ? 'round-end' : state.phase,
    scores,
    trickCount: state.trickCount + 1,
    winnerTeam
  };
}
