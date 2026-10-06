// Fetch the newest entries of the brainrot playlist and write them to
// _data/youtube.json. Lume reads that file at build time, so the site build
// never calls YouTube.
//
// The public playlist feed needs no credentials. It returns the playlist in
// playlist order, from the top, capped at about 15 entries. The site shows
// the first 5, so the site follows the top of the playlist.
//
// Run with: deno task refresh
// Check the feed without writing data: deno task refresh --probe

const PLAYLIST_ID = "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M";
const LIMIT = 5;
const FEED_URL =
  `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const OUT_URL = new URL("../_data/youtube.json", import.meta.url);

// YouTube returns 404 or 500 to feed requests from cloud IP ranges when the
// request looks like a script. Browser-like headers make the feed answer.
// The retries ride out a throttled or slow response.
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
  lastUpdated: string;
  fetchedAt: string;
};

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

async function fetchFeed(): Promise<Snapshot> {
  const response = await fetch(FEED_URL, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200).replaceAll("\n", " ");
    throw new Error(`feed returned ${response.status}: ${body}`);
  }
  const xml = await response.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => match[1]);
  if (entries.length === 0) {
    throw new Error("feed contains no playlist entries");
  }

  const items = entries.slice(0, LIMIT).map((entry) => ({
    id: tagText(entry, "yt:videoId"),
    title: tagText(entry, "media:title") || tagText(entry, "title"),
    author: tagText(entry, "name"),
    thumbnail: entry.match(/<media:thumbnail[^>]*\surl="([^"]*)"/)?.[1] ?? "",
  })).filter((item) => item.id !== "");

  return {
    items,
    lastUpdated: tagText(entries[0], "published"),
    fetchedAt: new Date().toISOString(),
  };
}

async function withRetry<T>(fetchOnce: () => Promise<T>): Promise<T> {
  const waits = [0, 2000, 5000];
  let lastError: unknown = new Error("the feed did not run");

  for (const wait of waits) {
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      return await fetchOnce();
    } catch (error) {
      lastError = error;
      console.error(`feed: ${(error as Error).message}`);
    }
  }
  throw lastError;
}

function writeSnapshot(snapshot: Snapshot): void {
  const path = OUT_URL.pathname;
  const temporary = `${path}.tmp`;
  Deno.writeTextFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  Deno.renameSync(temporary, path);
}

if (Deno.args.includes("--probe")) {
  try {
    const snapshot = await fetchFeed();
    console.log(`probe: feed ok, ${snapshot.items.length} item(s)`);
  } catch (error) {
    console.error(`probe: feed failed: ${(error as Error).message}`);
    Deno.exit(1);
  }
} else {
  try {
    const snapshot = await withRetry(fetchFeed);
    writeSnapshot(snapshot);
    console.log(
      `Wrote ${snapshot.items.length} item(s) to ${OUT_URL.pathname}`,
    );
  } catch (error) {
    console.error(`Refresh failed: ${(error as Error).message}`);
    console.error("The committed snapshot is unchanged.");
    Deno.exit(1);
  }
}
