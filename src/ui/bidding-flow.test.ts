import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../game/types.js';
import { createDeck, dealHands } from '../game/deck.js';
import { chooseTributeCards } from '../game/tribute.js';
import { chooseBotReturn } from './bot.js';

const scenario = vi.hoisted(() => ({ mode: 'bidding' }));
vi.mock('../game/engine.js', async importOriginal => {
  const engine = await importOriginal<typeof import('../game/engine.js')>();
  const create: typeof engine.createGameState = (hands, dealer, priorRules) => {
    const state = engine.createGameState(hands, dealer, priorRules);
    if (scenario.mode === 'tribute-winner' || scenario.mode === 'tribute-loser') return {
      ...state, phase: 'round-end', dealer: 0, partner: 2, trumpSuit: 'clubs',
      winnerTeam: scenario.mode === 'tribute-winner' ? 0 : 1, scores: [140, 60]
    };
    if (scenario.mode === 'called') return { ...state, phase: 'play', dealer: 0, partner: 1, trumpSuit: 'clubs', calledCard: { suit: 'spades', rank: 'A' } };
    return state;
  };
  return { ...engine, createGameState: create };
});

vi.mock('../game/deck.js', async importOriginal => {
  const deck = await importOriginal<typeof import('../game/deck.js')>();
  return { ...deck, shuffleCards: (cards: readonly Card[]) => [...cards] };
});

class ClickTarget {
  readonly dataset: Record<string, string>;
  constructor(dataset: Record<string, string>) { this.dataset = dataset; }
  closest(selector: string): ClickTarget | null {
    const keys: Record<string, string> = {
      '[data-action]': 'action', '[data-card]': 'card', '[data-count]': 'count', '[data-bid-viewer]': 'bidViewer'
    };
    return this.dataset[keys[selector]] === undefined ? null : this;
  }
}

const listeners = new Map<string, (event: { target: ClickTarget }) => void>();
const app = {
  innerHTML: '',
  addEventListener: (name: string, listener: (event: { target: ClickTarget }) => void) => { listeners.set(name, listener); }
};
function click(dataset: Record<string, string>): void {
  const listener = listeners.get('click');
  if (!listener) throw new Error('UI click handler missing.');
  listener({ target: new ClickTarget(dataset) });
}

beforeEach(() => {
  scenario.mode = 'bidding';
  vi.resetModules();
  vi.useFakeTimers();
  app.innerHTML = '';
  listeners.clear();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  vi.stubGlobal('document', { querySelector: () => app });
  vi.stubGlobal('Element', ClickTarget);
  vi.stubGlobal('window', {
    location: { search: '' }, confirm: () => true,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('local bidding race', () => {
  it('lets all bots respond before the human and preserves the human selection', async () => {
    await import('./main.js');
    click({ action: 'start-local' });
    click({ card: 'clubs-K-1' });
    click({ card: 'clubs-K-2' });
    expect(app.innerHTML).toContain('已选2张');

    await vi.advanceTimersByTimeAsync(8000);
    expect(app.innerHTML).toContain('3/4名玩家已完成选择');
    expect(app.innerHTML).toContain('已选2张');
    expect(app.innerHTML).toContain('本轮已锁定6张拖拉机');
    expect(app.innerHTML).toContain('抢叫庄');

    click({ action: 'clear' });
    for (const rank of ['A', 'K', 'Q']) {
      click({ card: `clubs-${rank}-1` });
      click({ card: `clubs-${rank}-2` });
    }
    click({ action: 'bid' });
    expect(app.innerHTML).toContain('争庄牌已统一揭晓');
  });

  it('lets the human lock pairs first and waits for all bots before choosing the dealer', async () => {
    await import('./main.js');
    click({ action: 'start-local' });
    click({ card: 'clubs-K-1' });
    click({ card: 'clubs-K-2' });
    click({ action: 'bid' });
    expect(app.innerHTML).toContain('本轮已锁定对子（2张）');
    expect(app.innerHTML).toContain('1/4名玩家已完成选择');
    expect(app.innerHTML).not.toContain('成为庄家');

    await vi.advanceTimersByTimeAsync(8000);
    expect(app.innerHTML).toContain('玩家1成为庄家');
    expect(app.innerHTML).not.toContain('The bid must match');
  });
});

describe('interactive tribute UI and records', () => {
  it('waits for the human loser to choose and submit their tribute', async () => {
    scenario.mode = 'tribute-loser';
    await import('./main.js');
    click({ action: 'start-local' });
    click({ action: 'next' });
    expect(app.innerHTML).toContain('确认上供（2张）');
    await vi.advanceTimersByTimeAsync(3000);
    expect(app.innerHTML).toContain('确认上供（2张）');
    const offered = chooseTributeCards(dealHands(createDeck())[0], 2, 'clubs');
    for (const card of offered) click({ card: card.id });
    click({ action: 'tribute-offer' });
    await vi.advanceTimersByTimeAsync(1800);
    expect(app.innerHTML).toContain('玩家1上供：');
    expect(app.innerHTML).toContain('玩家1收到还牌：');
    expect(app.innerHTML).not.toContain('人机1收到供牌：');
    expect(app.innerHTML).not.toContain('人机2上供：');
    expect(app.innerHTML).not.toContain('人机3还牌：');
    expect(app.innerHTML).toContain('抢庄');
  });

  it('waits for the human winner to select returns after receiving tribute', async () => {
    scenario.mode = 'tribute-winner';
    await import('./main.js');
    click({ action: 'start-local' });
    click({ action: 'next' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(app.innerHTML).toContain('确认还牌（2张）');
    expect(app.innerHTML).toContain('29张 · 已选0张');
    expect(app.innerHTML).toContain('玩家1收到供牌：');
    await vi.advanceTimersByTimeAsync(2000);
    expect(app.innerHTML).toContain('确认还牌（2张）');
    const ids = [...app.innerHTML.matchAll(/data-card="([^"]+)"/g)].map(match => match[1]);
    const hand = createDeck().filter(card => ids.includes(card.id));
    const returned = chooseBotReturn(hand, 2, 'clubs');
    for (const card of returned) click({ card: card.id });
    click({ action: 'tribute-return' });
    await vi.advanceTimersByTimeAsync(500);
    expect(app.innerHTML).toContain('玩家1还牌：');
    expect(app.innerHTML).toContain('27张 · 已选0张');
    expect(app.innerHTML).not.toContain('人机2收到供牌：');
  });

  it('shows the called card in the header and records actual public card faces', async () => {
    scenario.mode = 'called';
    await import('./main.js');
    click({ action: 'start-local' });
    expect(app.innerHTML).toContain('叫队友牌 <strong>♠A</strong>');
    click({ card: 'clubs-4-1' });
    click({ action: 'play' });
    expect(app.innerHTML).toContain('玩家1出牌：♣4');
  });
});

it('asks the human dealer for one complete six-card return and keeps recipient records private', async () => {
  await import('./main.js');
  click({ action: 'start-local' });
  click({ card: 'clubs-K-1' });
  click({ card: 'clubs-K-2' });
  click({ action: 'bid' });
  await vi.advanceTimersByTimeAsync(8000);
  expect(app.innerHTML).toContain('确认还牌（6张）');
  expect(app.innerHTML).toContain('33张 · 已选0张');
  const ids = [...app.innerHTML.matchAll(/data-card="([^"]+)"/g)].map(match => match[1]);
  const hand = createDeck().filter(card => ids.includes(card.id));
  for (const card of chooseBotReturn(hand, 6, 'clubs')) click({ card: card.id });
  click({ action: 'exchange' });
  expect(app.innerHTML).toContain('确认叫队友');
  expect(app.innerHTML).toContain('玩家1争庄还牌：');
  expect(app.innerHTML).not.toContain('人机1争庄收到牌：');
});
