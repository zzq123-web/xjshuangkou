import { classifyPlay } from './classify.js';
import { compareCardValues, isTrump } from '../trump.js';
                                                    

                                   
                          
                                 
 

export function validateFollow(
  hand                 ,
  selected                 ,
  lead             ,
  trumpSuit      
)                   {
  if (selected.length === 0) return invalid('至少选择一张牌。');
  if (new Set(selected.map(card => card.id)).size !== selected.length) return invalid('同一张牌不能重复选择。');
  const handIds = new Set(hand.map(card => card.id));
  if (selected.some(card => !handIds.has(card.id))) return invalid('只能出自己手中的牌。');
  if (lead === null) {
    const kind = classifyPlay(selected, trumpSuit).kind;
    return kind === 'single' || kind === 'pair' || kind === 'tractor'
      ? valid()
      : invalid('首家只能出单张、同牌对子或4/6张拖拉机。');
  }
  if (selected.length !== lead.cards.length) return invalid('跟牌张数必须与首家相同。');

  const leadShape = classifyPlay(lead.cards, trumpSuit);
  if (leadShape.kind === 'single') return validateSingleFollow(hand, selected, lead.cards[0], trumpSuit);
  if (leadShape.kind === 'pair') return validatePairFollow(hand, selected, lead.cards, leadShape.mainTrump, trumpSuit);
  if (leadShape.kind === 'tractor') return validateTractorFollow(hand, selected, lead.cards.length, lead.cards[0].suit, leadShape.mainTrump, trumpSuit);
  return valid();
}

function validateSingleFollow(hand                 , selected                 , lead      , trumpSuit      )                   {
  const leadIsTrump = isTrump(lead, trumpSuit);
  const required = leadIsTrump
    ? hand.filter(card => isTrump(card, trumpSuit))
    : hand.filter(card => card.suit === lead.suit && !isTrump(card, trumpSuit));
  if (required.length === 0) return valid();
  const count = selected.filter(card => leadIsTrump ? isTrump(card, trumpSuit) : card.suit === lead.suit && !isTrump(card, trumpSuit)).length;
  return count === 1 ? valid() : invalid(leadIsTrump ? '有主牌时必须跟一张主牌。' : '有首家副花色时必须跟该副花色。');
}

function validatePairFollow(
  hand                 ,
  selected                 ,
  lead                 ,
  leadIsTrump         ,
  trumpSuit      
)                   {
  const base = leadIsTrump
    ? hand.filter(card => isTrump(card, trumpSuit))
    : hand.filter(card => card.suit === lead[0].suit && !isTrump(card, trumpSuit));
  if (base.length === 0) return valid();
  const pairs = exactPairs(base);
  if (pairs.length > 0) {
    return pairs.some(pair => pair.every(card => selected.some(chosen => chosen.id === card.id)))
      ? valid()
      : invalid('有该花色或主牌对子时，必须跟出其中一对。');
  }
  const requiredCount = Math.min(2, base.length);
  const largest = largestCards(base, requiredCount, trumpSuit);
  return largest.every(card => selected.some(chosen => chosen.id === card.id))
    ? valid()
    : invalid('没有对子时，必须跟出该花色/主牌中的最大牌。');
}

function validateTractorFollow(
  hand                 ,
  selected                 ,
  count        ,
  leadSuit              ,
  leadIsMainTractor         ,
  trumpSuit      
)                   {
  const base = leadIsMainTractor
    ? hand.filter(card => isTrump(card, trumpSuit))
    : hand.filter(card => card.suit === leadSuit && !isTrump(card, trumpSuit));
  if (leadIsMainTractor) {
    if (base.length === 0) return valid();
    const requiredCount = Math.min(count, base.length);
    const played = selected.filter(card => isTrump(card, trumpSuit)).length;
    return played >= requiredCount ? valid() : invalid('有主牌时必须先跟主牌，不足张数再垫副牌。');
  }
  if (base.length < count) return valid();

  const selectedSuit = selected.filter(card => card.suit === leadSuit);
  if (selectedSuit.length !== count) return invalid('该花色张数足够时，拖拉机必须全部跟该花色。');
  const pairs = exactPairs(base);
  const pairCount = Math.min(count / 2, pairs.length);
  const selectedPairs = exactPairs(selectedSuit);
  if (selectedPairs.length !== pairCount) return invalid(`必须跟出${pairCount}对该花色对子。`);

  if (pairs.length <= count / 2) {
    const allPairsPresent = pairs.every(pair => pair.every(card => selectedSuit.some(chosen => chosen.id === card.id)));
    if (!allPairsPresent) return invalid('该花色所有对子都必须跟出。');
  }
  const pairedIds = new Set(pairs.flat().map(card => card.id));
  const singlesNeeded = count - pairCount * 2;
  const largestSingles = largestCards(base.filter(card => !pairedIds.has(card.id)), singlesNeeded, trumpSuit);
  if (!largestSingles.every(card => selectedSuit.some(chosen => chosen.id === card.id))) {
    return invalid('对子以外的张数必须跟该花色最大的单张。');
  }
  return valid();
}

function exactPairs(cards                 )                                     {
  const groups = new Map                ();
  for (const card of cards) {
    const key = `${card.suit}:${card.rank}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length >= 2).map(group => [group[0], group[1]]         );
}

function largestCards(cards                 , count        , trumpSuit      )                  {
  return [...cards].sort((a, b) => compareCardValues(b, a, trumpSuit)).slice(0, count);
}

function valid()                   { return { legal: true, reason: null }; }
function invalid(reason        )                   { return { legal: false, reason }; }
