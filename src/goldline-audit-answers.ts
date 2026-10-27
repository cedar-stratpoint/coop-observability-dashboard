// Answers from a filled Nichido Data Audit PDF (the SKU linking worksheet), turned
// into a plan of Coop decisions. Pure: the script in scripts/nichido reads the PDF and
// the current links, and applies the plan with the same functions as the SKU linking
// page. Field names are set by the report generator:
//   A~<sku>~<item>.answer  'Correct' | 'Wrong'      A~<sku>~<item>.notes
//   B~<sku>.itemCode  B~<sku>.formPage  B~<sku>.notes
//   C~<item>.answer  'Sold at Watsons' | 'Not sold at Watsons'   C~<item>.watsonsCode  C~<item>.notes
//   L~<sku>~<item>.looksWrong  (checkbox)
// The expected item travels in the A and L names, so a suggestion that changed after
// the report was printed is never approved or rejected by mistake.

export type AuditAnswers = {
  matches: Array<{sku: string; item: string; answer: 'correct' | 'wrong' | null; notes: string}>;
  picks: Array<{sku: string; itemCode: string; formPage: string; notes: string}>;
  formItems: Array<{item: string; atWatsons: 'sold' | 'not_sold' | null; watsonsCode: string; notes: string}>;
  flagged: Array<{sku: string; item: string}>;
};

export type FieldValue = string | boolean | null | undefined;

const clean = (v: FieldValue) => (typeof v === 'string' ? v.trim() : '');

/** Group raw field values (name -> value) into the four parts of the report. */
export function parseAuditFields(fields: Record<string, FieldValue>): AuditAnswers {
  const out: AuditAnswers = {matches: [], picks: [], formItems: [], flagged: []};
  const groups = new Map<string, Record<string, FieldValue>>();
  for (const [name, value] of Object.entries(fields)) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) continue;
    const key = name.slice(0, dot);
    const g = groups.get(key) ?? {};
    g[name.slice(dot + 1)] = value;
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const [part, a, b] = key.split('~');
    if (part === 'A' && a && b) {
      const ans = clean(g.answer).toLowerCase();
      out.matches.push({sku: a, item: b, answer: ans === 'correct' ? 'correct' : ans === 'wrong' ? 'wrong' : null, notes: clean(g.notes)});
    } else if (part === 'B' && a) {
      out.picks.push({sku: a, itemCode: clean(g.itemCode), formPage: clean(g.formPage), notes: clean(g.notes)});
    } else if (part === 'C' && a) {
      const ans = clean(g.answer).toLowerCase();
      out.formItems.push({item: a, atWatsons: ans === 'sold at watsons' ? 'sold' : ans === 'not sold at watsons' ? 'not_sold' : null, watsonsCode: clean(g.watsonsCode), notes: clean(g.notes)});
    } else if (part === 'L' && a && b && g.looksWrong === true) {
      out.flagged.push({sku: a, item: b});
    }
  }
  return out;
}

/** What Coop looks like right now, for the SKUs and items the answers touch. */
export type LinkState = {
  linkedItemBySku: Map<string, string>; // Watsons SKU -> item it is linked to
  skuByItem: Map<string, string>; // item -> Watsons SKU it is linked to
  suggestionBySku: Map<string, string>; // Watsons SKU -> item Coop suggests now
  knownSkus: Set<string>; // Watsons SKUs in the chain list
  knownItems: Set<string>; // catalog item codes (upper case)
};

export type PlannedAction =
  | {kind: 'approve'; sku: string; item: string; remark: string}
  | {kind: 'reject'; sku: string; item: string; remark: string}
  | {kind: 'link'; sku: string; item: string; remark: string; from: 'B' | 'C'}
  | {kind: 'remark'; sku: string; remark: string};

export type AuditPlan = {
  actions: PlannedAction[];
  skipped: Array<{where: string; why: string}>; // answered, but not applied (already done or conflict)
  forUs: Array<{where: string; what: string}>; // needs a person: flagged links, "not sold", notes without a SKU
};

const NOT_OURS = /^(not ours|none|n\/?a|wala)$/i;

export function planAudit(ans: AuditAnswers, st: LinkState): AuditPlan {
  const plan: AuditPlan = {actions: [], skipped: [], forUs: []};
  const takenSku = new Set<string>(); // SKUs linked earlier in this plan
  const takenItem = new Set<string>();
  const itemFree = (item: string) => !st.skuByItem.has(item) && !takenItem.has(item);
  const skuFree = (sku: string) => !st.linkedItemBySku.has(sku) && !takenSku.has(sku);

  for (const m of ans.matches) {
    const where = `A · ${m.sku} → ${m.item}`;
    if (!m.answer) {
      if (m.notes) plan.actions.push({kind: 'remark', sku: m.sku, remark: m.notes});
      continue;
    }
    if (st.linkedItemBySku.get(m.sku) === m.item) {
      plan.skipped.push({where, why: m.answer === 'correct' ? 'Already linked to that item.' : 'Already linked to that item. Unlink it in Coop if it is wrong.'});
      continue;
    }
    if (st.suggestionBySku.get(m.sku) !== m.item) {
      plan.skipped.push({where, why: 'Coop’s suggestion changed since the report was printed. Decide it in Coop.'});
      continue;
    }
    if (m.answer === 'correct') {
      if (!itemFree(m.item)) {
        plan.skipped.push({where, why: `${m.item} is already linked to another Watsons SKU.`});
        continue;
      }
      plan.actions.push({kind: 'approve', sku: m.sku, item: m.item, remark: m.notes});
      takenSku.add(m.sku);
      takenItem.add(m.item);
    } else {
      plan.actions.push({kind: 'reject', sku: m.sku, item: m.item, remark: m.notes});
    }
  }

  for (const p of ans.picks) {
    const where = `B · ${p.sku}`;
    const code = p.itemCode.toUpperCase();
    if (!code) {
      if (p.notes) plan.actions.push({kind: 'remark', sku: p.sku, remark: p.notes});
      continue;
    }
    if (NOT_OURS.test(p.itemCode)) {
      plan.actions.push({kind: 'remark', sku: p.sku, remark: ['Not one of ours (audit PDF)', p.notes].filter(Boolean).join('. ')});
      continue;
    }
    if (!st.knownItems.has(code)) {
      plan.skipped.push({where, why: `"${p.itemCode}" is not an item code in the catalog.`});
      continue;
    }
    if (!skuFree(p.sku)) {
      plan.skipped.push({where, why: `Already linked to ${st.linkedItemBySku.get(p.sku) ?? 'an item'}.`});
      continue;
    }
    if (!itemFree(code)) {
      plan.skipped.push({where, why: `${code} is already linked to another Watsons SKU.`});
      continue;
    }
    plan.actions.push({kind: 'link', sku: p.sku, item: code, remark: p.notes, from: 'B'});
    takenSku.add(p.sku);
    takenItem.add(code);
  }

  for (const c of ans.formItems) {
    const where = `C · ${c.item}`;
    const sku = c.watsonsCode.replace(/\s+/g, '');
    if (sku) {
      if (!st.knownSkus.has(sku)) plan.skipped.push({where, why: `Watsons code ${sku} is not in the Watsons list.`});
      else if (!skuFree(sku)) plan.skipped.push({where, why: `Watsons code ${sku} is already linked to ${st.linkedItemBySku.get(sku) ?? 'an item'}.`});
      else if (!itemFree(c.item)) plan.skipped.push({where, why: `${c.item} is already linked.`});
      else {
        plan.actions.push({kind: 'link', sku, item: c.item, remark: c.notes, from: 'C'});
        takenSku.add(sku);
        takenItem.add(c.item);
        continue;
      }
    }
    if (c.atWatsons === 'not_sold') plan.forUs.push({where, what: `Not sold at Watsons${c.notes ? `: ${c.notes}` : ''}`});
    else if (c.atWatsons === 'sold' && !sku) plan.forUs.push({where, what: `Sold at Watsons, code not given${c.notes ? `: ${c.notes}` : ''}`});
    else if (!sku && c.notes) plan.forUs.push({where, what: c.notes});
  }

  for (const l of ans.flagged) plan.forUs.push({where: `Appendix · ${l.sku} → ${l.item}`, what: 'Marked "Looks wrong". Check it, then unlink in Coop if so.'});
  return plan;
}
