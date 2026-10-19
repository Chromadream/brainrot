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
// across several regional storefronts, which answers the GitHub runner.
//
// The match runs in two stages.
//   1. Text. One TypeSafe Jev yes/no question per candidate: is it the same
//      song by the same artist? Every candidate above TYPESAFE_MATCH_THRESHOLD
//      stays. A single-choice question cannot do this, because it returns one
//      release and drops the other releases of the same song, which is where
//      the different cover arts live.
//   2. Cover art. One choice question per group of candidates. The options are
//      the candidate cover images, and the reference is the video thumbnail,
//      which shows the cover that YouTube displays. Jev picks the artwork that
//      matches.
//
// Without TYPESAFE_API_KEY, the exact rule runs instead. TYPESAFE_IMAGE_MATCH=0
// skips stage 2. If stage 2 finds no matching cover, the feed or page thumbnail
// stays. A missing image never stops the refresh.
//
// Env vars:
//   TYPESAFE_API_KEY           API key. The text stage needs it.
//   TYPESAFE_MODEL             Model name. Default jev-latest.
//   TYPESAFE_MATCH_THRESHOLD   Text stage threshold. Default 0.5.
//   TYPESAFE_COVER_THRESHOLD   Cover stage threshold. Default 0.5.
//   TYPESAFE_IMAGE_MATCH       Set to 0 or false to skip the cover stage.
//
// Image input is a TypeSafe "Dreamer-ready" feature: the request format and the
// accuracy can change between releases. The image flag and the fallbacks keep a
// change from breaking the refresh.
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
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/600x600bb.$1");
}

// Accept only an exact match after normalize: the artist must be equal, and
// the track or album name must be equal. This is the offline fallback for the
// Jev judgment below. Return every match, not just the first, so the caller
// still sees all the releases of the same song.
function exactMatches(
  candidates: ItunesTrack[],
  title: string,
  author: string,
): ItunesTrack[] {
  const wantedTitles = matchKeys(title);
  const wantedAuthors = matchKeys(author);

  return candidates.filter((track) => {
    if (!wantedAuthors.includes(normalize(track.artistName ?? ""))) {
      return false;
    }
    const trackName = normalize(track.trackName ?? "");
    const collectionName = normalize(track.collectionName ?? "");
    return wantedTitles.includes(trackName) ||
      wantedTitles.includes(collectionName);
  });
}

// The storefronts to search. The United States storefront does not carry the
// whole playlist, so the fetch asks several regional storefronts and merges
// the answers. The Korean storefront answers with no results, so it is not in
// the list.
const ITUNES_STOREFRONTS = ["id", "au", "jp"];

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

  // One candidate per artist, track and cover, so the same release from
  // several storefronts does not fill the choice list, but a different release
  // of the same song with a different cover stays. The cover stage needs those
  // releases: they are where the different cover arts live.
  const seen = new Set<string>();
  const candidates: ItunesTrack[] = [];
  for (const track of perStorefront.flat()) {
    const artist = normalize(track.artistName ?? "");
    const name = normalize(track.trackName ?? "");
    if (artist === "" && name === "") {
      continue;
    }
    const key = `${artist}|${name}|${track.artworkUrl100 ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(track);
  }
  return candidates;
}

// TypeSafe Jev. It judges whether two releases are the same song, then which
// cover art matches the video thumbnail. See https://docs.typesafe.ai/.
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_KEY = Deno.env.get("TYPESAFE_API_KEY");
const TYPESAFE_MODEL = Deno.env.get("TYPESAFE_MODEL") ?? "jev-latest";
const MATCH_THRESHOLD = Number(
  Deno.env.get("TYPESAFE_MATCH_THRESHOLD") ?? "0.5",
);
const COVER_THRESHOLD = Number(
  Deno.env.get("TYPESAFE_COVER_THRESHOLD") ?? "0.5",
);
const IMAGE_MATCH = (() => {
  const value = (Deno.env.get("TYPESAFE_IMAGE_MATCH") ?? "1").toLowerCase();
  return value !== "0" && value !== "false";
})();
const NONE_OPTION = "none";

// A choice question with more images than this can crowd the per-question
// context. The reference image is sent once per group, and each cover is sent
// once in total.
const COVER_BATCH = 10;
const REFERENCE_SIZES = ["maxresdefault", "sddefault", "hqdefault"];

// YouTube serves a small placeholder for a missing size. A real thumbnail is
// much larger, so a size check drops the placeholder before Jev rejects it.
const MIN_IMAGE_BYTES = 5_000;

const JEV_TIMEOUT_MS = 30_000;
const JEV_RETRIES = 2;

type JevAnswer = {
  type: "choice" | "noul";
  choice?: string;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

type JevBody = {
  answers?: Record<string, JevAnswer>;
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

// Send a request. The caller builds the body, so a retry rebuilds the form and
// its blobs instead of reusing a consumed body. Images need their own header;
// multipart sets its own content type.
async function askJev(
  makeBody: () => BodyInit,
  images = false,
): Promise<JevBody | null> {
  if (!TYPESAFE_KEY) {
    return null;
  }

  for (let attempt = 0; attempt <= JEV_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${TYPESAFE_KEY}`,
      };
      if (images) {
        headers["TypeSafe-Danger-Zone-Images"] = "true";
      } else {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers,
        body: makeBody(),
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
        const detail = (await response.text()).slice(0, 200).replaceAll(
          "\n",
          " ",
        );
        console.error(
          `typesafe: request failed with ${response.status}${
            detail ? `: ${detail}` : ""
          }`,
        );
        return null;
      }

      const body = await response.json() as JevBody;
      if (body.usage) {
        console.log(
          `typesafe: ${body.usage.input_tokens ?? 0} in / ${
            body.usage.output_tokens ?? 0
          } out tokens${images ? " (images)" : ""}`,
        );
      }
      return body;
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

// Stage 1. One yes/no question per candidate, in one batched request. Every
// candidate above the threshold stays, so the cover stage can compare all the
// releases of the same song. A single choice question would return one release
// and drop the others, which is how the wrong cover gets picked.
async function shortlistWithJev(
  items: PendingItem[],
): Promise<Map<number, number[]> | null> {
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
    item.candidates.forEach((_, index) => {
      questions[`item_${at}_c${index}`] = {
        type: "noul",
        instructions:
          `Is \`items[${at}].candidates[${index}]\` the same song by the same ` +
          `artist as the video in \`items[${at}].youtube\`? The channel name ` +
          `can differ from the artist name: it can be a topic channel, a label ` +
          `channel, or the artist name with words like "Official" added. The ` +
          `title can carry extra words such as a version, edit, live or video ` +
          `suffix. Accept another release or version of the same song by the ` +
          `same artist. Do not accept a cover, remix or karaoke version, or a ` +
          `song by a different artist.`,
      };
    });
  });

  const body = await askJev(() =>
    JSON.stringify({ model: TYPESAFE_MODEL, state, questions })
  );
  if (body === null) {
    return null;
  }

  const shortlisted = new Map<number, number[]>();
  items.forEach((item, at) => {
    const scored = item.candidates.map((candidate, index) => {
      const answer = body.answers?.[`item_${at}_c${index}`];
      const value = answer?.type === "noul" ? answer.noul ?? 0 : 0;
      return { index, value, candidate };
    }).filter((entry) => entry.value >= MATCH_THRESHOLD)
      .sort((left, right) =>
        right.value - left.value || left.index - right.index
      );

    if (scored.length === 0) {
      console.log(
        `typesafe: ${item.title} -> no candidate above ${MATCH_THRESHOLD}`,
      );
    } else {
      console.log(
        `typesafe: ${item.title} -> ${scored.length}/${item.candidates.length} candidate(s), top ${
          scored[0].candidate.trackName ?? "?"
        } (${scored[0].value.toFixed(2)})`,
      );
    }
    shortlisted.set(item.index, scored.map((entry) => entry.index));
  });
  return shortlisted;
}

type ImageFormat = "jpg" | "png";

type ImageFile = {
  bytes: Uint8Array;
  format: ImageFormat;
};

type ReferenceImage = ImageFile & { source: string };

const imageCache = new Map<string, Promise<ImageFile | null>>();

// Fetch one image. Jev rejects a missing, tiny or non-JPEG/PNG image and fails
// the whole request, so filter here first. The size check also drops the small
// placeholder that YouTube returns for a missing maxresdefault.
async function fetchImage(url: string): Promise<ImageFile | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      return null;
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const format: ImageFormat | null = type.includes("png")
      ? "png"
      : type.includes("jpeg") || type.includes("jpg")
      ? "jpg"
      : null;
    if (format === null) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < MIN_IMAGE_BYTES) {
      return null;
    }
    return { bytes, format };
  } catch (error) {
    console.warn(`cover: ${url} failed: ${(error as Error).message}`);
    return null;
  }
}

function fetchImageCached(url: string): Promise<ImageFile | null> {
  const cached = imageCache.get(url);
  if (cached) {
    return cached;
  }
  const pending = fetchImage(url);
  imageCache.set(url, pending);
  return pending;
}

const referenceCache = new Map<string, Promise<ReferenceImage | null>>();

// The video thumbnail is the reference cover. Prefer the largest size that
// answers; a small playlist entry may have no maxresdefault.
function fetchReferenceImage(id: string): Promise<ReferenceImage | null> {
  const cached = referenceCache.get(id);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    for (const source of REFERENCE_SIZES) {
      const image = await fetchImageCached(
        `https://i.ytimg.com/vi/${id}/${source}.jpg`,
      );
      if (image) {
        return { ...image, source };
      }
    }
    return null;
  })();
  referenceCache.set(id, pending);
  return pending;
}

type CoverEntry = {
  at: number;
  track: ItunesTrack;
  image: ImageFile;
};

type CoverResult =
  | { status: "matched"; track: ItunesTrack; probability: number }
  | { status: "no-match" }
  | { status: "unavailable" };

// One choice question over the cover images in a group. The option name maps
// back to the candidate; the option value is the image reference.
async function askCoverChoice(
  reference: ReferenceImage,
  chunk: CoverEntry[],
): Promise<{ at: number; probability: number } | null> {
  const REFERENCE_KEY = "img_ref";

  const buildForm = (): FormData => {
    const assets: Record<string, { type: "image"; part: string }> = {
      [REFERENCE_KEY]: { type: "image", part: REFERENCE_KEY },
    };
    const criteria: Record<string, string> = {};

    chunk.forEach((_, at) => {
      const key = `img_c${at}`;
      assets[key] = { type: "image", part: key };
      criteria[`c${at}`] = key;
    });
    criteria[NONE_OPTION] =
      "No option shows the same cover artwork as `cover`.";

    const body = {
      model: TYPESAFE_MODEL,
      state: { cover: REFERENCE_KEY },
      assets,
      questions: {
        same_cover: {
          type: "choice",
          instructions:
            "Which option shows the same cover artwork as the picture in " +
            "`cover`? The picture in `cover` is a video thumbnail, so it can " +
            "show a square cover inside a wider frame. Compare the artwork " +
            "itself, not the artist name or any text.",
          criteria,
        },
      },
    };

    // The API expects the JSON body as the first multipart part.
    const form = new FormData();
    form.set(
      "request",
      new Blob([JSON.stringify(body)], { type: "application/json" }),
    );
    form.set(
      REFERENCE_KEY,
      new Blob([reference.bytes], {
        type: `image/${reference.format}`,
      }),
      `reference.${reference.format}`,
    );
    chunk.forEach((entry, at) => {
      const key = `img_c${at}`;
      form.set(
        key,
        new Blob([entry.image.bytes], {
          type: `image/${entry.image.format}`,
        }),
        `cover-${at}.${entry.image.format}`,
      );
    });
    return form;
  };

  const response = await askJev(buildForm, true);
  const answer = response?.answers?.same_cover;
  if (!answer || answer.type !== "choice" || !answer.choice) {
    return null;
  }

  const probability = answer.probabilities?.[answer.choice] ?? 0;
  if (answer.choice === NONE_OPTION) {
    return { at: -1, probability };
  }

  const at = Number(answer.choice.replace(/^c/, ""));
  if (!Number.isInteger(at) || at < 0 || at >= chunk.length) {
    return null;
  }
  return { at, probability };
}

// Stage 2. Compare each shortlisted candidate cover with the video thumbnail.
// On no match the caller keeps the video thumbnail. On an error the caller uses
// the top text match instead, which is the old behaviour.
async function matchCoverWithJev(
  item: Item,
  shortlist: number[],
  candidates: ItunesTrack[],
): Promise<CoverResult> {
  const reference = await fetchReferenceImage(item.id);
  if (reference === null) {
    console.warn(`cover: no reference thumbnail for ${item.id}`);
    return { status: "unavailable" };
  }

  const entries = (await Promise.all(
    shortlist.map(async (at) => {
      const track = candidates[at];
      if (!track.artworkUrl100) {
        return null;
      }
      const image = await fetchImageCached(largerArtwork(track.artworkUrl100));
      return image === null ? null : { at, track, image };
    }),
  )).filter((entry): entry is CoverEntry => entry !== null);

  if (entries.length === 0) {
    return { status: "unavailable" };
  }

  console.log(
    `cover: ${item.title} reference ${reference.source}, ${entries.length} cover(s)`,
  );

  let best: { track: ItunesTrack; probability: number } | null = null;
  let answered = false;

  for (let start = 0; start < entries.length; start += COVER_BATCH) {
    const chunk = entries.slice(start, start + COVER_BATCH);
    const pick = await askCoverChoice(reference, chunk);
    if (pick === null) {
      continue;
    }
    answered = true;

    if (pick.at < 0) {
      console.log(
        `cover: ${item.title} -> none (${pick.probability.toFixed(2)})`,
      );
      continue;
    }

    const chosen = chunk[pick.at];
    console.log(
      `cover: ${item.title} -> ${chosen.track.collectionName ?? "?"} (${
        pick.probability.toFixed(2)
      })`,
    );
    if (
      pick.probability >= COVER_THRESHOLD &&
      (best === null || pick.probability > best.probability)
    ) {
      best = { track: chosen.track, probability: pick.probability };
    }
  }

  if (best !== null) {
    return {
      status: "matched",
      track: best.track,
      probability: best.probability,
    };
  }
  return answered ? { status: "no-match" } : { status: "unavailable" };
}

// Find the square album art on iTunes. Stage 1 keeps the releases that are the
// same song; stage 2 picks the release whose cover matches the video thumbnail.
// Keep the video thumbnail when no cover matches. When the cover stage cannot
// run, keep the top text match, which is the old behaviour.
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

  let shortlists: Map<number, number[]> | null = null;
  if (pending.length > 0) {
    if (TYPESAFE_KEY) {
      shortlists = await shortlistWithJev(pending);
    } else {
      console.log(
        "typesafe: TYPESAFE_API_KEY is not set, using the exact rule",
      );
    }
  }

  await Promise.all(pending.map(async (item) => {
    const base = items[item.index];
    const shortlist = shortlists === null
      ? exactMatches(item.candidates, item.title, item.author)
        .map((track) => item.candidates.indexOf(track))
        .filter((at) => at >= 0)
      : shortlists.get(item.index) ?? [];

    if (shortlist.length === 0) {
      console.warn(
        `music: no candidate for ${base.id}, keeping the video thumbnail`,
      );
      results.set(item.index, { ...base, thumbnailSource: "youtube-video" });
      return;
    }

    const cover = TYPESAFE_KEY && IMAGE_MATCH
      ? await matchCoverWithJev(base, shortlist, item.candidates)
      : { status: "unavailable" as const };

    if (cover.status === "matched") {
      const artwork = cover.track.artworkUrl100;
      if (artwork) {
        results.set(item.index, {
          ...base,
          // Prefer the catalogue artist name over the YouTube channel name.
          author: cover.track.artistName?.trim() || base.author,
          thumbnail: largerArtwork(artwork),
          thumbnailSource: "itunes-cover",
        });
        return;
      }
    }

    if (cover.status === "no-match") {
      console.warn(
        `music: no cover matches ${base.id}, keeping the video thumbnail`,
      );
      results.set(item.index, { ...base, thumbnailSource: "youtube-video" });
      return;
    }

    // The cover stage did not run or did not answer. Use the top text match
    // that has artwork.
    const top = shortlist.map((at) => item.candidates[at]).find((candidate) =>
      Boolean(candidate.artworkUrl100)
    );
    if (top?.artworkUrl100) {
      results.set(item.index, {
        ...base,
        author: top.artistName?.trim() || base.author,
        thumbnail: largerArtwork(top.artworkUrl100),
        thumbnailSource: shortlists === null ? "itunes-exact" : "itunes-jev",
      });
    } else {
      console.warn(
        `music: no album art for ${base.id}, keeping the video thumbnail`,
      );
      results.set(item.index, { ...base, thumbnailSource: "youtube-video" });
    }
  }));

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

  if (sample.length > 0) {
    for (const item of sample) {
      const reference = await fetchReferenceImage(item.id);
      console.log(
        reference === null
          ? `probe reference: ${item.id} -> none`
          : `probe reference: ${item.id} -> ${reference.source} (${reference.bytes.length} bytes)`,
      );
    }

    if (TYPESAFE_KEY) {
      const enriched = await enrichWithMusic(sample);
      for (const item of enriched) {
        console.log(
          `probe cover: ${item.title} -> ${item.thumbnailSource}`,
        );
      }
    } else {
      console.log("probe typesafe: skipped, TYPESAFE_API_KEY is not set");
      for (const item of sample) {
        const candidates = await itunesCandidates(item.title, item.author);
        const exact = exactMatches(candidates, item.title, item.author);
        console.log(
          `probe exact: ${item.title} -> ${exact[0]?.trackName ?? "no match"}`,
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
