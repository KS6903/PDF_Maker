# PDF Maker

An all-in-one PDF editor, maker and converter that runs entirely on your computer.

## Privacy

Every file you open stays on your machine. All processing (editing, converting, merging,
compressing, encrypting) happens locally, and results are saved only where you choose in the
Save dialog. Nothing is ever uploaded. This is enforced, not just promised:

- The desktop app blocks **every** network request from its window.
- The page's Content-Security-Policy forbids network connections.
- The only thing that goes online is the update check, which runs outside the app window and
  only *downloads* version info and new installers from GitHub Releases. It never sends files.

## Tools

| Group | Tool | What it does |
| --- | --- | --- |
| Edit & sign | **Edit & sign** | Fill-in suggestions mark blank lines, underscores, "Label:" gaps, checkboxes and real form fields, so you can click and type. Add text, edit existing text, draw, highlight, white-out, rectangles, lines, arrows, check/cross marks, images and signatures. Undo/redo, zoom, keyboard shortcuts. |
| | **Fill forms** | Fill text fields, checkboxes, dropdowns and radio buttons; optionally flatten. |
| | **Watermark** | Text watermark — centered, tiled, top or bottom, with color, opacity and angle. |
| | **Page numbers & headers** | "Page 1 of 10" style numbers or any header/footer text, six positions. |
| Organize | **Organize pages** | Drag to reorder, rotate, delete, duplicate, insert blank pages, append another PDF. |
| | **Merge PDFs** | Combine files in any order, with optional page ranges per file. |
| | **Split & extract** | Extract pages, split by ranges, every N pages, or one file per page. |
| | **Compress** | Lossless restructuring, or re-render pages as optimized images for big savings. |
| Convert | **Create PDF** | Write in Markdown/plain text/HTML with live preview, or import **Word (.docx)**, HTML, Markdown or text files. |
| | **Images → PDF** | JPG, PNG, WebP, GIF, BMP, SVG → PDF with page size, orientation, margins, fit/fill. |
| | **PDF → Images** | PNG, JPG or WebP at 72–600 DPI. |
| | **PDF → Text & Word** | Extract text to `.txt` or an editable `.docx`. |
| Secure & info | **Protect with password** | AES-256 encryption with print/copy/edit permissions. |
| | **Remove password** | Save an unlocked copy of a PDF you have the password for. |
| | **Properties & metadata** | View page sizes and details; edit or strip title, author, keywords, etc. |

Every result has a **Continue with…** menu so you can chain tools (e.g. merge → compress → protect).
The home screen lists recommended tools and recently opened files, and the top bar has a tool
search (Ctrl+K) and an **Open file** button.

## Filling and signing

- **Suggestion boxes.** Open a PDF in the editor and it marks the places meant to be filled in:
  blank lines, runs of underscores, labels like "Date:" followed by empty space, checkbox glyphs,
  and any real form fields. Click a box and type; clicking a checkbox box places a check mark.
  Text typed into a real form field is stored as that field's value rather than painted on top.
- **Autofill.** Entries you type (name, email, address, phone…) are remembered on this computer
  and offered the next time, with entries used for the same kind of label ranked first. Each entry
  can be deleted, or clear them all with "Forget all remembered entries".
- **Signatures.** Draw (pressure-sensitive, three pen widths, any ink colour), type in one of five
  handwriting styles, or upload an image, which is kept at full resolution. Save as many
  signatures and initials as you like and reuse them with one click. **All pages** stamps the
  selected signature or initials onto every page.
- **Recent files.** Files you open are listed on the home screen so you can pick up where you left
  off.

All of this is stored only in this computer's local storage and can be cleared from the app.

## Windows app

```bash
npm install
npm run dist:win
```

This produces, in `release/`:

- `PDF-Maker-1.0.0-portable.exe` — single file, no install; just run it.
- `PDF-Maker-1.0.0-setup.exe` — installer with Start-menu/desktop shortcuts and "Open with PDF Maker" for `.pdf` files.

The executables are unsigned, so Windows SmartScreen may show "Windows protected your PC" the first
time — click **More info → Run anyway**.

## Sending updates

Installed copies (`setup.exe`) check GitHub Releases on startup and every few hours. They
download new versions in the background and offer **Restart now**; otherwise the update is
installed the next time the app closes. The portable `.exe` can't replace itself, so it shows
a notice and opens the download page. The sidebar shows the current version and has a
**Check for updates** link.

To release a new version:

```bash
npm version patch          # 1.0.0 → 1.0.1 (minor/major for bigger releases); commits + tags
git push --follow-tags     # GitHub Actions builds the app and publishes the release
```

Or publish straight from this machine (uses your `gh` login):

```bash
npm version patch
npm run release:win
```

Only copies that already include the updater (1.0.0 and later) update automatically.

## Development

```bash
npm install
npm run dev        # web version at http://localhost:5173
npm run app        # build and run the desktop app
npm run build      # typecheck + production build into dist/
```

Built with TypeScript + Vite, [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (writing and
encryption), [pdf.js](https://mozilla.github.io/pdf.js/) (rendering and text extraction),
[mammoth](https://github.com/mwilliamson/mammoth.js) (Word import), [docx](https://docx.js.org)
(Word export) and Electron for the desktop app.

## Limitations

- New text uses the standard PDF fonts (Helvetica, Times, Courier), which cover Western European
  characters. Other scripts (e.g. Chinese, Arabic, Cyrillic) are shown as `?` in text you add;
  existing text in your PDFs is always preserved.
- "Edit existing text" covers the original with white-out and places new text on top — it does
  not rewrite the PDF's internal text.
- Scanned PDFs are images, so text extraction returns nothing for them (no OCR).
- Word import keeps text, headings, lists, tables and images, but not exact page layout.
