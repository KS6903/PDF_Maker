# PDF Maker

An all-in-one PDF editor, maker and converter that runs entirely on your computer.
Files are never uploaded anywhere.

## Tools

| Group | Tool | What it does |
| --- | --- | --- |
| Edit & sign | **Edit & sign** | Add text, edit existing text, draw, highlight, white-out, rectangles, lines, arrows, check/cross marks, images and signatures (draw, type or upload). Undo/redo, zoom, keyboard shortcuts. |
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
