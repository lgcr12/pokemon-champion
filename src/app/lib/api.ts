export type ApiOptions = RequestInit & { body?: BodyInit | null };

import zhHansTerms from "../../../data/zh-hans-terms.json";

export async function apiRequest<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? { "content-type": "application/json", ...(options.headers || {}) }
      : options.headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Object.assign(new Error(data.error || `请求失败 (${response.status})`), {
      data,
      status: response.status,
    });
    throw error;
  }
  return data as T;
}

export function championStatsToShowdown(value = "") {
  const aliases: Record<string, string> = { h: "HP", a: "Atk", b: "Def", c: "SpA", d: "SpD", s: "Spe" };
  const normalized = String(value)
    .replace(/生命值?/g, "H")
    .replace(/特攻/g, "C")
    .replace(/特防/g, "D")
    .replace(/攻击/g, "A")
    .replace(/防御/g, "B")
    .replace(/速度/g, "S")
    .replace(/\bHP\b/gi, "H");
  const entries = [...normalized.matchAll(/(?:^|[\s/,])([habcds])\s*(\d{1,3})(?=$|[\s/,])/gi)];
  return entries.length
    ? entries.map((match) => `${match[2]} ${aliases[match[1].toLowerCase()]}`).join(" / ")
    : String(value).trim();
}

type TermCategory = "moves" | "abilities" | "items";

function compactTerm(value: unknown) {
  return String(value || "").toLowerCase().replace(/[\s·・'’‘_-]+/g, "");
}

function titleFromSlug(value: string) {
  return value.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

const TERM_ALIASES: Record<TermCategory, Record<string, string>> = {
  moves: {},
  abilities: {},
  items: { "盔甲鸟进化石": "Skarmorite" },
};

/** Converts PokéCamp's localized fallback fields to names understood by Showdown. */
export function resolveShowdownTerm(value: unknown, referenceName: unknown, category: TermCategory) {
  const reference = String(referenceName || "").trim();
  if (reference && !/[\u3400-\u9fff\u3040-\u30ff]/.test(reference) && reference.length < 80) return reference;
  const direct = String(value || "").trim();
  if (direct && !/[\u3400-\u9fff\u3040-\u30ff]/.test(direct) && direct.length < 80) return direct;
  const raw = direct.split(/\s+/)[0];
  if (!raw) return "";
  if (TERM_ALIASES[category][raw]) return TERM_ALIASES[category][raw];
  const table = (zhHansTerms as any)[category] || {};
  const match = Object.entries(table).find(([, label]) => compactTerm(label) === compactTerm(raw));
  return match ? titleFromSlug(String(match[0])) : raw;
}

export function teamToShowdown(team: any[] = []) {
  return team.map((member) => [
    `${member.species || member.name} @ ${member.item}`,
    `Ability: ${member.ability}`,
    "Level: 50",
    ...(member.stats ? [`EVs: ${championStatsToShowdown(member.stats)}`] : []),
    ...(member.nature ? [`${member.nature} Nature`] : []),
    ...(member.moves || []).map((move: string) => `- ${move}`),
  ].join("\n")).join("\n\n");
}

export function spriteUrl(sprite: string | number) {
  const value = String(sprite || "").trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `https://pokecamp.cc${value}`;
  if (/^\d+$/.test(value)) {
    return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${value}.png`;
  }
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const slug = normalized.includes("-") ? normalized : normalized.replace(/(alola|galar|hisui|paldea|mega[xy]?|gmax|primal|combat|blaze|aqua|midday|midnight|dusk)$/i, "-$1");
  return `https://play.pokemonshowdown.com/sprites/gen5/${slug}.png`;
}

export function formatRuleName(name = "") {
  return name.replace(/^\[Gen \d+ Champions\]\s*/, "");
}

// Keep legacy session files unchanged, but prevent mojibake team titles from
// leaking into the UI after they are read back from the sidecar.
export function displayTeamTitle(value: unknown, teamId = "", fallback = "规则内热门队伍") {
  const title = String(value ?? "").trim();
  const looksCorrupted = /[�]|銉|銇|銈|繧|锛|鎴|璇|鍚|绔|璧|鏃|鏈|鐜|浠|鍙|缁|娴|闂/.test(title);
  if (!title || looksCorrupted) {
    const shortId = String(teamId || "").trim().slice(0, 8);
    return shortId ? `${fallback} · ${shortId}` : fallback;
  }
  return title;
}
