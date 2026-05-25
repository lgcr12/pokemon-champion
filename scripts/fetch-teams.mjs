import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const BASE_URL = "https://pokemon-teams.pages.dev/search?format=all";
const OUT_FILE = "data/team-data.json";
const TEAM_LIMIT = Number(process.env.TEAM_LIMIT || 300);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 350);
const DETAIL_LIMIT = Number(process.env.DETAIL_LIMIT || TEAM_LIMIT);
const ENRICH_TEAMS = process.env.ENRICH_TEAMS !== "0";

const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeEntities(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("<!-- -->", "")
    .trim();
}

async function fetchText(url, retries = 4) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res.text();
      lastError = new Error(`Fetch failed ${res.status}: ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(900 * (attempt + 1));
  }
  throw lastError;
}

function pageUrl(page) {
  return page <= 1 ? BASE_URL : `${BASE_URL}&page=${page}`;
}

function extractPageCount(html) {
  const pages = [...html.matchAll(/page=(\d+)/g)].map((match) => Number(match[1]));
  return Math.max(1, ...pages.filter(Number.isFinite));
}

function pokemonIdFromSprite(sprite = "") {
  const match = sprite.match(/\/pokemon\/(\d+)\.png/);
  return Number(match?.[1] || 0);
}

function normalizeFormat(formatLabel = "") {
  const lower = formatLabel.toLowerCase();
  if (lower.includes("double")) return "double";
  return "single";
}

function stableId(team) {
  return createHash("sha1")
    .update(`${team.href}|${team.title}|${team.members.map((member) => member.id).join(",")}`)
    .digest("hex")
    .slice(0, 12);
}

function tweetApiUrl(href = "") {
  const match = href.match(/x\.com\/([^/]+)\/status\/(\d+)/) || href.match(/twitter\.com\/([^/]+)\/status\/(\d+)/);
  if (!match) return "";
  return `https://api.fxtwitter.com/${match[1]}/status/${match[2]}`;
}

function absoluteUrl(url = "") {
  return url.replaceAll("&amp;", "&");
}

function articleTextFromHtml(html = "") {
  const match =
    html.match(/<div class="entry-content[\s\S]*?<div class="social-buttons/) ||
    html.match(/<article[\s\S]*?<\/article>/) ||
    html.match(/<main[\s\S]*?<\/main>/);
  const source = match?.[0] || html;
  return decodeEntities(
    source
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<\/p>|<\/h\d>|<\/li>|<\/div>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " "),
  );
}

function extractArticleImages(html = "") {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/g)]
    .map((match) => absoluteUrl(match[1]))
    .filter((url) => /pbs\.twimg\.com|cdn-ak\.f\.st-hatena\.com|blog-imgs|livedoor|ameba/.test(url));
}

function extractRentalCode(text = "") {
  const match = text.match(/(?:レンタル|チーム|構築)?(?:ID|コード|Code|code)[：:\s]*([A-Z0-9]{6,})/);
  return match?.[1] || "";
}

function splitMoves(value = "") {
  return value
    .split(/[　\s]+/)
    .map((move) => move.trim())
    .filter(Boolean);
}

function extractConfigsFromText(text = "", members = []) {
  const configs = [];
  for (const member of members) {
    const escaped = member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startRe = new RegExp(`[・･]\\s*${escaped}\\s*@\\s*([^\\n　 ]+)(?:[　 ]+([^\\n]+))?`);
    const start = text.search(startRe);
    if (start < 0) continue;

    const rest = text.slice(start);
    const next = rest.slice(1).search(/\n[・･]\s*[^@\n]{2,24}\s*@/);
    const section = next > 0 ? rest.slice(0, next + 1) : rest.slice(0, 1800);
    const header = section.match(startRe);
    const moves = section.match(/技構成[：:]\s*([^\n]+)/)?.[1] || "";
    const stats = section.match(/\n(\d{2,3}\([^)]+\)[^\n]*|\d{2,3}-\d{2,3}[^\n]*)/)?.[1] || "";
    const notes = [...section.matchAll(/調整意図\s*\n([\s\S]*?)(?=\n[^・\n].{0,40}\n|$)/g)][0]?.[1] || "";

    configs.push({
      id: member.id,
      name: member.name,
      item: header?.[1] || "",
      ability: header?.[2]?.trim() || "",
      stats,
      moves: splitMoves(moves),
      notes: notes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("・"))
        .slice(0, 4),
    });
  }
  return configs;
}

function extractPokePasteConfigs(html = "") {
  const articles = [...html.matchAll(/<article>([\s\S]*?)<\/article>/g)].map((match) => match[1]);
  return articles
    .map((article) => {
      const id = Number(article.match(/\/img\/pokemon\/(\d+)-/)?.[1] || 0);
      const pre = article
        .replace(/<br\s*\/?>/g, "\n")
        .replace(/<\/span>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/\r/g, "")
        .trim();
      const lines = pre.split("\n").map((line) => line.trim()).filter(Boolean);
      const header = lines[0]?.match(/^(.+?)\s*@\s*(.+)$/);
      const ability = lines.find((line) => line.startsWith("Ability:"))?.replace("Ability:", "").trim() || "";
      const evs = lines.find((line) => line.startsWith("EVs:"))?.replace("EVs:", "").trim() || "";
      const nature = lines.find((line) => / Nature$/.test(line)) || "";
      const moves = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
      if (!id && !header) return null;
      return {
        id,
        name: header?.[1] || "",
        item: header?.[2] || "",
        ability,
        stats: [evs, nature].filter(Boolean).join(" / "),
        moves,
        notes: [],
      };
    })
    .filter(Boolean);
}

async function enrichTeam(team) {
  const apiUrl = tweetApiUrl(team.href);
  if (!apiUrl) return team;

  try {
    const tweetRes = await fetchText(apiUrl, 2);
    const tweet = JSON.parse(tweetRes).tweet;
    const articleUrl =
      tweet?.raw_text?.facets?.find((facet) => facet.type === "url")?.replacement ||
      tweet?.text?.match(/https?:\/\/\S+/)?.[0] ||
      "";
    const media = tweet?.media?.all || [];
    const enriched = {
      ...team,
      tweetText: tweet?.text || "",
      media,
      articleUrl,
      rentalCode: "",
      configurations: [],
      articleImages: [],
    };

    if (articleUrl) {
      const html = await fetchText(articleUrl, 2);
      const text = articleTextFromHtml(html);
      enriched.rentalCode = extractRentalCode(text);
      enriched.configurations = articleUrl.includes("pokepast.es")
        ? extractPokePasteConfigs(html)
        : extractConfigsFromText(text, team.members);
      enriched.articleImages = extractArticleImages(html).slice(0, 6);
    }

    return enriched;
  } catch (err) {
    return {
      ...team,
      enrichError: err.message,
    };
  }
}

function parseCards(html) {
  const chunks = html.split('<div class="card-frame card-hover">').slice(1);
  return chunks
    .map((chunk) => {
      const start = html.indexOf(chunk);
      const before = html.slice(Math.max(0, start - 260), start);
      const href = decodeEntities(before.match(/<a href="([^"]+)"/)?.[1] || "");
      const title = decodeEntities(chunk.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1] || "未命名队伍");
      const season = decodeEntities(chunk.match(/bg-sky-500 text-white"><span class="truncate">([^<]+)<\/span>/)?.[1] || "");
      const formatLabel = decodeEntities(chunk.match(/ring-1 ring-slate-200">([^<]+)<\/span>/)?.[1] || "");
      const rate = Number(chunk.match(/<span class="font-display text-base font-black[^>]*>([^<]+)<\/span>/)?.[1] || 0);
      const members = [...chunk.matchAll(/<div class="relative aspect-square rounded-lg bg-white" title="([^"]+)"><img alt="([^"]+)"[\s\S]*?src="([^"]+)"/g)]
        .map((match) => ({
          id: pokemonIdFromSprite(decodeEntities(match[3])),
          name: decodeEntities(match[1] || match[2]),
          sprite: decodeEntities(match[3]),
        }))
        .filter((member) => member.id);

      if (members.length < 3) return null;
      const team = {
        href,
        title,
        season,
        format: normalizeFormat(formatLabel),
        formatLabel: formatLabel || "Single",
        rate: rate || 0,
        members,
      };
      return { id: stableId(team), ...team };
    })
    .filter(Boolean);
}

async function main() {
  await mkdir("data", { recursive: true });
  const firstHtml = await fetchText(pageUrl(1));
  const pageCount = extractPageCount(firstHtml);
  const teams = parseCards(firstHtml);

  for (let page = 2; page <= pageCount && teams.length < TEAM_LIMIT; page += 1) {
    console.log(`Fetching team page ${page}/${pageCount}`);
    const html = await fetchText(pageUrl(page));
    teams.push(...parseCards(html));
    await sleep(REQUEST_DELAY_MS);
  }

  const unique = new Map();
  for (const team of teams) {
    if (!unique.has(team.id)) unique.set(team.id, team);
  }
  const selected = [...unique.values()].slice(0, TEAM_LIMIT);

  if (ENRICH_TEAMS) {
    for (let index = 0; index < Math.min(selected.length, DETAIL_LIMIT); index += 1) {
      console.log(`Enriching team ${index + 1}/${Math.min(selected.length, DETAIL_LIMIT)} ${selected[index].title}`);
      selected[index] = await enrichTeam(selected[index]);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const data = {
    source: BASE_URL,
    fetchedAt: new Date().toISOString(),
    total: unique.size,
    teams: selected,
  };

  await writeFile(OUT_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${data.teams.length} teams to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
