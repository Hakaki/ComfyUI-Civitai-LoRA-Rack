# CLR Usage Guide

For people who already have the plugin installed. This covers **how to use it** — installation lives in [README.md](../README.md).

[中文说明](USAGE.zh-CN.md)

> **About the screenshots:** they were taken with the interface set to Chinese (the author's own install). Every label shown maps to the English UI string quoted in the surrounding text.

---

## 1. Up and running in three steps

1. **Add the node** — double-click the canvas, search `CLR`, pick **Civitai LoRA Rack (CLR)**.
2. **Add LoRAs** — click **＋** at the top right of the node panel, click cards in the picker to select them, then click **Add selected**.
3. **Set weights** — each row in the node panel has its own weight box and enable switch. Changes apply immediately.

Click **Manage** on the panel (or **🎴 Open LoRA Stack** under the node) to open the rack window — bigger thumbnails, more columns, and the full set of weights.

> **The API key is optional.** Everything that lives on disk works without one. You only need it for NSFW content, or to look up files that have no local metadata. See section 8.

---

## 2. Two views, one rack

The same data appears in both views, and edits in either one write back to the same node.

| | Inline node panel | Rack window |
|---|---|---|
| How to open | it *is* the node | **Manage** / **🎴 Open LoRA Stack** |
| Good for | quick toggles and weight tweaks while generating | organising, reordering, reading metadata, bulk work |
| Weights | model weight only | model / CLIP / trigger words |
| Thumbnails | small | large |
| Author / tags | hover the name for a tooltip | shown inline |

The rack window is **per node**: two CLR nodes can each have their own rack window open at the same time.

---

## 3. The inline node panel

![Inline node panel](screenshots/usage_node_panel.png)

| Where | What it does |
|---|---|
| **Manage** | Opens the rack window (full version) |
| **＋** | Opens the picker to add LoRAs |
| Thumbnail | Opens the detail window for that row |
| Name | Same; hover for full path, author and base model |
| Weight box | Edits the model weight directly. Any real number |
| Switch | Enables / disables that one row. Disabled rows go grey but **stay in the list** |
| **✕** | Removes it from the rack (**does not touch the file on disk**) |

**Worth knowing:**

- Drag the node taller and the list grows with it; overflow scrolls. Wheel events over the list are swallowed so they don't zoom the canvas instead.
- Past 200 rows only the first 200 are rendered, with a note reading *only rendering the first 200; click "Manage" to see all*. Nothing is lost — it just isn't all painted at once.
- An empty rack shows *Empty · click "＋" to add Lora*.
- Right-click any row to reveal the folder or delete locally — see section 9.

---

## 4. The rack window

![Rack window](screenshots/usage_stack_window.png)

### Header

- **＋ Add Lora** — opens the picker
- **⚙ Settings** — API key and language

### Each row

```
⠿ [img] name ↗  copy 1/2  ▶ video  No Civitai info [Search]
         by author · base model · version · ⬇ 12.3k · 📄 filename
         [my tags] [Civitai tags] [trigger words…]
         Model weight [1.00]  CLIP [1.00]  Trigger words [0.00]  Enable[switch]  Favorite[☆]
                                                                ↑ ↓ ✕
```

| Element | Meaning |
|---|---|
| **⠿** drag handle | Hold and drag up/down to reorder. Only the handle drags, so input fields stay usable |
| **↗** | Opens this LoRA's Civitai page in a browser |
| **copy i/n** | Several files on disk share the same model name — tell them apart by `📄 filename` in the subtitle |
| **▶ video** | This row's cover is a video |
| **No Civitai info** + **Search** | Missing author / tags / trigger words. Click **Search** to look up just this one |
| **Query failed** | The last lookup errored; hover the name or click **Search** again |
| **Model weight** | The main weight — the one you'll tune most |
| **CLIP** | Text-encoder weight, controls how strongly it steers the prompt |
| **Trigger words** | Strength at which trigger words are injected. `0` means not added |
| **Enable** | Same as the switch in the node panel |
| **Favorite** | ☆ / ★ — filterable via **⭐ Favorite** in the picker |
| **↑ ↓** | Move up / down one slot |
| **✕** | Remove from the rack, file untouched |

**Weights accept any real number** — negatives, `3.5`, `0.625`, no clamping. The step is `0.05` for the arrow keys; typing is unrestricted.

**When is trigger weight useful?** Some LoRAs have trigger words that pollute the whole prompt. Keep the model weight at `1.0` for the look, and drop the trigger weight to `0` or `0.5` to reduce interference with everything else.

### Footer

- Left: `Total N · M active`, plus the **frontend version** (`Frontend v2.36`). Check this number first when something looks wrong — extension JS is cached aggressively, so if the number doesn't match the plugin version, force-reload with `Ctrl+Shift+R`.
- **Enable all** / **Disable all** — disabling only sets `hidden`; every entry stays in the list. Much cheaper than rebuilding the rack.
- **Clear** — after a confirmation, empties the list on the current node. **Disk files are untouched.**
- **Done** — closes the window.

---

## 5. The picker (click ＋)

![Picker](screenshots/usage_picker.png)

> About this screenshot: it is the picker with the **⭐ Favorites** filter applied. The author's own model library is mostly NSFW, so a full unfiltered list is not suitable for a public repo. The toolbar, card layout and footer buttons are identical to the unfiltered view, and the local directory paths have been blanked out.

### Filters

| Control | What it does |
|---|---|
| Search box | Matches name, author, filename, Civitai tags, trigger words and **your own tags** |
| **⭐ Favorite (n)** | Show favourites only; click again to clear. Stacks with the other filters |
| Folder dropdown | `All folders (N)` plus per-directory counts |
| Tag dropdown | Two groups — **My tags** and **Civitai Tags** — with counts. Same-named tags merge into *My tags* |
| **↻ Refresh** | Rescan the model directory (after adding/removing files on disk) |
| **🔍 Batch Civitai lookup** | See below |
| **🧹 Clean junk** | See section 7 |
| **⚙ Settings** | API key / language |
| **▦ Cards** / **☰ List** | Two views; the choice is remembered |
| **− N ＋** | Card size; remembered |

### What a click on a card does

This is the easiest place to misclick. Two rules:

- **Thumbnail** or **ⓘ** → opens the **detail window**
- **Anywhere else** (title, tags, subtitle, empty space) → **select / deselect**

The **☆** at the bottom right is the favourite toggle; it turns into ★ and does not select the card.

LoRAs already in this rack carry an *Already in rack* chip; clicking one just toasts *This Lora is already in the rack*, so you can't add duplicates.

The footer shows the scanned model directories on the left, and **Cancel** / **Add selected** on the right.

### Batch Civitai lookup

- **The lookup range is the currently filtered list**, not the whole library. Filter to one folder first if that's what you want.
- Only rows *missing* author / tags / trigger words are queried — nothing already complete is re-requested.
- At most **200 rows** per run; beyond that it notes *only the first 200 are processed this time; narrow the filter to query more*.
- While running, the button shows progress (`Querying Civitai 3/48…`). Each row can take a few seconds.
- Results are matched by SHA256 and written back to the `.civitai.info` file next to the LoRA, so they're available offline from then on.
- The summary reads `Hit 12 · Not found 3 · Failed 0`. *Not found* means the file isn't on Civitai (self-trained, private, or deleted) — not an error.

---

## 6. The detail window

![Detail window](screenshots/usage_detail.png)

Three entry points: thumbnail / ⓘ in the picker, the name in the rack window, or the thumbnail in the node panel. There is only ever one detail window per LoRA — opening it again focuses the existing one.

### Left column: media

- The main image or video fills the large area.
- **Click it to zoom**: a lightbox opens. `←` `→` page through, `Esc` / `✕` / clicking outside the image closes it.
- **⭐ Set as cover** starts disabled. Click one of the sample thumbnails first, then the button becomes **⭐ Set this image as cover** and works.
  - Image covers are **downloaded locally** as the preview.
  - Video covers only record a link, nothing is downloaded.
- A line under the image states the current cover source: `Cover: local preview` / `Cover: Civitai image` / `Cover: custom image (downloaded)` / `Cover: custom video (link)`.
- Once you've set a custom cover, **🖼 Restore original cover** appears in the header.
- The strip below holds up to 8 Civitai sample images; click one to promote it to the main slot.

### Right column: metadata

Listed in order: author, type, base model, version, published date, downloads, favourites, file size, and data source (`Civitai Metadata File` or `Safetensors Header`), followed by:

- **Training trigger words** — click to copy
- **Training params (read from the safetensors header)** — network dim, alpha, learning rate, optimizer, resolution, epochs, steps
- **High-frequency tagging words** — the words most used when tagging the training set
- **Civitai description** — the author's original text

### My tags / notes

This section is yours. It's **stored locally and never overwritten by a Civitai refresh**.

- **Add a tag**: type, then press `Enter` or click **＋ Add**. Commas add several at once (`landscape, night, blue hour`).
- **Delete a tag**: click the `✕` on the tag.
- **Clear tags / clear notes**: two separate buttons in the section header; neither affects the other.
- **Write notes**: the textarea below. Whatever helps you remember — what it's good for, what weight you usually use.
- **Auto-save**: there's no save button. Tags save instantly, notes save about 0.7 s after you stop typing, and anything pending is flushed when the window closes. The status word in the header briefly changes from *Auto-save* to **Saved ✓**.

Tags and notes live in a `.cft-user.json` next to the LoRA file, so moving the whole model folder keeps them.

---

## 7. Cleanup and quarantine

Entry point: **🧹 Clean junk** in the picker toolbar.

![Cleanup](screenshots/usage_cleanup.png)

### What it scans

Only files orphaned from any existing LoRA, in five categories:

| Category | Contents | Default |
|---|---|---|
| Orphaned previews (孤立预览图) | Images whose LoRA is gone from that directory | ✅ |
| Orphaned metadata (孤立信息文件) | `.civitai.info` / `.info.json` / `.cft-hash.json` with no main file | ✅ |
| Partial downloads (下载残留) | `.part` / `.tmp` / `.crdownload` leftovers | ✅ |
| Zero-byte files (0 字节空文件) | Empty sidecars or broken images | ✅ |
| Unknown `.json` (孤立 .json) | Generic json that can't be confirmed as a LoRA sidecar | ❌ off |

> **These category names currently stay in Chinese in the UI even when the interface language is English.** The labels come from the backend and aren't translated yet. The Chinese names are in the table above so you can match them.

### Hard limits

> **LoRA model files (`.safetensors` / `.ckpt` / `.pt` / `.bin`) never appear in the candidate list and are never cleaned up.** That line is printed at the top of the window, and it isn't just a promise — candidates are filtered on the backend before they reach the UI.

### Two ways to process

- **Move to quarantine (recommended)** — files go to `ComfyUI/models/loras/.cft_trash/<timestamp>/` along with a `_cft_trash_manifest.json` recording where they came from. Fully restorable.
- **Permanent delete** — requires an explicit checkbox plus a second confirmation. Gone means gone.

### The quarantine

Click **Open quarantine** after a cleanup:

- Batches are listed one per cleanup run, with file counts and total size
- **Restore batch** — puts every file back where it came from
- **Permanently delete** (single batch) — irreversible
- **🗑 Empty quarantine** — clears all batches, irreversible

The `.cft_trash` directory itself is kept even when empty, so later cleanups can't trip over it.

### Deleting a single LoRA

You don't need the cleanup window for this. Right-click a LoRA in the rack window, the picker, or the node panel → **Local delete (including images and info files)**.

The flow is deliberately three steps to prevent accidents:

1. It first lists **every file** that will be touched (body + previews + sidecars) with a total size
2. You choose **Move to quarantine (recommended)** or **Permanently delete (irreversible)**
3. A final confirmation

On success, if that LoRA was in the rack it's removed from the rack automatically.

---

## 8. Settings

Three entry points, all the same dialog: **⚙ Settings** in the node, the rack window, or the picker.

![Settings](screenshots/usage_settings.png)

### Language

**中文** / **English**. Applies immediately in every open window and is remembered in this browser.

### Civitai API key

- The status line reads `Current status: Not configured` or `Current status: Configured (********abcd)`.
- The input is a password field; click **👁** to reveal it temporarily.
- **Verify** — checks validity without saving. Success shows `✓ Valid · Account xxx`.
- **Save** — writes it to disk, then verifies automatically.
- **If a key is already stored**: leaving the box empty and pressing Save does **not** wipe it — it just says *No API Key entered; the saved Key is unchanged*. To actually remove it, use **Clear API Key**.
- Clearing it means NSFW / login-only content is no longer available until you enter a new one.

The key is stored on this machine in `ComfyUI/user/default/Civitai-LoRA-Rack/config.json` under `api_key`. It is never uploaded, never logged, and the HTTP API only ever returns a masked value.

Get a key at <https://civitai.com/user/account> → API Keys.

### Other fields in the same file

Options without a UI can be edited directly in that json:

```json
{
  "api_key": "",
  "site_domain": "civitai.com",
  "proxy_enabled": false,
  "proxy_address": "http://127.0.0.1:7890",
  "extra_loras_dirs": []
}
```

| Field | Purpose |
|---|---|
| `site_domain` | Point at a mirror if `civitai.com` is unreachable from your network |
| `proxy_enabled` + `proxy_address` | Route only CLR's requests through a proxy — ComfyUI's other traffic is unaffected |
| `extra_loras_dirs` | Extra directories to scan, if your LoRAs live outside `ComfyUI/models/loras` (array of absolute paths) |

Restart ComfyUI after editing.

---

## 9. Right-click menu reference

Right-click works in three places — rows in the rack window, cards in the picker, rows in the node panel — with slightly different menus:

| Item | Rack | Picker | Node panel |
|---|:--:|:--:|:--:|
| View details | ✅ | ✅ | ✅ |
| Refresh info from Civitai | ✅ | — | — |
| Favorite / unfavorite | — | ✅ | — |
| Jump to containing folder (with file selected) | ✅ | ✅ | ✅ |
| Open containing directory (nothing selected) | ✅ | ✅ | — |
| View local file list | ✅ | ✅ | ✅ |
| Remove from rack | ✅ | — | — |
| Local delete (images + info files) | ✅ | ✅ | ✅ |

*Jump to containing folder* opens the file manager with the file **selected**; *Open containing directory* just opens the folder. The former is slower (it has to launch explorer on Windows), the latter is instant.

![Right-click menu](screenshots/usage_context_menu.png)

---

## 10. FAQ

**No thumbnails / the panel is blank?**
First confirm the files really exist — if **＋** lists them, scanning works. If only the images are missing, it's usually a path with unusual characters, or the frontend cached an old JS bundle after a ComfyUI restart. Check `Frontend vX.XX` in the rack footer against the plugin version; if they differ, hit `Ctrl+Shift+R`.

**Where did the `lora_stack` input field go?**
It's hidden, but **the data still lives in it** and still serializes. That's deliberate: hiding a widget *by removing it* would drop its value from `widgets_values` and your rack configuration would be silently lost. Don't go looking for it, and don't hand-edit `widgets`.

**I opened the workflow on another machine and the rack is empty.**
Workflows store relative paths plus filenames. If the files aren't in the same place on the target machine, nothing matches. Separately, the plugin keeps a per-node-id backup in this browser's localStorage, to rescue the "I never saved the workflow" case — if it loads a graph with an empty rack while a backup exists, it shows `⚠ Recovered N entries from local backup`.

**What is "copy 1/2"?**
You downloaded the same LoRA twice under different filenames. The plugin groups them by a hash of the model name and labels them `copy 1/2`; use `📄 filename` in the subtitle to tell them apart. It never deletes either one for you.

**Is weight 0 the same as switching it off?**
No. Weight 0 still loads the LoRA (VRAM and time are spent); the switch skips it entirely. If you want it fully inactive, use the switch.

**Is "Not found" an error?**
No. It means the file isn't on Civitai — self-trained, private, or removed by its author. That's a normal result.

**Some words stay in English in the Chinese UI.**
`CLIP`, `UNet`, `safetensors` and `SHA256` are industry terms and are intentionally left untranslated. The node types `CFTLoraStack` / `CFTLoraLoader` keep their historical prefix so existing workflows don't break.

---

## Appendix: keyboard shortcuts

| Key | Action |
|---|---|
| `Esc` | Close the lightbox / close the topmost dialog |
| `←` `→` | Previous / next image in the lightbox |
| `Enter` | In the *My tags* input, adds the tag |
