# Folio

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
| | **Watermark** | Text watermark, centered, tiled, top or bottom, with color, opacity and angle. |
| | **Page numbers & headers** | "Page 1 of 10" style numbers or any header/footer text, six positions. |
| | **Redact a PDF** | Drag boxes or find words, email addresses and phone numbers, then black them out. Redacted pages are flattened and everything unreachable is pruned, so the text is gone from the file, not just covered. Optional OCR makes those pages searchable again. |
| | **Measure objects** | Distance, perimeter and area at any scale (e.g. 1 in = 10 ft), with a "set scale" from a known length. Measurements can be saved onto the page. |
| | **Use a certificate** | Sign with a digital ID: load a `.pfx`/`.p12` or create a self-signed one. Signatures are PKCS#7, added as an incremental update so earlier signatures stay valid, with an optional visible box. Existing signatures are checked for changes since signing. |
| | **Add rich media** | Embed a video, sound or any file on a page, shown with a poster frame; it opens in the computer's own player. Lists and saves files already attached. |
| Organize | **Organize pages** | Drag to reorder, rotate, delete, duplicate, insert blank pages, append another PDF. |
| | **Merge PDFs** | Combine files in any order, with optional page ranges per file. |
| | **Split & extract** | Extract pages, split by ranges, every N pages, or one file per page. |
| | **Compress** | Lossless restructuring, or re-render pages as optimized images for big savings. |
| | **Compare files** | Line and word changes between two versions, plus a page-by-page visual diff, with a report PDF that highlights what changed. |
| | **Use guided actions** | Chain steps (OCR, watermark, page numbers, rotate, flatten forms, remove scripts or metadata, PDF/A, compress, password) and run them over a batch of files. Save your own actions. |
| | **Add search index** | Index many PDFs (optionally OCR-ing scans) and search them all at once; click a hit to open the file. Kept on this computer. |
| | **Create custom tool** | Put the tools you use most in a toolbar tab of your own. |
| Convert | **Create PDF** | Write in Markdown/plain text/HTML with live preview, or import **Word (.docx)**, HTML, Markdown or text files. |
| | **Images → PDF** | JPG, PNG, WebP, GIF, BMP, SVG → PDF with page size, orientation, margins, fit/fill. |
| | **PDF → Images** | PNG, JPG or WebP at 72-600 DPI. |
| | **PDF → Text & Word** | Extract text to `.txt` or an editable `.docx`. |
| | **Scan & OCR** | Recognise text on scanned pages (English, on this computer) and lay it invisibly over the scan, so it can be searched and copied. |
| | **Apply PDF standards** | Convert to PDF/A-2b for archiving: embeds an sRGB output intent and matching XMP metadata, removes scripts and attachments, and flattens only the pages that can't comply (fonts not embedded, CMYK). |
| | **Use print production** | Crop and registration marks, colour bars, page information and bleed, with trim and bleed boxes set; approximate separations preview. |
| Secure & info | **Protect with password** | AES-256 encryption with print/copy/edit permissions. |
| | **Remove password** | Save an unlocked copy of a PDF you have the password for. |
| | **Properties & metadata** | View page sizes and details; edit or strip title, author, keywords, etc. |
| | **Prepare for accessibility** | Checks title, language, scanned pages, field labels, tab order, bookmarks and tagging, and fixes what can be fixed in place. |
| | **Use JavaScript** | See, edit, add or remove the scripts in a PDF. Folio never runs them. |

Every result has a **Continue with…** menu so you can chain tools (e.g. merge → compress → protect).
The home screen lists recommended tools and recently opened files, and the top bar has a tool
search (Ctrl+K) and an **Open file** button.

## Document tabs

The editor keeps several PDFs open at once, each in its own tab with its own edits, undo history,
zoom and scroll position. Open more with the **+** button, by dropping files onto the page area,
or from the home screen. A dot marks unsaved edits, **Save PDF** saves the tab you're on, and
closing a tab with unsaved edits asks first. Ctrl+W closes a tab, Ctrl+Tab switches.

Tabs stay until you close them. Quitting the app, or switching to another tool and back,
keeps every open document, its unsaved edits, zoom and scroll position, all stored on this
computer.

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

- `Folio-<version>-portable.exe`, single file, no install; just run it.
- `Folio-<version>-setup.exe`, installer with Start-menu/desktop shortcuts and "Open with Folio" for `.pdf` files.

The executables are unsigned, so Windows SmartScreen may show "Windows protected your PC" the first
time, click **More info → Run anyway**. On launch the app shows a splash window with the logo,
name and version until the main window is ready.

## File Explorer right-click menu

The desktop app can add entries to the Windows right-click menu:

| Right-click on | Entry | Opens |
| --- | --- | --- |
| A PDF | Edit with Folio | the editor |
| PDFs (several selected) | Merge with Folio | Merge PDFs, files queued |
| A PDF | Compress with Folio | Compress |
| Pictures (JPG, PNG, WebP, BMP, GIF, TIFF) | Convert to PDF with Folio | Images to PDF |
| Word, text, Markdown or HTML | Convert to PDF with Folio | Create PDF, file imported |

The installer sets these up, and the home screen has a **File Explorer menu** panel to add or
remove them at any time (handy for the portable build). The entries are written under
`HKEY_CURRENT_USER`, so no admin rights are needed and no other account is touched.

On Windows 11 they appear under **Show more options** (or Shift+F10). Putting items in the short
menu requires a signed, packaged (MSIX) app, which this unsigned build isn't.

## Sending updates

Installed copies (`setup.exe`) check GitHub Releases on startup and every few hours. They
download new versions in the background and offer **Restart now**; the installer then runs
silently, with no setup wizard and no install-folder or all-users questions, and the app reopens on
the new version. Choose **Later** and it installs just as quietly the next time the app
closes. Either way it reuses the folder it's already installed in. The silent install only
applies to updates; a first install from `setup.exe` still shows the normal wizard, so the
install location can be chosen there. The portable `.exe` can't replace itself, so it shows
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
(Word export), [Tesseract.js](https://tesseract.projectnaptha.com/) (OCR, bundled with its English
model), [node-forge](https://github.com/digitalbazaar/forge) (certificate signing) and Electron for the
desktop app.

## Limitations

- New text uses the standard PDF fonts (Helvetica, Times, Courier), which cover Western European
  characters. Other scripts (e.g. Chinese, Arabic, Cyrillic) are shown as `?` in text you add;
  existing text in your PDFs is always preserved.
- "Edit existing text" covers the original with white-out and places new text on top, it does
  not rewrite the PDF's internal text.
- Scanned PDFs are images, so text extraction returns nothing for them until you run **Scan & OCR**
  (English only).
- PDF/A conversion makes pages that can't comply into images, so their text is no longer selectable.
- Certificate signing reads `.pfx`/`.p12` files; it doesn't reach into the Windows certificate store,
  and it checks signatures for tampering but not against certificate authorities.
- The separations preview is worked out from screen colours, not from a colour profile.
- Word import keeps text, headings, lists, tables and images, but not exact page layout.
