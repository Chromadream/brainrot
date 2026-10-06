// Temporary: find which non-innertube source gives the YouTube Music artist
// and square album art from a GitHub runner. Delete after the answer is known.

const ID = "hGqYdubpcCM";
const TITLE = "Heavy Serenade";
const AUTHOR = "NMIXX";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BASE: Record<string, string> = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const BROWSER: Record<string, string> = {
  ...BASE,
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const CONSENT =
  "CONSENT=YES+cb.20210328-17-p0.en+FX+678; SOCS=CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY";

function og(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const match of html.matchAll(/<meta\s+([^>]*?)\/?>/g)) {
    const property = match[1].match(/(?:property|name)="(og:[^"]+)"/)?.[1];
    const content = match[1].match(/content="([^"]*)"/)?.[1];
    if (property && content !== undefined) tags[property] = content;
  }
  return tags;
}

async function probe(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const response = await fetch(url, { headers });
    const body = await response.text();
    const tags = og(body);
    console.log(`--- ${label}`);
    console.log(
      `status=${response.status} final=${response.url} type=${
        response.headers.get("content-type")
      } len=${body.length}`,
    );
    console.log(
      `og=${JSON.stringify(tags).slice(0, 500)}`,
    );
    console.log(`head=${body.slice(0, 300).replaceAll(/\s+/g, " ")}`);
  } catch (error) {
    console.log(`--- ${label} ERROR ${(error as Error).message}`);
  }
}

console.log(`runner ip check:`);
await probe(
  "ip",
  "https://api.ipify.org?format=json",
  { Accept: "application/json" },
);

await probe("music plain", `https://music.youtube.com/watch?v=${ID}`, BASE);
await probe(
  "music browser",
  `https://music.youtube.com/watch?v=${ID}`,
  BROWSER,
);
await probe("music consent", `https://music.youtube.com/watch?v=${ID}`, {
  ...BASE,
  Cookie: CONSENT,
});
await probe(
  "music browser+consent",
  `https://music.youtube.com/watch?v=${ID}`,
  {
    ...BROWSER,
    Cookie: CONSENT,
  },
);
await probe(
  "music hl+persist",
  `https://music.youtube.com/watch?v=${ID}&hl=en&persist_hl=1`,
  BROWSER,
);
await probe("www watch", `https://www.youtube.com/watch?v=${ID}`, BROWSER);
await probe(
  "www oembed",
  `https://www.youtube.com/oembed?url=https%3A//www.youtube.com/watch%3Fv%3D${ID}&format=json`,
  { Accept: "application/json" },
);
await probe(
  "itunes",
  `https://itunes.apple.com/search?term=${
    encodeURIComponent(`${AUTHOR} ${TITLE}`)
  }&entity=song&limit=3`,
  { Accept: "application/json" },
);
await probe(
  "deezer",
  `https://api.deezer.com/search?q=${
    encodeURIComponent(`artist:"${AUTHOR}" track:"${TITLE}"`)
  }`,
  { Accept: "application/json" },
);
