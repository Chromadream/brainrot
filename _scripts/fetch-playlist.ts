// Fetch the newest entries of the brainrot playlist and write them to
// _data/youtube.json. Lume reads that file at build time, so the site build
// never calls YouTube.
//
// The site shows the first 5 entries of the playlist, in playlist order.
//
// Two sources, tried in this order. Both need no credentials.
//   1. The public playlist feed. Small and stable, but Google returns 404
//      from some GitHub runner addresses.
//   2. The playlist page. Larger, but it answers from those addresses.
//
// Run with: deno task refresh
// Check both sources without writing data: deno task refresh --probe

const PLAYLIST_ID = "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M";
const LIMIT = 5;
const FEED_URL =
  `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const PAGE_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const OUT_URL = new URL("../_data/youtube.json", import.meta.url);

const BROWSER_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

type Item = {
  id: string;
  title: string;
  author: string;
  thumbnail: string;
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

const SOURCES: Array<{ name: string; run: () => Promise<Snapshot> }> = [
  { name: "feed", run: fetchFromFeed },
  { name: "playlist page", run: fetchFromPage },
];

// Print the answer from every source, so a blocked runner shows which route
// still works.
async function probe(): Promise<void> {
  let answered = 0;

  for (const source of SOURCES) {
    try {
      const snapshot = await source.run();
      console.log(`probe ${source.name}: ok, ${snapshot.items.length} item(s)`);
      answered++;
    } catch (error) {
      console.error(`probe ${source.name}: ${(error as Error).message}`);
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
      writeSnapshot(snapshot);
      console.log(
        `Wrote ${snapshot.items.length} item(s) from the ${source.name} to ${OUT_URL.pathname}`,
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
