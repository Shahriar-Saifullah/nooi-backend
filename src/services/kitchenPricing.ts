/**
 * Kitchen price list and quote — src/services/kitchenPricing.ts
 * ============================================================================
 * Nooi's own price list (admin → Settings → Kitchen prices), not a vendor's:
 * kitchens are quoted by the linear metre, the way kitchen makers price them,
 * plus per-unit items (hood, handles, appliances).
 *
 *   cabinets     SAR per metre of run, by cabinet kind
 *   uppers       SAR per metre of wall cabinets
 *   countertop   SAR per metre, by material (over every base cabinet)
 *   fronts       style and finish multiply the cabinet price
 *   handles      SAR per handle, by style × hardware factor
 *   appliances   SAR per unit, only when the client asks for them
 *   install      a percentage of everything else
 *
 * SAME FILE as the frontend's lib/kitchen/pricing.ts — change both.
 * Pure, no imports, so both sides can share it as-is.
 */

export type KitchenModuleKind =
  | "base-door" | "drawer-base" | "sink-base" | "dishwasher" | "cooktop-gas"
  | "cooktop-induction" | "oven-tower" | "tall-pantry" | "fridge-single";

export const KITCHEN_KINDS: KitchenModuleKind[] = [
  "base-door", "drawer-base", "sink-base", "dishwasher", "cooktop-gas",
  "cooktop-induction", "oven-tower", "tall-pantry", "fridge-single",
];

/** Kinds that stand floor to tall height: no countertop over them. */
export const TALL_KINDS = new Set<KitchenModuleKind>(["oven-tower", "tall-pantry", "fridge-single"]);

export const APPLIANCE_KINDS: KitchenModuleKind[] = ["sink-base", "dishwasher", "cooktop-gas", "cooktop-induction", "oven-tower", "fridge-single"];

export interface KitchenPriceList {
  currency: string;
  /** SAR per metre of cabinet, by kind (carcass + front, before multipliers) */
  cabinet_per_m: Record<KitchenModuleKind, number>;
  /** SAR per metre of wall cabinets */
  upper_per_m: number;
  /** SAR per cooker hood */
  hood_unit: number;
  /** SAR per metre of worktop, by countertop id */
  countertop_per_m: Record<string, number>;
  /** used for a countertop that isn't listed */
  countertop_default_per_m: number;
  /** multipliers on cabinets for the front style */
  front_style_factor: Record<string, number>;
  /** multiplier on cabinets for wood-veneer fronts */
  wood_front_factor: number;
  /** SAR per handle, by handle style */
  handle_unit: Record<string, number>;
  /** multiplier on handles, by hardware finish */
  hardware_factor: Record<string, number>;
  /** SAR per appliance (sink + tap, dishwasher, hob, oven, fridge) */
  appliance_unit: Partial<Record<KitchenModuleKind, number>>;
  /** % of the total, for delivery and fitting */
  install_percent: number;
}

export const DEFAULT_KITCHEN_PRICES: KitchenPriceList = {
  currency: "SAR",
  cabinet_per_m: {
    "base-door": 1600,
    "drawer-base": 2200,
    "sink-base": 1700,
    "dishwasher": 300,
    "cooktop-gas": 1600,
    "cooktop-induction": 1600,
    "oven-tower": 3600,
    "tall-pantry": 3800,
    "fridge-single": 900,
  },
  upper_per_m: 1300,
  hood_unit: 1800,
  countertop_per_m: {
    "quartz-white": 1100,
    "quartz-grey": 1100,
    "marble-calacatta": 1900,
    "granite-black": 900,
    "wood-oak": 800,
  },
  countertop_default_per_m: 1000,
  front_style_factor: { slab: 1, shaker: 1.12, "raised-arch": 1.25 },
  wood_front_factor: 1.2,
  handle_unit: { bar: 35, knob: 25, cutout: 0, none: 0 },
  hardware_factor: { chrome: 1, black: 1.1, brass: 1.5 },
  appliance_unit: {
    "sink-base": 950,
    "dishwasher": 2200,
    "cooktop-gas": 1500,
    "cooktop-induction": 2600,
    "oven-tower": 2800,
    "fridge-single": 3500,
  },
  install_percent: 12,
};

const LIMIT = 1_000_000;
const num = (v: unknown, fallback: number, max = LIMIT) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : fallback;
};
const rec = (raw: unknown, base: Record<string, number>, max = LIMIT, extraKeys = true): Record<string, number> => {
  const out: Record<string, number> = { ...base };
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(src)) {
    if (!/^[a-z0-9-]{1,40}$/.test(k)) continue;
    if (!extraKeys && !(k in base)) continue;
    out[k] = num(v, base[k] ?? 0, max);
  }
  return out;
};

/** A complete, sane price list from whatever was stored or sent. */
export function cleanKitchenPrices(raw: unknown): KitchenPriceList {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_KITCHEN_PRICES;
  return {
    currency: typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : d.currency,
    cabinet_per_m: rec(r.cabinet_per_m, d.cabinet_per_m, LIMIT, false) as KitchenPriceList["cabinet_per_m"],
    upper_per_m: num(r.upper_per_m, d.upper_per_m),
    hood_unit: num(r.hood_unit, d.hood_unit),
    countertop_per_m: rec(r.countertop_per_m, d.countertop_per_m),
    countertop_default_per_m: num(r.countertop_default_per_m, d.countertop_default_per_m),
    front_style_factor: rec(r.front_style_factor, d.front_style_factor, 10, false),
    wood_front_factor: num(r.wood_front_factor, d.wood_front_factor, 10),
    handle_unit: rec(r.handle_unit, d.handle_unit, LIMIT, false),
    hardware_factor: rec(r.hardware_factor, d.hardware_factor, 10, false),
    appliance_unit: rec(r.appliance_unit, d.appliance_unit as Record<string, number>, LIMIT, false) as KitchenPriceList["appliance_unit"],
    install_percent: num(r.install_percent, d.install_percent, 100),
  };
}

// ── Quote ───────────────────────────────────────────────────────────────────

export interface QuoteModule { kind: KitchenModuleKind | string; width: number; upper: "cabinet" | "hood" | null }
export interface QuoteInput {
  runs: { modules: QuoteModule[] }[];
  style: { frontStyle: string; handleStyle: string; front: string; countertop: string; hardware: string };
}

export interface QuoteLine {
  key: string;
  label: string;
  qty: number;
  unit: "m" | "pcs";
  rate: number;
  amount: number;
}

export interface KitchenQuote {
  lines: QuoteLine[];
  subtotal: number;
  install: number;
  vat: number;
  total: number;
  currency: string;
  /** total linear metres of cabinets */
  metres: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** How many handles a module's fronts carry (doors / drawers). */
export function handlesFor(m: QuoteModule): number {
  let n = 0;
  switch (m.kind) {
    case "drawer-base": n = 3; break;
    case "base-door":
    case "sink-base": n = m.width > 0.5 ? 2 : 1; break;
    case "tall-pantry": n = m.width > 0.5 ? 2 : 1; break;
    case "oven-tower": n = 2; break;
    case "dishwasher": n = 1; break;
    case "fridge-single": n = 0; break;
    default: n = 0;          // cooktops: the drawer below counts as 1
  }
  if (m.kind === "cooktop-gas" || m.kind === "cooktop-induction") n = 1;
  if (m.upper === "cabinet") n += m.width > 0.5 ? 2 : 1;
  return n;
}

const KIND_LABEL: Record<string, string> = {
  "base-door": "Base cabinets",
  "drawer-base": "Drawer cabinets",
  "sink-base": "Sink cabinets",
  "dishwasher": "Dishwasher housing",
  "cooktop-gas": "Cooktop base cabinets",
  "cooktop-induction": "Cooktop base cabinets",
  "oven-tower": "Oven towers",
  "tall-pantry": "Tall pantries",
  "fridge-single": "Fridge housing",
};
const APPLIANCE_LABEL: Record<string, string> = {
  "sink-base": "Sink & mixer tap",
  "dishwasher": "Dishwasher",
  "cooktop-gas": "Gas hob",
  "cooktop-induction": "Induction hob",
  "oven-tower": "Built-in oven",
  "fridge-single": "Fridge",
};

/**
 * Price a kitchen from the price list. Widths are real metres. VAT is the
 * Saudi 15% on everything, installation included.
 */
export function quoteKitchen(
  data: QuoteInput,
  prices: KitchenPriceList,
  opts: { includeAppliances?: boolean; vatRate?: number; countertopName?: string } = {},
): KitchenQuote {
  const mods = data.runs.flatMap(r => r.modules);
  const lines: QuoteLine[] = [];
  const add = (key: string, label: string, qty: number, unit: "m" | "pcs", rate: number) => {
    if (qty <= 0) return;
    const amount = r2(qty * rate);
    const hit = lines.find(l => l.key === key);
    if (hit) { hit.qty = r2(hit.qty + qty); hit.amount = r2(hit.amount + amount); }
    else lines.push({ key, label, qty: r2(qty), unit, rate: r2(rate), amount });
  };

  const isWood = data.style.front.startsWith("wood");
  const factor = (prices.front_style_factor[data.style.frontStyle] ?? 1) * (isWood ? prices.wood_front_factor : 1);

  // cabinets by kind (cooktop bases share a line)
  for (const m of mods) {
    const kind = m.kind as KitchenModuleKind;
    const rate = (prices.cabinet_per_m[kind] ?? prices.cabinet_per_m["base-door"]) * factor;
    const key = kind === "cooktop-induction" ? "cab:cooktop-gas" : `cab:${kind}`;
    add(key, KIND_LABEL[kind] ?? "Cabinets", m.width, "m", rate);
  }

  // wall cabinets and hoods
  const upperM = mods.filter(m => m.upper === "cabinet").reduce((a, m) => a + m.width, 0);
  add("upper", "Wall cabinets", upperM, "m", prices.upper_per_m * factor);
  add("hood", "Cooker hood", mods.filter(m => m.upper === "hood").length, "pcs", prices.hood_unit);

  // worktop over everything that isn't tall
  const topM = mods.filter(m => !TALL_KINDS.has(m.kind as KitchenModuleKind)).reduce((a, m) => a + m.width, 0);
  const topRate = prices.countertop_per_m[data.style.countertop] ?? prices.countertop_default_per_m;
  add("countertop", `Countertop${opts.countertopName ? ` (${opts.countertopName})` : ""}`, topM, "m", topRate);

  // handles
  const handleRate = (prices.handle_unit[data.style.handleStyle] ?? 0) * (prices.hardware_factor[data.style.hardware] ?? 1);
  add("handles", "Handles", mods.reduce((a, m) => a + handlesFor(m), 0), "pcs", handleRate);

  if (opts.includeAppliances) {
    for (const m of mods) {
      const rate = prices.appliance_unit[m.kind as KitchenModuleKind];
      if (rate) add(`app:${m.kind}`, APPLIANCE_LABEL[m.kind] ?? "Appliance", 1, "pcs", rate);
    }
  }

  const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0));
  const install = r2((subtotal * prices.install_percent) / 100);
  const vat = r2((subtotal + install) * (opts.vatRate ?? 0.15));
  return {
    lines,
    subtotal,
    install,
    vat,
    total: r2(subtotal + install + vat),
    currency: prices.currency,
    metres: r2(mods.reduce((a, m) => a + m.width, 0)),
  };
}
