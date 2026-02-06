# PDF to image conversion troubleshooting

When "Mark as image" or handwritten PDF extraction fails with "Could not convert PDF to images", use these steps.

## 1. Check GraphicsMagick and Ghostscript

On the server (e.g. Ubuntu):

```bash
whereis gm    # e.g. /usr/bin/gm
whereis gs    # e.g. /usr/bin/gs
gm version    # should mention Ghostscript; if "no decode delegate" for PDF, see below
```

## 2. Set paths in .env (PM2 / minimal PATH)

If the app runs under PM2 or cron, the process may not have `/usr/bin` in PATH. Add to your **server** `.env`:

```env
GRAPHICSMAGICK_PATH=/usr/bin/gm
GHOSTSCRIPT_PATH=/usr/bin/gs
```

Restart the app (e.g. `pm2 restart markmate`).

## 3. GraphicsMagick "no decode delegate" for PDF

GraphicsMagick needs **Ghostscript** to read PDFs. If `gm version` does not show Ghostscript support, or conversion fails with "no decode delegate for this image format":

- **Ubuntu/Debian:** Install both and ensure gs is on the system:
  ```bash
  sudo apt-get update
  sudo apt-get install ghostscript graphicsmagick
  ```
- The `gm` binary must be able to run `gs`. Ensure PATH includes the directory containing `gs` (we prepend it from `GHOSTSCRIPT_PATH` or auto-detect `/usr/bin/gs`, `/bin/gs`).

## 4. Try ImageMagick instead

The app will automatically retry with **ImageMagick** if GraphicsMagick fails. If you use ImageMagick:

- **Install:** `sudo apt-get install imagemagick ghostscript`
- **Allow PDF:** Many distros disable PDF in ImageMagick for security. Edit the policy file:
  - File: `/etc/ImageMagick-6/policy.xml` or `/etc/ImageMagick-7/policy.xml`
  - Find: `<policy domain="coder" rights="none" pattern="PDF" />`
  - Change to: `<policy domain="coder" rights="read|write" pattern="PDF" />`
- Restart the app.

## 5. Check PM2 logs for the real error

After enabling the extra logging (recent commits), run:

```bash
pm2 logs markmate --lines 100
```

Look for lines like:

- `PDF→image: PATH includes gs dir: /usr/bin` – PATH is set for Ghostscript
- `PDF→image: using GraphicsMagick at /usr/bin/gm` – gm was found
- `PDF→image: page 1 buffer conversion failed: <message>` – the actual failure reason (e.g. "no decode delegate", "not authorized", "Unable to read file")

Use that message to decide: fix PATH/gs, switch to ImageMagick and policy.xml, or fix file permissions.
