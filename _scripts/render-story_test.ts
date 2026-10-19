import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { captureStory, serveSite } from "./render-story.ts";

const root = new URL("../", import.meta.url);

function thumbnail(width = 600, height = 600): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#385e70"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function assertPng(image: Uint8Array) {
  assert.deepEqual(Array.from(image.slice(0, 8)), [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
  ]);
  const header = new DataView(image.buffer, image.byteOffset, image.byteLength);
  assert.equal(header.getUint32(16), 1080);
  assert.equal(header.getUint32(20), 1920);
}

Deno.test("Story export uses the built templates", async (t) => {
  const temp = await Deno.makeTempDir({ prefix: "brainrot-story-" });
  const source = `${temp}/src`;
  const output = new URL(`file://${temp}/out/`);
  const browser = await chromium.launch();
  try {
    await Deno.mkdir(`${source}/_data`, { recursive: true });
    await Deno.mkdir(`${source}/_includes`);
    for (
      const file of [
        "index.vto",
        "story.vto",
        "story.css",
        "_includes/head.vto",
        "_includes/layout.vto",
        "_includes/story-layout.vto",
      ]
    ) {
      await Deno.copyFile(new URL(file, root), `${source}/${file}`);
    }

    // Use the real shared CSS, but fetch it only once for all fixture captures.
    const styles = new Map<string, string>();
    for (
      const url of [
        "https://unpkg.com/normalize.css@8.0.1/normalize.css",
        "https://unpkg.com/concrete.css@2.1.1/concrete.css",
      ]
    ) {
      const response = await fetch(url);
      assert.equal(response.ok, true, `Failed to fetch ${url}`);
      styles.set(url, await response.text());
    }
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.route("https://unpkg.com/**", async (route) => {
      const body = styles.get(route.request().url());
      assert.notEqual(body, undefined);
      await route.fulfill({ contentType: "text/css", body });
    });

    const build = async (count: number, title = "Track", author = "Artist") => {
      await Deno.writeTextFile(
        `${source}/_data/youtube.json`,
        JSON.stringify({
          items: Array.from({ length: count }, (_, index) => ({
            id: `video-${index + 1}`,
            title: `${title} ${index + 1}`,
            author,
            thumbnail: index === 1 ? thumbnail(640, 360) : thumbnail(),
          })),
          fetchedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const result = await new Deno.Command(Deno.execPath(), {
        cwd: source,
        args: [
          "run",
          "-A",
          "--config",
          new URL("deno.json", root).pathname,
          import.meta.resolve("lume/cli.ts"),
          "--config",
          new URL("_config.ts", root).pathname,
          "--src",
          ".",
          "--dest",
          "../out",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    };

    for (let count = 0; count <= 5; count++) {
      await t.step(
        `${count} entries preserve order and select at most three`,
        async () => {
          await build(count);
          const server = serveSite(output);
          const base = `http://127.0.0.1:${server.addr.port}`;
          try {
            const png = await captureStory(page, `${base}/story/`);
            assertPng(png);
            const theme = await page.evaluate(() => ({
              dark: matchMedia("(prefers-color-scheme: dark)").matches,
              background: getComputedStyle(document.body).backgroundColor,
              foreground: getComputedStyle(document.body).color,
            }));
            assert.deepEqual(theme, {
              dark: true,
              background: "rgb(17, 17, 17)",
              foreground: "rgb(255, 255, 255)",
            });
            const ids = await page.locator(".story-item").evaluateAll((items) =>
              items.map((item) => item.getAttribute("data-video-id"))
            );
            assert.deepEqual(
              ids,
              Array.from(
                { length: Math.min(count, 3) },
                (_, index) => `video-${index + 1}`,
              ),
            );
            assert.equal(
              await page.locator(".story-empty").count(),
              count === 0 ? 1 : 0,
            );
            assert.deepEqual(
              await page.locator(".story-rank").allTextContents(),
              ids.map((_, index) => `${index + 1}`),
            );
            assert.equal(
              await page.locator(".story-footer").innerText(),
              "Updated 1 Jan 2026, 11:00 am\nMelbourne time",
            );
            if (count > 1) {
              assert.equal(
                await page.locator(".story-cover").nth(1).evaluate((image) =>
                  getComputedStyle(image).objectFit
                ),
                "contain",
              );
            }
            await Deno.writeFile(new URL("story.png", output), png);
            await page.goto(`${base}/`);
            assert.equal(await page.locator("tbody tr").count(), count);
            const link = page.getByRole("link", {
              name: "Instagram Story PNG",
            });
            assert.equal(await link.getAttribute("href"), "story.png");
            const href = await link.evaluate((anchor) =>
              (anchor as HTMLAnchorElement).href
            );
            const download = await fetch(href);
            assert.equal(download.headers.get("content-type"), "image/png");
            assertPng(new Uint8Array(await download.arrayBuffer()));
            assert.equal(
              new URL("story.png", "https://example.com/brainrot/").pathname,
              "/brainrot/story.png",
            );
          } finally {
            await server.shutdown();
          }
        },
      );
    }

    await t.step(
      "quotes and markup in track names remain plain text",
      async () => {
        const title = 'Song "one" <live> & guests';
        const artist = 'Artist <band> "name"';
        await build(3, title, artist);
        const server = serveSite(output);
        try {
          assertPng(
            await captureStory(
              page,
              `http://127.0.0.1:${server.addr.port}/story/`,
            ),
          );
          assert.equal(
            await page.locator(".story-title").first().textContent(),
            `${title} 1`,
          );
          assert.equal(
            await page.locator(".story-artist").first().textContent(),
            artist,
          );
          assert.equal(
            await page.locator(".story-cover").first().getAttribute("alt"),
            `Cover for ${title} 1`,
          );
          assert.equal(await page.locator("live, band").count(), 0);
        } finally {
          await server.shutdown();
        }
      },
    );

    await t.step("cover redirects complete before capture", async () => {
      await build(3);
      const covers = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, (request) => {
        if (new URL(request.url).pathname === "/redirect") {
          return Response.redirect(new URL("/cover.svg", request.url), 302);
        }
        return new Response(decodeURIComponent(thumbnail().split(",")[1]), {
          headers: { "content-type": "image/svg+xml" },
        });
      });
      const file = new URL("story/index.html", output);
      const html = await Deno.readTextFile(file);
      await Deno.writeTextFile(
        file,
        html.replace(
          /src="data:image[^\"]+"/,
          `src="http://127.0.0.1:${covers.addr.port}/redirect"`,
        ),
      );
      const server = serveSite(output);
      try {
        assertPng(
          await captureStory(
            page,
            `http://127.0.0.1:${server.addr.port}/story/`,
          ),
        );
      } finally {
        await covers.shutdown();
        await server.shutdown();
      }
    });

    await t.step(
      "long titles and artist names fit without truncation",
      async () => {
        const title =
          "A long track title with several movements and a live performance recording "
            .repeat(3).trim();
        await build(
          3,
          title,
          "An artist name with collaborators and a featured performer".repeat(
            2,
          ),
        );
        const server = serveSite(output);
        try {
          assertPng(
            await captureStory(
              page,
              `http://127.0.0.1:${server.addr.port}/story/`,
            ),
          );
          assert.equal(
            await page.locator(".story-title").first().textContent(),
            `${title} 1`,
          );
          assert.ok(
            await page.locator(".story-title").first().evaluate((element) =>
              parseFloat(getComputedStyle(element).fontSize) >= 28
            ),
          );
        } finally {
          await server.shutdown();
        }
      },
    );

    await t.step(
      "missing covers, missing styles and excessive text fail the export",
      async () => {
        await build(3);
        const server = serveSite(output);
        const url = `http://127.0.0.1:${server.addr.port}/story/`;
        const original = await Deno.readTextFile(
          new URL("story/index.html", output),
        );
        try {
          await Deno.writeTextFile(
            new URL("story/index.html", output),
            original.replace(
              /src="data:image[^"]+"/,
              'src="/missing-cover.png"',
            ),
          );
          await assert.rejects(
            () => captureStory(page, url),
            /Story assets failed to load/,
          );
          await Deno.writeTextFile(
            new URL("story/index.html", output),
            original,
          );
          await page.route(
            "**/story.css",
            (route) => route.fulfill({ status: 404 }),
          );
          await assert.rejects(
            () => captureStory(page, url),
            /Story assets failed to load/,
          );
          await page.unroute("**/story.css");
          await build(3, "Unreasonably long title ".repeat(500));
          await assert.rejects(
            () => captureStory(page, url),
            /Story content exceeds/,
          );
        } finally {
          await server.shutdown();
        }
      },
    );
  } finally {
    await browser.close();
    await Deno.remove(temp, { recursive: true });
  }
});
