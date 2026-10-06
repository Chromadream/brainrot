// Fetch the newest entries of the brainrot playlist and write them to
// _data/youtube.json. Lume reads that file at build time, so the site build
// never calls YouTube.
//
// Data sources:
//   - YouTube Data API v3, when YOUTUBE_API_KEY is set. Returns the playlist
//     in playlist order.
//   - The public playlist feed, otherwise. No credentials. Returns the 15
//     most recently added videos, newest first.
//
// Run with: deno task refresh
// Probe sources only, without writing: deno task refresh --probe

const PLAYLIST_ID = "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M";
const LIMIT = 5;
const RSS_URL =
  `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const OUT_URL = new URL("../_data/youtube.json", import.meta.url);

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
  source: "rss" | "data-api";
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

async function fetchRss(): Promise<Snapshot> {
  const response = await fetch(RSS_URL);
  if (!response.ok) {
    throw new Error(`RSS feed returned ${response.status}`);
  }
  const xml = await response.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => match[1]);
  if (entries.length === 0) {
    throw new Error("RSS feed contains no entries");
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
    source: "rss",
  };
}

async function fetchDataApi(apiKey: string): Promise<Snapshot> {
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("playlistId", PLAYLIST_ID);
  url.searchParams.set("maxResults", String(LIMIT));
  url.searchParams.set("key", apiKey);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Data API returned ${response.status} ${await response
      .text()}`);
  }
  const body = await response.json();

  const items: Item[] = (body.items ?? []).map(
    (entry: {
      snippet?: {
        title?: string;
        videoOwnerChannelTitle?: string;
        channelTitle?: string;
        thumbnails?: Record<string, { url?: string }>;
      };
      contentDetails?: { videoId?: string };
    }) => ({
      id: entry.contentDetails?.videoId ?? "",
      title: entry.snippet?.title ?? "",
      author: entry.snippet?.videoOwnerChannelTitle ??
        entry.snippet?.channelTitle ?? "",
      thumbnail: entry.snippet?.thumbnails?.medium?.url ??
        entry.snippet?.thumbnails?.default?.url ?? "",
    }),
  ).filter((item: Item) => item.id !== "");

  if (items.length === 0) {
    throw new Error("Data API returned no playlist items");
  }

  return {
    items,
    lastUpdated: body.items?.[0]?.snippet?.publishedAt ?? "",
    fetchedAt: new Date().toISOString(),
    source: "data-api",
  };
}

async function probe(apiKey: string | undefined): Promise<void> {
  let failures = 0;

  try {
    const snapshot = await fetchRss();
    console.log(`probe: rss ok, ${snapshot.items.length} item(s)`);
  } catch (error) {
    failures++;
    console.error(`probe: rss failed: ${(error as Error).message}`);
  }

  if (apiKey) {
    try {
      const snapshot = await fetchDataApi(apiKey);
      console.log(`probe: data-api ok, ${snapshot.items.length} item(s)`);
    } catch (error) {
      failures++;
      console.error(`probe: data-api failed: ${(error as Error).message}`);
    }
  } else {
    console.log("probe: data-api skipped, YOUTUBE_API_KEY is not set");
  }

  if (failures > 0) {
    Deno.exit(1);
  }
}

function writeSnapshot(snapshot: Snapshot): void {
  const path = OUT_URL.pathname;
  const temporary = `${path}.tmp`;
  Deno.writeTextFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  Deno.renameSync(temporary, path);
}

const apiKey = Deno.env.get("YOUTUBE_API_KEY");

if (Deno.args.includes("--probe")) {
  await probe(apiKey);
} else {
  try {
    const snapshot = apiKey ? await fetchDataApi(apiKey) : await fetchRss();
    writeSnapshot(snapshot);
    console.log(
      `Wrote ${snapshot.items.length} item(s) from ${snapshot.source} to ${OUT_URL.pathname}`,
    );
  } catch (error) {
    console.error(`Refresh failed: ${(error as Error).message}`);
    console.error("The committed snapshot is unchanged.");
    Deno.exit(1);
  }
}
