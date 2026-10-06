// Fetch the newest entries of the brainrot playlist and write them to
// _data/youtube.json. Lume reads that file at build time, so the site build
// never calls YouTube.
//
// The site shows the first 5 entries of the playlist, in playlist order.
//
// Two list sources, tried in this order. Both need no credentials.
//   1. The public playlist feed. Small and stable, but Google returns 404
//      from some GitHub runner addresses.
//   2. The playlist page. Larger, but it answers from those addresses.
//
// Either source gives the video id, title, author and a fallback thumbnail.
// The fetch then looks for the square album art on the iTunes Search API
// across several regional storefronts, which answers the GitHub runner. A
// TypeSafe Jev judgment picks the candidate that is the same recording by the
// same artist, because exact string equality misses featured artists, remixes,
// version suffixes and label channel names. Without TYPESAFE_API_KEY, the
// exact rule runs instead.
//
// If no candidate gives an image, the feed or page thumbnail stays. A missing
// image never stops the refresh.
//
// Run with: deno task refresh
// Check every source without writing data: deno task refresh --probe

const PLAYLIST_ID = "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M";
const LIMIT = 5;
const FEED_URL =
  `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const PAGE_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const OUT_URL = new URL("../_data/youtube.json", import.meta.url);

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BROWSER_HEADERS: HeadersInit = {
  "User-Agent": USER_AGENT,
  "Accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

type Item = {
  id: string;
  title: string;
  author: string;
  thumbnail: string;
  // How the thumbnail was chosen. For debugging the match.
  thumbnailSource?: string;
};

type Snapshot = {
  items: Item[];
  fetchedAt: string;
};

function thumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

// Auto-generated artist channels are named "Artist - Topic" in the feed and
// "Artist" on the page. Keep the page form, so a source change does not move
// the data file.
function cleanAuthor(name: string): string {
  return name.replace(/ - Topic$/, "");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function tagText(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`),
  );
  return match ? unescapeXml(match[1].trim()) : "";
}

async function fetchFromFeed(): Promise<Snapshot> {
  const response = await fetch(FEED_URL, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 120).replaceAll("\n", " ");
    throw new Error(`feed returned ${response.status}: ${body}`);
  }
  const xml = await response.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => match[1]);
  if (entries.length === 0) {
    throw new Error("feed contains no playlist entries");
  }

  const items = entries.slice(0, LIMIT).map((entry) => {
    const id = tagText(entry, "yt:videoId");
    return {
      id,
      title: tagText(entry, "media:title") || tagText(entry, "title"),
      author: cleanAuthor(tagText(entry, "name")),
      thumbnail: thumbnailUrl(id),
    };
  }).filter((item) => item.id !== "");

  if (items.length === 0) {
    throw new Error("feed contains no usable entries");
  }

  return { items, fetchedAt: new Date().toISOString() };
}

// The playlist page carries the playlist in a ytInitialData JSON blob, as a
// list of lockupViewModel nodes. The first 5 are the ones the site shows.
type PageLockup = {
  contentId?: string;
  contentType?: string;
  metadata?: {
    lockupMetadataViewModel?: {
      title?: { content?: string };
      metadata?: {
        contentMetadataViewModel?: {
          metadataRows?: Array<{
            metadataParts?: Array<{ text?: { content?: string } }>;
          }>;
        };
      };
    };
  };
};

// Read the balanced JSON object that starts at the first "{" after the
// marker. A plain regex cannot do this, because the object nests.
function extractJson(html: string, marker: string): unknown {
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) {
    throw new Error(`the page has no ${marker}`);
  }
  const open = html.indexOf("{", markerAt + marker.length);
  if (open < 0) {
    throw new Error(`the page has no JSON after ${marker}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(html.slice(open, index + 1));
      }
    }
  }
  throw new Error(`the JSON after ${marker} is incomplete`);
}

function collectVideoLockups(
  node: unknown,
  found: PageLockup[] = [],
): PageLockup[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectVideoLockups(child, found);
    }
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const lockup = record.lockupViewModel as PageLockup | undefined;
    if (lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      found.push(lockup);
      return found;
    }
    for (const value of Object.values(record)) {
      collectVideoLockups(value, found);
    }
  }
  return found;
}

async function fetchFromPage(): Promise<Snapshot> {
  const response = await fetch(PAGE_URL, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new Error(`playlist page returned ${response.status}`);
  }
  const html = await response.text();

  const seen = new Set<string>();
  const items: Item[] = [];

  for (
    const lockup of collectVideoLockups(extractJson(html, "ytInitialData"))
  ) {
    const id = lockup.contentId ?? "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);

    const metadata = lockup.metadata?.lockupMetadataViewModel;
    items.push({
      id,
      title: metadata?.title?.content ?? "",
      author: cleanAuthor(
        metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]
          ?.metadataParts?.[0]?.text?.content ?? "",
      ),
      thumbnail: thumbnailUrl(id),
    });

    if (items.length === LIMIT) break;
  }

  if (items.length === 0) {
    throw new Error("the playlist page has no video entries");
  }

  return { items, fetchedAt: new Date().toISOString() };
}

// The iTunes Search API is a public, key-free source of square album art. It
// answers the GitHub runner, where the YouTube Music page does not.
const ITUNES_URL = "https://itunes.apple.com/search";

const JSON_HEADERS: HeadersInit = {
  "User-Agent": USER_AGENT,
  "Accept": "application/json",
};

type ItunesTrack = {
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  artworkUrl100?: string;
};

// Compare names without case, accents or punctuation, so "NMIXX" matches
// "NMIXX" and "Heavy Serenade" matches "Heavy Serenade".
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Strip the words and bracketed groups that a video title or channel name
// carries but a music catalogue does not. This only builds the search query.
// The raw text still goes to Jev and to the exact rule.
function searchText(value: string): string {
  return value
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(?:official|vevo|lyrics?|audio|m\/v|mv)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Both the raw text and the cleaned text, so the exact rule still matches a
// title like "Love2Love (Official Video)" against the iTunes track "Love2Love".
function matchKeys(value: string): string[] {
  return [...new Set([normalize(value), normalize(searchText(value))])].filter(
    (key) => key !== "",
  );
}

function largerArtwork(url: string): string {
  return url.replace(/\/\d+x\d+bb\.jpg$/, "/600x600bb.jpg");
}

// Accept only an exact match after normalize: the artist must be equal, and
// the track or album name must be equal. This is the offline fallback for the
// Jev judgment below.
function exactMatch(
  candidates: ItunesTrack[],
  title: string,
  author: string,
): ItunesTrack | null {
  const wantedTitles = matchKeys(title);
  const wantedAuthors = matchKeys(author);

  for (const track of candidates) {
    if (!wantedAuthors.includes(normalize(track.artistName ?? ""))) continue;
    const trackName = normalize(track.trackName ?? "");
    const collectionName = normalize(track.collectionName ?? "");
    if (
      !wantedTitles.includes(trackName) &&
      !wantedTitles.includes(collectionName)
    ) {
      continue;
    }
    if (track.artworkUrl100) {
      return track;
    }
  }
  return null;
}

// The storefronts to search. The United States storefront does not carry the
// whole playlist, so the fetch asks several regional storefronts and merges
// the answers.
const ITUNES_STOREFRONTS = ["id", "au", "jp", "kr"];

// Ask iTunes for song candidates. The matcher decides which result is the
// same song.
async function itunesCandidates(
  title: string,
  author: string,
): Promise<ItunesTrack[]> {
  if (title === "" || author === "") {
    return [];
  }
  const artist = searchText(author) || author;
  const song = searchText(title) || title;

  const perStorefront = await Promise.all(
    ITUNES_STOREFRONTS.map(async (country) => {
      try {
        const url = new URL(ITUNES_URL);
        url.searchParams.set("term", `${artist} ${song}`);
        url.searchParams.set("entity", "song");
        url.searchParams.set("limit", "10");
        url.searchParams.set("country", country);

        const response = await fetch(url, { headers: JSON_HEADERS });
        if (!response.ok) {
          return [] as ItunesTrack[];
        }
        const body = await response.json() as { results?: ItunesTrack[] };
        return body.results ?? [];
      } catch {
        return [] as ItunesTrack[];
      }
    }),
  );

  // One candidate per artist and track, so the same release from several
  // storefronts does not fill the choice list.
  const seen = new Set<string>();
  const candidates: ItunesTrack[] = [];
  for (const track of perStorefront.flat()) {
    const key = `${normalize(track.artistName ?? "")}|${
      normalize(track.trackName ?? "")
    }`;
    if (key === "|" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(track);
  }
  return candidates;
}

// TypeSafe Jev. It judges which iTunes candidate is the same song, because
// exact equality misses featured artists, remixes, version suffixes and label
// channel names. See https://docs.typesafe.ai/.
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_KEY = Deno.env.get("TYPESAFE_API_KEY");
const TYPESAFE_MODEL = Deno.env.get("TYPESAFE_MODEL") ?? "jev-latest";
const MATCH_THRESHOLD = Number(
  Deno.env.get("TYPESAFE_MATCH_THRESHOLD") ?? "0.5",
);
const NONE_OPTION = "none";

const JEV_TIMEOUT_MS = 30_000;
const JEV_RETRIES = 2;

type JevChoice = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

type JevBody = {
  answers?: Record<string, JevChoice>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, response?: Response): number {
  const header = response?.headers.get("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

// One batched request for every pending item. On any failure the caller falls
// back to exactMatch.
async function askJev(
  state: unknown,
  questions: Record<string, unknown>,
): Promise<JevBody | null> {
  if (!TYPESAFE_KEY) {
    return null;
  }

  for (let attempt = 0; attempt <= JEV_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
    try {
      const response = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TYPESAFE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: TYPESAFE_MODEL, state, questions }),
        signal: controller.signal,
      });

      if (response.status === 429 || response.status === 529) {
        if (attempt < JEV_RETRIES) {
          await sleep(retryDelayMs(attempt, response));
          continue;
        }
        console.error(`typesafe: busy (${response.status}) after retries`);
        return null;
      }
      if (!response.ok) {
        console.error(`typesafe: request failed with ${response.status}`);
        return null;
      }
      return await response.json() as JevBody;
    } catch (error) {
      if (attempt < JEV_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      console.error(`typesafe: ${(error as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

type PendingItem = {
  index: number;
  title: string;
  author: string;
  candidates: ItunesTrack[];
};

// One choice question per item. The question asks which candidate is the same
// recording by the same artist, and offers "none" when no candidate fits.
async function pickWithJev(
  items: PendingItem[],
): Promise<Map<number, ItunesTrack | null> | null> {
  const state = {
    items: items.map((item) => ({
      youtube: { title: item.title, channel: item.author },
      candidates: item.candidates.map((candidate, at) => ({
        id: `c${at}`,
        artist: candidate.artistName ?? "",
        track: candidate.trackName ?? "",
        album: candidate.collectionName ?? "",
      })),
    })),
  };

  const questions: Record<string, unknown> = {};
  items.forEach((item, at) => {
    const criteria: Record<string, string> = {};
    item.candidates.forEach((candidate, index) => {
      const parts = [
        candidate.trackName ? `"${candidate.trackName}"` : "",
        candidate.artistName ? `by ${candidate.artistName}` : "",
        candidate.collectionName ? `from "${candidate.collectionName}"` : "",
      ].filter(Boolean);
      criteria[`c${index}`] = `${parts.join(", ")}.`;
    });
    criteria[NONE_OPTION] =
      "No candidate is the same song as the YouTube item.";

    questions[`item_${at}`] = {
      type: "choice",
      instructions:
        `The \`youtube\` item in \`items[${at}]\` is a video from a playlist. ` +
        `Which candidate in \`items[${at}].candidates\` is the same recording ` +
        `by the same artist as that video? The channel name can differ from ` +
        `the artist name: it can be a topic channel, a label channel, or the ` +
        `artist name with words like "Official" added. The title can carry ` +
        `extra words such as a version, edit, live or video suffix. Prefer ` +
        `the same recording, and accept another version of the same song by ` +
        `the same artist. Do not choose a cover, remix, karaoke version or ` +
        `unrelated song by a different artist. Choose \`${NONE_OPTION}\` ` +
        `when no candidate is the same recording by the same artist.`,
      criteria,
    };
  });

  const body = await askJev(state, questions);
  if (body === null) {
    return null;
  }
  if (body.usage) {
    console.log(
      `typesafe: ${body.usage.input_tokens ?? 0} in / ${
        body.usage.output_tokens ?? 0
      } out tokens`,
    );
  }

  const picked = new Map<number, ItunesTrack | null>();
  items.forEach((item, at) => {
    const answer = body.answers?.[`item_${at}`];
    if (!answer || answer.type !== "choice") {
      picked.set(item.index, null);
      return;
    }
    const probability = answer.probabilities?.[answer.choice] ?? 0;
    if (answer.choice === NONE_OPTION || probability < MATCH_THRESHOLD) {
      console.log(
        `typesafe: ${item.title} -> none (${answer.choice}, ${
          probability.toFixed(2)
        })`,
      );
      picked.set(item.index, null);
      return;
    }
    const index = Number(answer.choice.replace(/^c/, ""));
    const chosen = Number.isInteger(index) ? item.candidates[index] : undefined;
    console.log(
      `typesafe: ${item.title} -> ${chosen?.trackName ?? "?"}, ${
        probability.toFixed(2)
      } (confidence ${(answer.confidence ?? 0).toFixed(2)})`,
    );
    picked.set(item.index, chosen ?? null);
  });
  return picked;
}

// Find the square album art on iTunes. The Jev judgment picks the candidate
// when the key is set; the exact rule is the offline fallback. Keep the list
// thumbnail when no candidate fits.
async function enrichWithMusic(items: Item[]): Promise<Item[]> {
  const results = new Map<number, Item>();
  const pending: PendingItem[] = [];

  // The playlist limit is 5, so this fan-out stays small.
  await Promise.all(items.map(async (item, index) => {
    const candidates = await itunesCandidates(item.title, item.author);
    if (candidates.length === 0) {
      results.set(index, { ...item, thumbnailSource: "youtube-video" });
      return;
    }
    pending.push({ index, title: item.title, author: item.author, candidates });
  }));

  let picks: Map<number, ItunesTrack | null> | null = null;
  if (pending.length > 0) {
    if (TYPESAFE_KEY) {
      picks = await pickWithJev(pending);
    } else {
      console.log(
        "typesafe: TYPESAFE_API_KEY is not set, using the exact rule",
      );
    }
  }

  for (const item of pending) {
    const base = items[item.index];
    const candidate = picks !== null
      ? picks.get(item.index) ?? null
      : exactMatch(item.candidates, item.title, item.author);

    if (candidate?.artworkUrl100) {
      results.set(item.index, {
        ...base,
        // Prefer the catalogue artist name over the YouTube channel name.
        author: candidate.artistName?.trim() || base.author,
        thumbnail: largerArtwork(candidate.artworkUrl100),
        thumbnailSource: picks !== null ? "itunes-jev" : "itunes-exact",
      });
    } else {
      console.warn(
        `music: no album art for ${base.id}, keeping the video thumbnail`,
      );
      results.set(item.index, { ...base, thumbnailSource: "youtube-video" });
    }
  }

  return items.map((item, index) => results.get(index) ?? item);
}

const SOURCES: Array<{ name: string; run: () => Promise<Snapshot> }> = [
  { name: "feed", run: fetchFromFeed },
  { name: "playlist page", run: fetchFromPage },
];

// Print the answer from every source, so a blocked runner shows which route
// still works.
async function probe(): Promise<void> {
  let answered = 0;
  let sample: Item[] = [];

  for (const source of SOURCES) {
    try {
      const snapshot = await source.run();
      console.log(`probe ${source.name}: ok, ${snapshot.items.length} item(s)`);
      answered++;
      if (sample.length === 0) {
        sample = snapshot.items.slice(0, LIMIT);
      }
    } catch (error) {
      console.error(`probe ${source.name}: ${(error as Error).message}`);
    }
  }

  const pending: PendingItem[] = [];
  for (const [index, item] of sample.entries()) {
    const candidates = await itunesCandidates(item.title, item.author);
    console.log(
      `probe itunes: ${item.title} -> ${candidates.length} candidate(s)`,
    );
    if (candidates.length > 0) {
      pending.push({
        index,
        title: item.title,
        author: item.author,
        candidates,
      });
    }
  }

  if (pending.length > 0) {
    if (TYPESAFE_KEY) {
      await pickWithJev(pending);
    } else {
      console.log("probe typesafe: skipped, TYPESAFE_API_KEY is not set");
      for (const item of pending) {
        const exact = exactMatch(item.candidates, item.title, item.author);
        console.log(
          `probe exact: ${item.title} -> ${exact?.trackName ?? "no match"}`,
        );
      }
    }
  }

  if (answered === 0) {
    Deno.exit(1);
  }
}

function writeSnapshot(snapshot: Snapshot): void {
  const path = OUT_URL.pathname;
  const temporary = `${path}.tmp`;
  Deno.writeTextFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  Deno.renameSync(temporary, path);
}

if (Deno.args.includes("--probe")) {
  await probe();
} else {
  let failed = true;

  for (const source of SOURCES) {
    try {
      const snapshot = await source.run();
      const enriched: Snapshot = {
        ...snapshot,
        items: await enrichWithMusic(snapshot.items),
      };
      writeSnapshot(enriched);
      console.log(
        `Wrote ${enriched.items.length} item(s) from the ${source.name} to ${OUT_URL.pathname}`,
      );
      failed = false;
      break;
    } catch (error) {
      console.error(`${source.name}: ${(error as Error).message}`);
    }
  }

  if (failed) {
    console.error("Refresh failed. The committed snapshot is unchanged.");
    Deno.exit(1);
  }
}
