/**
 * Made-to-measure and options pricing — src/services/configure.ts
 * ============================================================================
 * Two things a vendor can turn on for a listing (client feedback, round 2):
 *
 *   per-metre pricing   the price is per metre of WIDTH (a sofa or kitchen
 *                       counter made to length). The shopper picks a width
 *                       between the vendor's min and max; stretching the piece
 *                       in the 3D room does the same.
 *   options             vendor-defined groups — fabric, legs, handles, colour
 *                       code, texture … — each choice with a swatch and an
 *                       extra price (per piece, or per metre when the listing
 *                       is priced per metre). The first choice is the default.
 *
 * A cart line carries a `config` ({ width_cm, options }) and a `config_key`
 * built from it, so the same sofa at two widths is two lines. The SERVER
 * prices every line from the listing; the client's figure is only a preview.
 *
 * SAME FILE as the frontend's lib/listings/configure.ts — change both.
 * Pure, no imports.
 */

export type PriceUnit = "unit" | "metre";

export type OptionKind = "fabric" | "colour" | "finish" | "legs" | "handles" | "texture" | "other";
export const OPTION_KINDS: { id: OptionKind; name: string }[] = [
  { id: "fabric", name: "Fabric" },
  { id: "colour", name: "Colour" },
  { id: "finish", name: "Finish" },
  { id: "legs", name: "Legs" },
  { id: "handles", name: "Handles" },
  { id: "texture", name: "Texture" },
  { id: "other", name: "Other" },
];

export interface OptionChoice {
  id: string;
  name: string;
  /** vendor's code, e.g. a RAL or fabric reference */
  code?: string;
  /** swatch colour */
  hex?: string;
  /** swatch / texture photo (https) */
  image?: string;
  /** added to the price — per piece, or per metre for per-metre listings */
  price_delta: number;
}

export interface OptionGroup {
  id: string;
  name: string;
  kind: OptionKind;
  choices: OptionChoice[];
}

export interface ListingPricing {
  price_unit: PriceUnit;
  min_width_cm: number | null;
  max_width_cm: number | null;
}

export interface LineConfig {
  width_cm?: number;
  options?: Record<string, string>;
}

export const MAX_GROUPS = 6;
export const MAX_CHOICES = 30;
export const WIDTH_LIMITS = { min: 20, max: 1500 } as const;

const ID_RE = /^[a-z0-9-]{1,40}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-1_000_000, Math.min(1_000_000, Math.round(n * 100) / 100)) : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function uniqueId(base: string, used: Set<string>, fallback: string): string {
  let id = ID_RE.test(base) ? base : slug(base) || fallback;
  if (!id) id = fallback;
  let k = 2;
  const root = id;
  while (used.has(id)) id = `${root}-${k++}`.slice(0, 40);
  used.add(id);
  return id;
}

/** Vendor input → stored option groups. Drops empty groups and nameless choices. */
export function cleanOptionGroups(raw: unknown): OptionGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: OptionGroup[] = [];
  const gIds = new Set<string>();
  for (const g of raw) {
    if (groups.length >= MAX_GROUPS) break;
    const gr = (g ?? {}) as Record<string, unknown>;
    const name = str(gr.name, 40);
    if (!name) continue;
    const kind = OPTION_KINDS.some(k => k.id === gr.kind) ? (gr.kind as OptionKind) : "other";
    const cIds = new Set<string>();
    const choices: OptionChoice[] = [];
    for (const c of Array.isArray(gr.choices) ? gr.choices : []) {
      if (choices.length >= MAX_CHOICES) break;
      const ch = (c ?? {}) as Record<string, unknown>;
      const cname = str(ch.name, 60);
      if (!cname) continue;
      const hex = str(ch.hex, 7);
      const image = str(ch.image, 600);
      const code = str(ch.code, 40);
      const out: OptionChoice = {
        id: uniqueId(str(ch.id, 40) || slug(cname), cIds, `c${choices.length + 1}`),
        name: cname,
        price_delta: money(ch.price_delta),
      };
      if (code) out.code = code;
      if (/^#[0-9a-f]{6}$/i.test(hex)) out.hex = hex.toLowerCase();
      if (/^https:\/\/\S+$/i.test(image)) out.image = image;
      choices.push(out);
    }
    if (!choices.length) continue;
    groups.push({ id: uniqueId(str(gr.id, 40) || slug(name), gIds, `g${groups.length + 1}`), name, kind, choices });
  }
  return groups;
}

/** Vendor input → stored pricing. `listedWidthCm` is the listing's own width. */
export function cleanPricing(raw: unknown, listedWidthCm: number | null | undefined): ListingPricing {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.price_unit !== "metre") return { price_unit: "unit", min_width_cm: null, max_width_cm: null };
  const clamp = (n: number) => Math.round(Math.max(WIDTH_LIMITS.min, Math.min(WIDTH_LIMITS.max, n)));
  const w = Number(listedWidthCm) > 0 ? Number(listedWidthCm) : 200;
  let min = Number(r.min_width_cm);
  let max = Number(r.max_width_cm);
  min = Number.isFinite(min) && min > 0 ? clamp(min) : clamp(w * 0.5);
  max = Number.isFinite(max) && max > 0 ? clamp(max) : clamp(w * 2.5);
  if (min > max) [min, max] = [max, min];
  return { price_unit: "metre", min_width_cm: min, max_width_cm: max };
}

/** A cart line's config, normalised (whole cm, short string ids). */
export function normalizeConfig(raw: unknown): LineConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: LineConfig = {};
  const w = Number(r.width_cm);
  if (r.width_cm != null && Number.isFinite(w) && w > 0) out.width_cm = Math.round(w);
  if (r.options && typeof r.options === "object" && !Array.isArray(r.options)) {
    const entries = Object.entries(r.options as Record<string, unknown>)
      .filter(([g, c]) => ID_RE.test(g) && typeof c === "string" && ID_RE.test(c))
      .slice(0, MAX_GROUPS * 2) as [string, string][];
    if (entries.length) out.options = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

/** Stable line key: "" for a plain line, else e.g. "w240|fabric=velvet|legs=brass". */
export function configKey(cfg: LineConfig | null | undefined): string {
  if (!cfg) return "";
  const parts: string[] = [];
  if (cfg.width_cm != null) parts.push(`w${Math.round(cfg.width_cm)}`);
  for (const [g, c] of Object.entries(cfg.options ?? {}).sort(([a], [b]) => a.localeCompare(b))) parts.push(`${g}=${c}`);
  return parts.join("|");
}

export interface ConfigurableListing extends Partial<ListingPricing> {
  options?: OptionGroup[] | null;
  /** the listing's own width, cm — the default for per-metre lines */
  width_cm?: number | null;
}

export type PriceResult =
  | {
      ok: true;
      unit_price: number;
      /** what was actually priced: width used and every group's choice */
      width_cm: number | null;
      choices: { group: string; group_name: string; choice: string; choice_name: string; code?: string; price_delta: number }[];
      label: string;
    }
  | { ok: false; error: "WIDTH_OUT_OF_RANGE" | "OPTION_UNKNOWN"; message: string };

/**
 * The price of one piece with this config. `basePrice` is the variant's price:
 * per piece, or per metre of width for per-metre listings.
 */
export function priceLine(listing: ConfigurableListing, basePrice: number, cfg: LineConfig | null | undefined): PriceResult {
  const perMetre = listing.price_unit === "metre";
  let width: number | null = null;
  if (perMetre) {
    const listed = Number(listing.width_cm) > 0 ? Math.round(Number(listing.width_cm)) : null;
    width = cfg?.width_cm != null ? Math.round(cfg.width_cm) : listed ?? 100;
    const min = listing.min_width_cm ?? WIDTH_LIMITS.min;
    const max = listing.max_width_cm ?? WIDTH_LIMITS.max;
    if (width < min || width > max) {
      return { ok: false, error: "WIDTH_OUT_OF_RANGE", message: `Choose a width between ${min} and ${max} cm.` };
    }
  }
  const factor = perMetre && width != null ? width / 100 : 1;

  const choices: Extract<PriceResult, { ok: true }>["choices"] = [];
  for (const g of listing.options ?? []) {
    if (!g.choices?.length) continue;
    const picked = cfg?.options?.[g.id];
    const ch = picked ? g.choices.find(c => c.id === picked) : g.choices[0];
    if (!ch) {
      return { ok: false, error: "OPTION_UNKNOWN", message: `That ${g.name.toLowerCase()} is no longer offered. Choose another.` };
    }
    choices.push({ group: g.id, group_name: g.name, choice: ch.id, choice_name: ch.name, code: ch.code, price_delta: ch.price_delta });
  }

  const delta = choices.reduce((a, c) => a + c.price_delta, 0);
  const unit = r2(Math.max(0, (Number(basePrice) + delta) * factor));
  const label = [
    width != null ? `${width} cm wide` : null,
    ...choices.map(c => `${c.group_name}: ${c.choice_name}${c.code ? ` (${c.code})` : ""}`),
  ].filter(Boolean).join(" · ");
  return { ok: true, unit_price: unit, width_cm: width, choices, label };
}
