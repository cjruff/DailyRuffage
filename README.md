# Ruff Cookbook

A family recipe app: installable on your phones, works offline, and syncs between devices.
Recipes can be typed in, or imported from screenshots, links (TikTok, recipe sites) and dictation.

Code: © Corey J Ruff

```
app/      The PWA — put this on GitHub Pages. Works on its own with all 77 Living Cookbook recipes.
worker/   Cloudflare Worker — sync, photo storage, and import. Optional until you want those.
tools/    One-time Python import from the Living Cookbook PDF (already done; kept for reference).
```

## How it fits together

- **The phone has the whole cookbook** (IndexedDB), so search is instant and it works with no signal.
- **The Worker** keeps the master copy in Cloudflare D1 (SQLite), stores source photos, and does imports.
  When two devices change the same recipe, the most recent edit wins.
- **Cost:** GitHub Pages and the Cloudflare free tier are both $0. Imports use the Gemini free tier by default.
  You can switch to Claude Haiku for a fraction of a cent per recipe with one setting.
  Recipe sites that publish structured recipe data are read directly, with no AI call at all.

---

## Step 1: Put the app on GitHub Pages (about 5 minutes)

1. Create a repo, e.g. `cjruff/ruff-cookbook`.
2. Copy everything **inside** `app/` to the repo root, then commit and push.
3. In the repo, go to **Settings → Pages → Deploy from branch → `main` / root**.
4. Open `https://cjruff.github.io/ruff-cookbook/` on the phone. In Safari, tap **Share → Add to Home Screen**.

That's a working, searchable cookbook. The Worker (steps 2–4) adds sync between phones and the import features.

> To update the app later: edit files, then bump `VERSION` in `sw.js` (e.g. `-v2`) so phones pick up the change.

## Step 2: Get a free Gemini API key (2 minutes)

Go to <https://aistudio.google.com>, choose **Get API key**, and create a key.
Free-tier note: Google may use free-tier requests to improve its models. For recipe screenshots that's
probably fine. If you'd rather it didn't, see "Switching to Claude" below.

## Step 3: Deploy the Worker (about 10 minutes)

You need Node.js installed and a free Cloudflare account.

```bash
cd worker
npm install
npx wrangler login                      # opens the browser once
npx wrangler d1 create ruff-cookbook    # copy the database_id it prints into wrangler.toml
npm run db:init                         # creates the tables
npx wrangler secret put PASSCODE        # pick something you'll both type once
npx wrangler secret put GEMINI_API_KEY  # paste the key from step 2
npm run deploy                          # prints your URL: https://ruff-cookbook.<you>.workers.dev
```

In `wrangler.toml`, `ALLOWED_ORIGIN` is already set to `https://cjruff.github.io`. Change it if your Pages URL is different.

## Step 4: Connect each phone

In the app, open **⚙ Settings** and enter your name, the Worker URL, and the passcode, then tap **Save**.
The first device uploads the 77 recipes. Later devices just download them.
The dot in the top bar shows sync status: green = synced, amber = changes waiting, red = error.

---

## Adding recipes

Tap **+**:

| Option | What happens |
|---|---|
| 📸 Screenshots | Pick all the screenshots for one recipe, in order. They're shrunk, read by the AI, and kept with the recipe as the source. |
| 🔗 Link | **TikTok:** reads the caption (many creators put the whole recipe there). **Recipe sites:** reads the page's built-in recipe data. |
| 🎙️ Type / dictate | Tap the keyboard mic and talk it through while the video plays. Rambling is fine. |
| ✍️ By hand | Blank form. |

Imports open in the editor marked **Needs review**, so you can check them before saving.
If a TikTok caption doesn't include the recipe, screenshot the frames that show the ingredients and use 📸 instead.

## One-tap sharing from Photos or TikTok (iOS Shortcut)

iPhone web apps can't appear in the Share menu, but a Shortcut can, and it sends straight to the Worker.
Recipes added this way land in **Needs review**, to tidy up whenever, or never.

In the Shortcuts app, tap **+** to create a new shortcut:

1. Tap the **ⓘ** (details) button, turn on **Show in Share Sheet**, and set it to accept **Images** and **URLs**.
2. Add **Get Type of** *Shortcut Input*, then **If** *Type* **is** *URL*:
   - **URL branch:** add **Get Contents of URL**
     - URL: `https://ruff-cookbook.<you>.workers.dev/api/import`
     - Method: **POST**
     - Headers: `X-Passcode` = *your passcode*
     - Request Body: **Form**, with fields `url` (Text) = *Shortcut Input*, `save` (Text) = `1`, `addedBy` (Text) = *her name*
   - **Otherwise (images):** add **Resize Image** (*Shortcut Input*, width 1800), then **Convert Image** to **JPEG**,
     then **Get Contents of URL** as above, but with the form field `images` (File) = *Converted Image* in place of `url`.
3. Add **Show Notification**: "Added to the cookbook 👍".
4. Name it **Add to Cookbook**.

To use it: select the screenshots in Photos (or tap Share on a TikTok), then choose **Add to Cookbook**.

## Switching to Claude

In `wrangler.toml`, set `AI_PROVIDER = "anthropic"`. Then run `npx wrangler secret put ANTHROPIC_API_KEY`
(the key comes from console.anthropic.com) and `npm run deploy`. `AI_MODEL` can be left blank to use the default.

## Backups

**Settings → Download backup** saves every recipe as one JSON file. **Restore** merges a backup back in.
Source photos stay on the Worker.

## Limits worth knowing

- Up to 10 images per recipe, each about 1.9 MB after shrinking (the app and the Shortcut both shrink them).
- The passcode is one shared secret for the household. That's enough for a recipe box, not for anything sensitive.
- Cook mode keeps the screen awake on browsers that support it (current iOS Safari and Chrome do).
