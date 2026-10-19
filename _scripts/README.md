# Story export

The build creates `_site/story.png`, a dark-mode PNG at 1080 × 1920 pixels. It
shows the first three playlist tracks, or fewer when the playlist contains fewer
tracks. The main page keeps the full list and follows the viewer's system theme.
Both layouts use the same Normalize.css and Concrete.css stylesheets.

## Local build

Use the current Deno 2.x release. Deno 2.9.6 supports the browser installer.
Deno 2.2.12 cannot download this Chromium version through Playwright.

From the repository root, install Chromium:

```sh
deno task browser:install
```

On Linux, install the browser's system dependencies if they are absent:

```sh
deno task browser:install --with-deps
```

Build the HTML and PNG:

```sh
deno task build
```

Run the export tests:

```sh
deno task test
```

The build and tests need network access for the shared CDN stylesheets. The
build also downloads the playlist cover images. A missing image, a missing
stylesheet, or content outside the safe area stops the export. Long titles use
smaller text before the export stops for overflow.

`deno task build:html` builds only the HTML and CSS. `deno task story` captures
the existing HTML without a rebuild. `deno task serve` previews the HTML but
does not regenerate the PNG. The top and bottom 250 pixels remain clear of
Instagram controls.

## Share the image

After deployment, the main page has an **Instagram Story PNG** download link.
The deployment summary also contains the direct PNG link. The published image is
at <https://chromadream.github.io/brainrot/story.png>. Each deployment replaces
this image with the current export.

Download the PNG, then add it to an Instagram Story. The link does not publish
the image to Instagram. The generated PNG stays in `_site/`, which Git ignores.
