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
// Probe the sources without writing data: deno task refresh --probe

const PLAYLIST_ID = "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M";
const LIMIT = 5;
const FEED_URL =
  `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const OUT_URL = new URL("../_data/youtube.json", import.meta.url);

// YouTube returns 500 to some requests from cloud IP ranges. A browser-like
// set of headers makes the feed answer, and the retries ride out the rest.
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

async function fetchFeed(
  url: string,
  headers: HeadersInit = BROWSER_HEADERS,
): Promise<Snapshot> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200).replaceAll("\n", " ");
    throw new Error(`${url} returned ${response.status}: ${body}`);
  }
  const xml = await response.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => match[1]);
  if (entries.length === 0) {
    throw new Error(`${url} contains no playlist entries`);
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
    const body = (await response.text()).slice(0, 200).replaceAll("\n", " ");
    throw new Error(`Data API returned ${response.status}: ${body}`);
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

async function withRetry<T>(
  label: string,
  fetchOnce: () => Promise<T>,
): Promise<T> {
  const waits = [0, 2000, 5000];
  let lastError: unknown = new Error(`${label} did not run`);

  for (const wait of waits) {
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      return await fetchOnce();
    } catch (error) {
      lastError = error;
      console.error(`${label}: ${(error as Error).message}`);
    }
  }
  throw lastError;
}

// Print the status of each way to reach the playlist. A CI runner can get a
// different answer than a workstation, so this runs in CI too.
async function probe(apiKey: string | undefined): Promise<void> {
  const attempts: Array<{ name: string; run: () => Promise<Snapshot> }> = [
    {
      name: "feed, no headers",
      run: () => fetchFeed(FEED_URL, {}),
    },
    { name: "feed, browser headers", run: () => fetchFeed(FEED_URL) },
    {
      name: "feed, no www",
      run: () => fetchFeed(FEED_URL.replace("://www.", "://")),
    },
    {
      name: "feed, consent cookie",
      run: () =>
        fetchFeed(FEED_URL, {
          ...BROWSER_HEADERS,
          Cookie: "CONSENT=YES+cb.20240101-00-p0.en+FX+410",
        }),
    },
  ];

  if (apiKey) {
    attempts.push({
      name: "data api",
      run: () => fetchDataApi(apiKey),
    });
  }

  let failures = 0;
  for (const attempt of attempts) {
    try {
      const snapshot = await attempt.run();
      console.log(
        `probe ${attempt.name}: ok, ${snapshot.items.length} item(s)`,
      );
    } catch (error) {
      failures++;
      console.error(`probe ${attempt.name}: ${(error as Error).message}`);
    }
  }

  if (!apiKey) {
    console.log("probe data api: skipped, YOUTUBE_API_KEY is not set");
  }

  if (failures === attempts.length) {
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
  const sources: Array<{ name: string; run: () => Promise<Snapshot> }> = [];
  if (apiKey) {
    sources.push({ name: "data api", run: () => fetchDataApi(apiKey) });
  }
  sources.push({ name: "feed", run: () => fetchFeed(FEED_URL) });

  let written = false;
  for (const source of sources) {
    try {
      const snapshot = await withRetry(source.name, source.run);
      writeSnapshot(snapshot);
      console.log(
        `Wrote ${snapshot.items.length} item(s) from ${snapshot.source} to ${OUT_URL.pathname}`,
      );
      written = true;
      break;
    } catch (error) {
      console.error(`${source.name} failed: ${(error as Error).message}`);
    }
  }

  if (!written) {
    console.error("Refresh failed. The committed snapshot is unchanged.");
    Deno.exit(1);
  }
}
