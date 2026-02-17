# PDF to image conversion troubleshooting

The app uses **ImageMagick** (with Ghostscript) for PDF→image. When "Mark as image" or handwritten PDF extraction fails, use these steps.

## 1. Install ImageMagick and Ghostscript

On the server (e.g. Ubuntu):

```bash
sudo apt-get update
sudo apt-get install imagemagick ghostscript
whereis magick    # ImageMagick 7: /usr/bin/magick
whereis convert   # ImageMagick 6/7: /usr/bin/convert
whereis gs        # Ghostscript: /usr/bin/gs
```

The app uses the **`convert`** command. Standard `imagemagick` packages provide both `magick` and `convert`; if you only have `magick`, install the package that provides `convert` for your distro.

## 2. Allow PDF in ImageMagick policy

Many distros disable PDF in ImageMagick for security. You must allow it:

- **File:** `/etc/ImageMagick-6/policy.xml` or `/etc/ImageMagick-7/policy.xml`
- **Find:** `<policy domain="coder" rights="none" pattern="PDF" />`
- **Change to:** `<policy domain="coder" rights="read|write" pattern="PDF" />`
- Restart the app (e.g. `pm2 restart markmate`).

## 3. PATH when running under PM2 / Virtualmin

If the app runs with a minimal PATH (e.g. PM2, cron, Virtualmin), set in your **server** `.env` so both Ghostscript and ImageMagick are found:

```env
GHOSTSCRIPT_PATH=/usr/bin/gs
IMAGEMAGICK_PATH=/usr/bin
```

- `GHOSTSCRIPT_PATH`: full path to the `gs` binary, or the directory containing it.
- `IMAGEMAGICK_PATH`: directory containing the `convert` binary (e.g. `/usr/bin`), or the full path to `convert`.

Restart the app after changing `.env` (e.g. `pm2 restart markmate`).

## 4. Check PM2 logs for the real error

```bash
pm2 logs markmate --lines 100
```

Look for:

- `PDF→image: PATH includes gs dir: /usr/bin` – Ghostscript directory is on PATH
- `PDF→image: PATH includes ImageMagick dir: /usr/bin` – ImageMagick directory is on PATH
- `PDF→image: using ImageMagick (convert) at /usr/bin/convert` – convert binary is being used
- Pre-flight messages: `Ghostscript (gs) not found` or `ImageMagick (convert) not found` – set the corresponding `*_PATH` in `.env`
- `PDF→image: page N error: <message>` – e.g. "Command failed: not authorized" (fix policy.xml), "Unable to read file" (permissions), or "no decode delegate" (install ghostscript)

The **underlying error** is also included in the UI when marking fails (e.g. "not authorized by policy" or "convert: not found"). Use it to fix policy, PATH, or permissions.
