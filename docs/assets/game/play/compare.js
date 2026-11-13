import { classifyPlay, isPair } from './classify.js';
import { compareCardValues, isTrump, sideStrength, trumpStrength } from '../trump.js';
                                                    

const TRACTOR_RING = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']         ;

export function compareTrickPlays(a      , b      , lead      , trumpSuit      )         {
  if (a.cards.length !== b.cards.length || a.cards.length !== lead.cards.length) return 0;
  const leadKind = classifyPlay(lead.cards, trumpSuit).kind;
  if (leadKind === 'single') return compareSingles(a.cards[0], b.cards[0], lead.cards[0], trumpSuit);
  if (leadKind === 'pair') return comparePairs(a.cards, b.cards, lead.cards, trumpSuit);
  if (leadKind === 'tractor') return compareTractors(a.cards, b.cards, trumpSuit);
  return 0;
}

function compareSingles(a      , b      , lead      , trumpSuit      )         {
  const leadIsTrump = isTrump(lead, trumpSuit);
  const tierA = singleTier(a, lead, leadIsTrump, trumpSuit);
  const tierB = singleTier(b, lead, leadIsTrump, trumpSuit);
  if (tierA !== tierB) return Math.sign(tierA - tierB);
  if (tierA === 3 || (leadIsTrump && tierA === 2)) return Math.sign(trumpStrength(a, trumpSuit) - trumpStrength(b, trumpSuit));
  if (tierA === 2 && !leadIsTrump) return Math.sign(sideStrength(a) - sideStrength(b));
  return Math.sign(compareCardValues(a, b, trumpSuit));
}

function singleTier(card      , lead      , leadIsTrump         , trumpSuit      )         {
  if (leadIsTrump) return isTrump(card, trumpSuit) ? 2 : 1;
  if (isTrump(card, trumpSuit)) return 3;
  return card.suit === lead.suit ? 2 : 1;
}

function comparePairs(a                 , b                 , lead                 , trumpSuit      )         {
  const leadIsTrump = classifyPlay(lead, trumpSuit).mainTrump;
  const tierA = pairTier(a, lead, leadIsTrump, trumpSuit);
  const tierB = pairTier(b, lead, leadIsTrump, trumpSuit);
  if (tierA !== tierB) return Math.sign(tierA - tierB);
  if (tierA === 3) return Math.sign(trumpStrength(a[0], trumpSuit) - trumpStrength(b[0], trumpSuit));
  if (tierA === 2) return Math.sign(sideStrength(a[0]) - sideStrength(b[0]));
  return 0;
}

function pairTier(cards                 , lead                 , leadIsTrump         , trumpSuit      )         {
  if (isPair(cards) && isTrump(cards[0], trumpSuit)) return 3;
  if (!leadIsTrump && isPair(cards) && cards[0].suit === lead[0].suit) return 2;
  return 1;
}

function compareTractors(a                 , b                 , trumpSuit      )         {
  const ca = classifyPlay(a, trumpSuit);
  const cb = classifyPlay(b, trumpSuit);
  const tierA = ca.kind === 'tractor' ? (ca.mainTrump ? 3 : 2) : 1;
  const tierB = cb.kind === 'tractor' ? (cb.mainTrump ? 3 : 2) : 1;
  if (tierA !== tierB) return Math.sign(tierA - tierB);
  if (tierA === 1 || ca.tractorStart === null || cb.tractorStart === null) return 0;
  const indexA = TRACTOR_RING.indexOf(ca.tractorStart                                 );
  const indexB = TRACTOR_RING.indexOf(cb.tractorStart                                 );
  return Math.sign(indexB - indexA);
}
