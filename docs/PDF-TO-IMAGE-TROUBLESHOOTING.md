# PDF to image conversion troubleshooting

The app uses **ImageMagick** (with Ghostscript) for PDF→image. When "Mark as image" or handwritten PDF extraction fails, use these steps.

## 1. Install ImageMagick and Ghostscript

On the server (e.g. Ubuntu):

```bash
sudo apt-get update
sudo apt-get install imagemagick ghostscript
whereis magick    # ImageMagick 7: /usr/bin/magick
whereis convert   # ImageMagick 6: /usr/bin/convert
whereis gs        # Ghostscript: /usr/bin/gs
```

## 2. Allow PDF in ImageMagick policy

Many distros disable PDF in ImageMagick for security. You must allow it:

- **File:** `/etc/ImageMagick-6/policy.xml` or `/etc/ImageMagick-7/policy.xml`
- **Find:** `<policy domain="coder" rights="none" pattern="PDF" />`
- **Change to:** `<policy domain="coder" rights="read|write" pattern="PDF" />`
- Restart the app (e.g. `pm2 restart markmate`).

## 3. PATH when running under PM2 / Virtualmin

If the app runs with a minimal PATH (e.g. PM2, cron), set in your **server** `.env` so Ghostscript is found:

```env
GHOSTSCRIPT_PATH=/usr/bin/gs
```

Restart the app after changing `.env`.

## 4. Check PM2 logs for the real error

```bash
pm2 logs markmate --lines 100
```

Look for:

- `PDF→image: using ImageMagick (magick/convert)` – ImageMagick is in use
- `PDF→image: PATH includes gs dir: /usr/bin` – Ghostscript directory is on PATH
- `PDF→image: page 1 buffer conversion failed: <message>` – e.g. "not authorized" (fix policy.xml), "Unable to read file" (permissions), or "no decode delegate" (install ghostscript)

Use that message to fix policy, PATH, or permissions.
