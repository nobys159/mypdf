# PDF App Prototype

This prototype is an Electron-based PDF viewer using PDF.js. It now supports opening PDF files, paging through them, zooming, drawing a handwritten signature, placing that signature on a page, and exporting a new signed PDF.

Run:

```powershell
npm install
npm start
```

Notes:
- The signing flow here is a visual signature stamp, not a cryptographic certificate-based digital signature.
- OCR support is still available in the dependencies, but the current UI focuses on open, view, sign, and save.
