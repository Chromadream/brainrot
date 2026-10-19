import {
  chromium,
  type Page,
  type Request,
  type Response as BrowserResponse,
} from "playwright";

export const STORY_SIZE = { width: 1080, height: 1920 };

// Serve only the built files needed for the export and its download link.
export function serveSite(directory: URL): Deno.HttpServer<Deno.NetAddr> {
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/story/": ["story/index.html", "text/html; charset=utf-8"],
    "/story.css": ["story.css", "text/css; charset=utf-8"],
    "/story.png": ["story.png", "image/png"],
  };
  return Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const file = files[new URL(request.url).pathname];
      if (!file || !["GET", "HEAD"].includes(request.method)) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const body = await Deno.readFile(new URL(file[0], directory));
        return new Response(request.method === "HEAD" ? null : body, {
          headers: { "content-type": file[1] },
        });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return new Response("Not found", { status: 404 });
      }
    },
  );
}

export async function captureStory(
  page: Page,
  url: string,
): Promise<Uint8Array> {
  await page.setViewportSize(STORY_SIZE);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const failedAssets: string[] = [];
  const assetTypes = ["stylesheet", "image", "font"];
  const onResponse = (response: BrowserResponse) => {
    if (
      assetTypes.includes(response.request().resourceType()) &&
      response.status() >= 400
    ) {
      failedAssets.push(`${response.status()} ${response.url()}`);
    }
  };
  const onFailure = (request: Request) => {
    if (assetTypes.includes(request.resourceType())) {
      failedAssets.push(request.url());
    }
  };
  page.on("response", onResponse);
  page.on("requestfailed", onFailure);
  try {
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: 30_000,
    });
    if (!response?.ok()) {
      throw new Error(
        `Story page failed to load: ${response?.status() ?? "no response"}.`,
      );
    }

    if (failedAssets.length) {
      throw new Error(
        `Story assets failed to load: ${failedAssets.join(", ")}.`,
      );
    }
    await page.evaluate(async () => {
      const missingStyles = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      )
        .filter((link) => !link.sheet);
      if (missingStyles.length) {
        throw new Error(
          `Story stylesheet failed to load: ${missingStyles[0].href}.`,
        );
      }
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map(async (image) => {
          try {
            await image.decode();
          } catch {
            throw new Error(`Story cover failed to load: ${image.src}.`);
          }
        }),
      );

      // Keep full titles where possible. Never crop artwork or silently cut text.
      for (
        const track of document.querySelectorAll<HTMLElement>(".story-track")
      ) {
        const cover = track.parentElement!.querySelector<HTMLImageElement>(
          ".story-cover",
        )!;
        const title = track.querySelector<HTMLElement>(".story-title")!;
        const artist = track.querySelector<HTMLElement>(".story-artist")!;
        while (track.clientHeight > cover.clientHeight) {
          const titleSize = parseFloat(getComputedStyle(title).fontSize);
          const artistSize = parseFloat(getComputedStyle(artist).fontSize);
          if (titleSize <= 28 && artistSize <= 24) break;
          title.style.fontSize = `${Math.max(28, titleSize - 1)}px`;
          artist.style.fontSize = `${Math.max(24, artistSize - 1)}px`;
        }
      }

      const story = document.querySelector<HTMLElement>(".story");
      if (!story || devicePixelRatio !== 1) {
        throw new Error(
          "Story export requires a Story layout and a pixel ratio of 1.",
        );
      }
      if (story.scrollHeight > 1920 || story.scrollWidth > 1080) {
        throw new Error("Story content exceeds the 1080 x 1920 canvas.");
      }
      for (const element of story.querySelectorAll<HTMLElement>("*")) {
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        if (
          bounds.left < 64 || bounds.right > 1016 || bounds.top < 250 ||
          bounds.bottom > 1670 ||
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1
        ) {
          throw new Error(
            `Story content exceeds its safe area: ${
              element.className || element.tagName
            }.`,
          );
        }
      }
    });

    return await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      timeout: 30_000,
    });
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onFailure);
  }
}

if (import.meta.main) {
  const directory = new URL("../_site/", import.meta.url);
  const server = serveSite(directory);
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const image = await captureStory(
      page,
      `http://127.0.0.1:${server.addr.port}/story/`,
    );
    await Deno.writeFile(new URL("story.png", directory), image);
    console.log("Generated _site/story.png (1080 x 1920).");
  } finally {
    await browser?.close();
    await server.shutdown();
  }
}
