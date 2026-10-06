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
const FEED_PATH = `feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const OUT_URL = new URL("../_data/youtube.json", import.meta.url);

const BROWSER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BROWSER_HEADERS: HeadersInit = {
  "User-Agent": BROWSER_AGENT,
  "Accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

type FeedShape = {
  name: string;
  url: string;
  headers: HeadersInit;
};

// YouTube answers the feed on GitHub runners for some request shapes and
// returns 404 for others. The shapes are ordered by how well they worked in
// the runner log. The refresh tries each shape in turn.
const FEED_SHAPES: FeedShape[] = [
  {
    name: "browser",
    url: `https://www.youtube.com/${FEED_PATH}`,
    headers: BROWSER_HEADERS,
  },
  {
    name: "mobile",
    url: `https://m.youtube.com/${FEED_PATH}`,
    headers: BROWSER_HEADERS,
  },
  {
    name: "consent",
    url: `https://www.youtube.com/${FEED_PATH}`,
    headers: {
      ...BROWSER_HEADERS,
      "Cookie": "CONSENT=YES+cb.20240101-00-p0.en+FX+410",
    },
  },
  {
    name: "agent-only",
    url: `https://www.youtube.com/${FEED_PATH}`,
    headers: { "User-Agent": BROWSER_AGENT },
  },
  {
    name: "no-www",
    url: `https://youtube.com/${FEED_PATH}`,
    headers: BROWSER_HEADERS,
  },
  {
    name: "star-accept",
    url: `https://www.youtube.com/${FEED_PATH}`,
    headers: { "User-Agent": BROWSER_AGENT, "Accept": "*/*" },
  },
];

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

async function fetchFeed(shape: FeedShape): Promise<Snapshot> {
  const response = await fetch(shape.url, { headers: shape.headers });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200).replaceAll("\n", " ");
    throw new Error(`returned ${response.status}: ${body}`);
  }
  const xml = await response.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => match[1]);
  if (entries.length === 0) {
    throw new Error("contains no playlist entries");
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

// Walk the shapes in order. Wait and repeat the walk, for a throttle that
// lifts in a few seconds.
async function refreshFromFeed(): Promise<Snapshot> {
  const waits = [0, 2000, 5000];
  let lastError: unknown = new Error("the feed did not run");

  for (const wait of waits) {
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    for (const shape of FEED_SHAPES) {
      try {
        const snapshot = await fetchFeed(shape);
        if (shape.name !== FEED_SHAPES[0].name) {
          console.log(`feed: the "${shape.name}" shape worked`);
        }
        return snapshot;
      } catch (error) {
        lastError = error;
        console.error(`feed ${shape.name}: ${(error as Error).message}`);
      }
    }
  }
  throw lastError;
}

// Print the answer from every request shape, plus the playlist page, so a
// failing runner shows which routes still answer.
async function probe(): Promise<void> {
  let answered = 0;

  for (const shape of FEED_SHAPES) {
    try {
      const snapshot = await fetchFeed(shape);
      console.log(`probe ${shape.name}: ok, ${snapshot.items.length} item(s)`);
      answered++;
    } catch (error) {
      console.error(`probe ${shape.name}: ${(error as Error).message}`);
    }
  }

  try {
    const response = await fetch(
      `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`,
      { headers: BROWSER_HEADERS },
    );
    const html = await response.text();
    const ids = new Set(
      [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]),
    );
    console.log(
      `probe playlist page: ${response.status}, ${ids.size} video id(s)`,
    );
  } catch (error) {
    console.error(`probe playlist page: ${(error as Error).message}`);
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
  try {
    const snapshot = await refreshFromFeed();
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
