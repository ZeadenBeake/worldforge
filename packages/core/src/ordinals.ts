import type { OrdinalConfig, Warning } from "./types";

export const DEFAULT_ORDINALS: OrdinalConfig = {
  chance: { common: 4, uncommon: 2, rare: 1, very_rare: 0.25 },
  // One shared probability scale (used for off-species inheritance and similar).
  probability: { none: 0, very_low: 0.01, low: 0.05, medium: 0.15 },
  strength: { nudge: 1, habit: 2, drive: 3, compulsion: 4 },
};

export function mergeOrdinals(over?: Partial<OrdinalConfig>): OrdinalConfig {
  return {
    chance: { ...DEFAULT_ORDINALS.chance, ...over?.chance },
    probability: { ...DEFAULT_ORDINALS.probability, ...over?.probability },
    strength: { ...DEFAULT_ORDINALS.strength, ...over?.strength },
  };
}

/** Weight for a chance ordinal. Unknown labels degrade to weight 1 with a warning. */
export function chanceWeight(cfg: OrdinalConfig, name: string, warnings?: Warning[]): number {
  const w = cfg.chance[name];
  if (w === undefined) {
    warnings?.push({ code: "unknown_ordinal", message: `Unknown chance ordinal "${name}"`, subject: name });
    return 1;
  }
  return w;
}

/** Probability for a probability ordinal. Unknown labels degrade to 0 with a warning. */
export function probabilityOf(cfg: OrdinalConfig, name: string, warnings?: Warning[]): number {
  const p = cfg.probability[name];
  if (p === undefined) {
    warnings?.push({ code: "unknown_ordinal", message: `Unknown probability ordinal "${name}"`, subject: name });
    return 0;
  }
  return p;
}

/** Rank for a behavior strength. Unknown labels degrade to 0 (weakest) with a warning. */
export function strengthRank(cfg: OrdinalConfig, name: string, warnings?: Warning[]): number {
  const r = cfg.strength[name];
  if (r === undefined) {
    warnings?.push({ code: "unknown_ordinal", message: `Unknown strength ordinal "${name}"`, subject: name });
    return 0;
  }
  return r;
}
