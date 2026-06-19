const vscode = require('vscode');
const QRCode = require('qrcode');
const JsBarcode = require('jsbarcode');
const fs = require('fs/promises');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMMAND_ID = 'barcodeGenerator.generateFromSelection';
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 36;
const MAX_CODES_PER_PAGE = 60;

function activate(context) {
  const disposable = vscode.commands.registerCommand(COMMAND_ID, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found.');
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection).trim();

    if (!selectedText) {
      vscode.window.showErrorMessage('Please select text to generate a barcode.');
      return;
    }

    const selectedCodes = getSelectedCodeLines(selectedText);
    if (selectedCodes.length > 1) {
      await exportBarcodeListFromSelection(selectedCodes);
      return;
    }

    const decision = await resolveBarcodeType(selectedText);
    if (!decision) {
      return;
    }

    await openBarcodeWebview(context, decision);
  });

  context.subscriptions.push(disposable);
}

/**
 * @param {string} value
 * @returns {Promise<{ type: 'ean13'|'code128'|'qrcode', value: string, label: string } | null>}
 */
async function resolveBarcodeType(value) {
  const ean13 = resolveEan13Value(value);
  if (ean13) {
    if (ean13.error) {
      vscode.window.showErrorMessage(ean13.error);
      return null;
    }

    if (ean13.addedCheckDigit) {
      vscode.window.showInformationMessage(`EAN13 generated with check digit: ${ean13.value}`);
    }

    return {
      type: 'ean13',
      value: ean13.value,
      label: 'EAN13'
    };
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Code 128', type: 'code128' },
      { label: 'QR Code', type: 'qrcode' }
    ],
    {
      title: 'Choose barcode format',
      placeHolder: 'Selected content is not EAN13 numeric'
    }
  );

  if (!picked) {
    return null;
  }

  return {
    type: picked.type,
    value,
    label: picked.label
  };
}

/**
 * @param {string} text
 */
function getSelectedCodeLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} values
 */
async function exportBarcodeListFromSelection(values) {
  const list = await resolveBarcodeList(values);
  if (!list) {
    return;
  }

  const codesPerPage = await askCodesPerPage(values.length);
  if (!codesPerPage) {
    return;
  }

  const saveUri = await showPdfSaveDialog('Export Barcode List as PDF', 'barcodes.pdf');
  if (!saveUri) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating barcode PDF',
        cancellable: false
      },
      async (progress) => {
        await exportBarcodeListPdf(list.items, codesPerPage, saveUri, progress);
      }
    );

    const checkDigitMessage = list.addedCheckDigits > 0
      ? `${list.addedCheckDigits} EAN13 check digit${list.addedCheckDigits > 1 ? 's' : ''} added.`
      : '';
    const exportedMessage = `PDF exported: ${saveUri.fsPath}`;
    vscode.window.showInformationMessage(checkDigitMessage ? `${exportedMessage}. ${checkDigitMessage}` : exportedMessage);
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to export barcode list PDF: ${String(error)}`);
  }
}

/**
 * @param {string[]} values
 * @returns {Promise<{ items: Array<{ type: 'ean13'|'code128'|'qrcode', value: string, label: string }>, addedCheckDigits: number } | null>}
 */
async function resolveBarcodeList(values) {
  const ean13Values = values.map(resolveEan13Value);
  const allValuesAreEan13Candidates = ean13Values.every(Boolean);

  if (allValuesAreEan13Candidates) {
    const invalidIndex = ean13Values.findIndex((result) => result.error);
    if (invalidIndex !== -1) {
      vscode.window.showErrorMessage(`Invalid EAN13 at item ${invalidIndex + 1}: check digit parity is incorrect.`);
      return null;
    }

    return {
      items: ean13Values.map((result) => ({
        type: 'ean13',
        value: result.value,
        label: 'EAN13'
      })),
      addedCheckDigits: ean13Values.filter((result) => result.addedCheckDigit).length
    };
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Code 128', type: 'code128' },
      { label: 'QR Code', type: 'qrcode' }
    ],
    {
      title: 'Choose barcode format for the selected list',
      placeHolder: 'The selected list is not entirely EAN13 numeric'
    }
  );

  if (!picked) {
    return null;
  }

  return {
    items: values.map((value) => ({
      type: picked.type,
      value,
      label: picked.label
    })),
    addedCheckDigits: 0
  };
}

/**
 * @param {number} total
 */
async function askCodesPerPage(total) {
  const input = await vscode.window.showInputBox({
    title: 'Barcode list PDF layout',
    prompt: `How many barcodes per page? ${total} selected.`,
    placeHolder: 'For example: 8',
    value: String(Math.min(total, 8)),
    validateInput(value) {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) {
        return 'Enter a whole number.';
      }

      const number = Number(trimmed);
      if (number < 1 || number > MAX_CODES_PER_PAGE) {
        return `Enter a number between 1 and ${MAX_CODES_PER_PAGE}.`;
      }

      return null;
    }
  });

  if (!input) {
    return null;
  }

  return Number(input.trim());
}

/**
 * @param {string} value
 * @returns {{ value: string, addedCheckDigit: boolean, error?: string } | null}
 */
function resolveEan13Value(value) {
  if (/^\d{12}$/.test(value)) {
    return {
      value: `${value}${computeEan13CheckDigit(value)}`,
      addedCheckDigit: true
    };
  }

  if (/^\d{13}$/.test(value)) {
    if (!isValidEan13(value)) {
      return {
        value,
        addedCheckDigit: false,
        error: 'Invalid EAN13: check digit parity is incorrect. Generation is not possible.'
      };
    }

    return {
      value,
      addedCheckDigit: false
    };
  }

  return null;
}

/**
 * @param {string} base12
 */
function computeEan13CheckDigit(base12) {
  let sum = 0;
  for (let i = 0; i < base12.length; i += 1) {
    const digit = Number(base12[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

/**
 * @param {string} full13
 */
function isValidEan13(full13) {
  const expected = computeEan13CheckDigit(full13.slice(0, 12));
  return Number(full13[12]) === expected;
}

async function openBarcodeWebview(context, payload) {
  const jsBarcodePath = vscode.Uri.joinPath(
    context.extensionUri,
    'node_modules',
    'jsbarcode',
    'dist',
    'JsBarcode.all.min.js'
  );

  let qrCodeDataUrl = '';
  if (payload.type === 'qrcode') {
    try {
      qrCodeDataUrl = await QRCode.toDataURL(payload.value, {
        width: 280,
        margin: 1
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to generate QR Code: ${String(error)}`);
      return;
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'barcodeGenerator.preview',
    `Barcode Preview: ${payload.label}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'node_modules')
      ]
    }
  );

  panel.webview.html = getWebviewHtml(
    payload,
    panel.webview.asWebviewUri(jsBarcodePath),
    qrCodeDataUrl
  );
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message) {
      return;
    }

    if (message.type === 'export-pdf') {
      if (typeof message.dataUrl !== 'string' || !message.dataUrl.startsWith('data:image/png;base64,')) {
        vscode.window.showErrorMessage('Unable to export PDF: invalid image data.');
        return;
      }

      await exportPdfFromPngDataUrl(message.dataUrl);
    }
  });
}

async function exportPdfFromPngDataUrl(dataUrl) {
  const saveUri = await showPdfSaveDialog('Export Barcode as PDF', 'barcode.pdf');
  if (!saveUri) {
    return;
  }

  try {
    const pngBytes = dataUrlToBytes(dataUrl);
    const pdf = await PDFDocument.create();
    const pngImage = await pdf.embedPng(pngBytes);

    const page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
    const maxWidth = A4_WIDTH - PAGE_MARGIN * 2;
    const maxHeight = A4_HEIGHT - PAGE_MARGIN * 2;
    const scale = Math.min(maxWidth / pngImage.width, maxHeight / pngImage.height, 1);
    const drawWidth = pngImage.width * scale;
    const drawHeight = pngImage.height * scale;
    const x = (A4_WIDTH - drawWidth) / 2;
    const y = (A4_HEIGHT - drawHeight) / 2;

    page.drawImage(pngImage, { x, y, width: drawWidth, height: drawHeight });

    const pdfBytes = await pdf.save();
    await fs.writeFile(saveUri.fsPath, Buffer.from(pdfBytes));
    vscode.window.showInformationMessage(`PDF exported: ${saveUri.fsPath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to export PDF: ${String(error)}`);
  }
}

/**
 * @param {string} title
 * @param {string} defaultFileName
 */
async function showPdfSaveDialog(title, defaultFileName) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const defaultUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, defaultFileName)
    : undefined;

  return await vscode.window.showSaveDialog({
    title,
    filters: { PDF: ['pdf'] },
    saveLabel: 'Export PDF',
    defaultUri
  });
}

/**
 * @param {Array<{ type: 'ean13'|'code128'|'qrcode', value: string, label: string }>} items
 * @param {number} codesPerPage
 * @param {vscode.Uri} saveUri
 * @param {{ report: (value: { message?: string, increment?: number }) => void }} progress
 */
async function exportBarcodeListPdf(items, codesPerPage, saveUri, progress) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const grid = getBestGrid(codesPerPage, A4_WIDTH - PAGE_MARGIN * 2, A4_HEIGHT - PAGE_MARGIN * 2);

  for (let index = 0; index < items.length; index += 1) {
    if (index % codesPerPage === 0) {
      pdf.addPage([A4_WIDTH, A4_HEIGHT]);
    }

    const page = pdf.getPages()[pdf.getPageCount() - 1];
    const slot = index % codesPerPage;
    await drawBarcodeListItem(pdf, page, items[index], slot, grid, font);
    progress.report({ message: `${index + 1}/${items.length}` });
  }

  const pdfBytes = await pdf.save();
  await fs.writeFile(saveUri.fsPath, Buffer.from(pdfBytes));
}

/**
 * @param {number} itemCount
 * @param {number} usableWidth
 * @param {number} usableHeight
 */
function getBestGrid(itemCount, usableWidth, usableHeight) {
  const targetRatio = 2.2;
  let best = {
    columns: 1,
    rows: itemCount,
    score: Number.POSITIVE_INFINITY
  };

  for (let columns = 1; columns <= itemCount; columns += 1) {
    const rows = Math.ceil(itemCount / columns);
    const cellRatio = (usableWidth / columns) / (usableHeight / rows);
    const emptySlots = columns * rows - itemCount;
    const score = Math.abs(Math.log(cellRatio / targetRatio)) + emptySlots * 0.03 + columns * 0.01;

    if (score < best.score) {
      best = { columns, rows, score };
    }
  }

  return best;
}

/**
 * @param {PDFDocument} pdf
 * @param {import('pdf-lib').PDFPage} page
 * @param {{ type: 'ean13'|'code128'|'qrcode', value: string, label: string }} item
 * @param {number} slot
 * @param {{ columns: number, rows: number }} grid
 * @param {import('pdf-lib').PDFFont} font
 */
async function drawBarcodeListItem(pdf, page, item, slot, grid, font) {
  const usableWidth = A4_WIDTH - PAGE_MARGIN * 2;
  const usableHeight = A4_HEIGHT - PAGE_MARGIN * 2;
  const cellWidth = usableWidth / grid.columns;
  const cellHeight = usableHeight / grid.rows;
  const column = slot % grid.columns;
  const row = Math.floor(slot / grid.columns);
  const x = PAGE_MARGIN + column * cellWidth;
  const y = A4_HEIGHT - PAGE_MARGIN - (row + 1) * cellHeight;

  if (item.type === 'qrcode') {
    await drawQrCodePdfItem(pdf, page, item, x, y, cellWidth, cellHeight, font);
    return;
  }

  drawLinearBarcodePdfItem(page, item, x, y, cellWidth, cellHeight, font);
}

/**
 * @param {import('pdf-lib').PDFPage} page
 * @param {{ type: 'ean13'|'code128', value: string, label: string }} item
 * @param {number} x
 * @param {number} y
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @param {import('pdf-lib').PDFFont} font
 */
function drawLinearBarcodePdfItem(page, item, x, y, cellWidth, cellHeight, font) {
  const padding = Math.min(12, cellWidth * 0.08, cellHeight * 0.12);
  const maxLabelWidth = cellWidth - padding * 2;
  const displayLabel = getPdfSafeLabel(item.value);
  const labelSize = fitTextSize(font, displayLabel, Math.min(12, Math.max(7, cellHeight * 0.09)), 5, maxLabelWidth);
  const label = fitText(font, displayLabel, labelSize, maxLabelWidth);
  const barcodeMaxHeight = Math.max(18, cellHeight - padding * 2 - labelSize - 8);
  const barcodeHeight = Math.min(92, barcodeMaxHeight);
  const contentHeight = barcodeHeight + labelSize + 8;
  const bottomY = y + (cellHeight - contentHeight) / 2;
  const barcodeY = bottomY + labelSize + 8;
  const binary = getBarcodeBinary(item);
  const moduleWidth = (cellWidth - padding * 2) / binary.length;
  const barcodeWidth = moduleWidth * binary.length;
  const barcodeX = x + (cellWidth - barcodeWidth) / 2;

  drawBarcodeBinary(page, binary, barcodeX, barcodeY, moduleWidth, barcodeHeight);
  drawCenteredText(page, label, x, bottomY, cellWidth, labelSize, font);
}

/**
 * @param {PDFDocument} pdf
 * @param {import('pdf-lib').PDFPage} page
 * @param {{ type: 'qrcode', value: string, label: string }} item
 * @param {number} x
 * @param {number} y
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @param {import('pdf-lib').PDFFont} font
 */
async function drawQrCodePdfItem(pdf, page, item, x, y, cellWidth, cellHeight, font) {
  const padding = Math.min(12, cellWidth * 0.08, cellHeight * 0.12);
  const maxLabelWidth = cellWidth - padding * 2;
  const displayLabel = getPdfSafeLabel(item.value);
  const labelSize = fitTextSize(font, displayLabel, Math.min(12, Math.max(7, cellHeight * 0.09)), 5, maxLabelWidth);
  const label = fitText(font, displayLabel, labelSize, maxLabelWidth);
  const qrDataUrl = await QRCode.toDataURL(item.value, {
    width: 512,
    margin: 1
  });
  const qrImage = await pdf.embedPng(dataUrlToBytes(qrDataUrl));
  const maxQrSize = Math.max(18, cellHeight - padding * 2 - labelSize - 8);
  const qrSize = Math.min(cellWidth - padding * 2, maxQrSize, 220);
  const contentHeight = qrSize + labelSize + 8;
  const bottomY = y + (cellHeight - contentHeight) / 2;
  const qrX = x + (cellWidth - qrSize) / 2;
  const qrY = bottomY + labelSize + 8;

  page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  drawCenteredText(page, label, x, bottomY, cellWidth, labelSize, font);
}

/**
 * @param {{ type: 'ean13'|'code128', value: string, label: string }} item
 */
function getBarcodeBinary(item) {
  const barcode = {};
  const format = item.type === 'ean13' ? 'EAN13' : 'CODE128';

  try {
    JsBarcode(barcode, item.value, {
      format,
      displayValue: false,
      margin: 0,
      width: 1,
      height: 100
    });
  } catch (error) {
    throw new Error(`Invalid ${item.label} value "${item.value}": ${String(error)}`);
  }

  if (!Array.isArray(barcode.encodings)) {
    throw new Error(`Unable to encode ${item.label} value "${item.value}".`);
  }

  const binary = barcode.encodings.map((encoding) => encoding.data || '').join('');
  if (!/^[01]+$/.test(binary)) {
    throw new Error(`Unable to encode ${item.label} value "${item.value}".`);
  }

  return binary;
}

/**
 * @param {import('pdf-lib').PDFPage} page
 * @param {string} binary
 * @param {number} x
 * @param {number} y
 * @param {number} moduleWidth
 * @param {number} height
 */
function drawBarcodeBinary(page, binary, x, y, moduleWidth, height) {
  let runStart = null;

  for (let index = 0; index <= binary.length; index += 1) {
    if (binary[index] === '1' && runStart === null) {
      runStart = index;
      continue;
    }

    if ((binary[index] !== '1' || index === binary.length) && runStart !== null) {
      page.drawRectangle({
        x: x + runStart * moduleWidth,
        y,
        width: (index - runStart) * moduleWidth,
        height,
        color: rgb(0, 0, 0)
      });
      runStart = null;
    }
  }
}

/**
 * @param {import('pdf-lib').PDFPage} page
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} size
 * @param {import('pdf-lib').PDFFont} font
 */
function drawCenteredText(page, text, x, y, width, size, font) {
  const textWidth = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: x + (width - textWidth) / 2,
    y,
    size,
    font,
    color: rgb(0, 0, 0)
  });
}

/**
 * @param {import('pdf-lib').PDFFont} font
 * @param {string} text
 * @param {number} preferredSize
 * @param {number} minSize
 * @param {number} maxWidth
 */
function fitTextSize(font, text, preferredSize, minSize, maxWidth) {
  let size = preferredSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return Math.max(minSize, size);
}

/**
 * @param {import('pdf-lib').PDFFont} font
 * @param {string} text
 * @param {number} size
 * @param {number} maxWidth
 */
function fitText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }

  const suffix = '...';
  let end = text.length;
  while (end > suffix.length && font.widthOfTextAtSize(`${text.slice(0, end)}${suffix}`, size) > maxWidth) {
    end -= 1;
  }

  return end > suffix.length ? `${text.slice(0, end)}${suffix}` : suffix;
}

/**
 * @param {string} value
 */
function getPdfSafeLabel(value) {
  const printable = value.replace(/[^\x20-\x7E]/g, '?');
  return printable || '[encoded value]';
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function getWebviewHtml(payload, jsBarcodeUri, qrCodeDataUrl) {
  const safeType = escapeHtml(payload.type);
  const safeLabel = escapeHtml(payload.label);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Barcode Preview</title>
  <style>
    :root {
      --bg: #f6f7fb;
      --panel: #ffffff;
      --text: #1d2430;
      --muted: #5f6b7a;
      --accent: #126fd6;
      --border: #d8deea;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif;
      background: linear-gradient(140deg, #eef2ff, #f6f7fb 50%, #eefaf2);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.4rem;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .actions {
      margin-top: 18px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: none;
      background: var(--accent);
      color: #fff;
      padding: 10px 14px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 0.92rem;
    }
    #barcode-zone {
      margin-top: 26px;
      padding: 18px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      background: #fff;
      display: grid;
      gap: 12px;
      justify-items: center;
      cursor: pointer;
    }
    .hint {
      margin-top: 10px;
      font-size: 0.85rem;
      color: var(--muted);
    }
    #toast {
      position: fixed;
      top: 18px;
      right: 18px;
      background: #1f2937;
      color: #fff;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.85rem;
      opacity: 0;
      transform: translateY(-8px);
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${safeLabel} Preview</h1>
    <p>Selected value rendered as a barcode.</p>

    <div class="actions">
      <button id="export-pdf-btn" type="button">Export PDF</button>
    </div>

    <div id="barcode-zone">
      <svg id="barcode"></svg>
      <img id="qr-image" alt="QR Code" />
    </div>
    <p class="hint">Click the barcode image to copy it to clipboard.</p>
  </div>
  <div id="toast"></div>

  <script src="${jsBarcodeUri}"></script>
  <script>
    const payload = {
      type: '${safeType}',
      value: '${jsStringEscape(payload.value)}'
    };

    const vscodeApi = acquireVsCodeApi();
    const barcodeSvg = document.getElementById('barcode');
    const qrImage = document.getElementById('qr-image');
    const barcodeZone = document.getElementById('barcode-zone');
    const exportPdfBtn = document.getElementById('export-pdf-btn');
    const toast = document.getElementById('toast');
    let toastTimer = null;

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
      }, 1200);
    }

    function canvasToBlob(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
            return;
          }
          reject(new Error('Unable to convert canvas to image.'));
        }, 'image/png');
      });
    }

    async function svgToPngBlob(svgElement) {
      const svgRect = svgElement.getBoundingClientRect();
      const width = Math.max(Math.ceil(svgRect.width), 640);
      const height = Math.max(Math.ceil(svgRect.height), 180);
      const serialized = new XMLSerializer().serializeToString(svgElement);
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl = URL.createObjectURL(svgBlob);

      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Unable to render SVG as image.'));
          img.src = svgUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        return await canvasToBlob(canvas);
      } finally {
        URL.revokeObjectURL(svgUrl);
      }
    }

    async function getCurrentBarcodePngBlob() {
      if (payload.type === 'qrcode') {
        const response = await fetch(qrImage.src);
        return await response.blob();
      }

      return await svgToPngBlob(barcodeSvg);
    }

    async function copyBarcodeImageToClipboard() {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        showToast('Clipboard image copy not supported');
        return;
      }

      try {
        const blob = await getCurrentBarcodePngBlob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Copied to clipboard');
      } catch (_error) {
        showToast('Copy failed');
      }
    }

    async function getCurrentBarcodeDataUrl() {
      const blob = await getCurrentBarcodePngBlob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Unable to read image.'));
        reader.readAsDataURL(blob);
      });
    }

    function render() {
      try {
        if (payload.type === 'qrcode') {
          barcodeSvg.style.display = 'none';
          qrImage.style.display = 'block';
          qrImage.src = '${jsStringEscape(qrCodeDataUrl)}';
          return;
        }

        qrImage.style.display = 'none';
        barcodeSvg.style.display = 'block';

        const format = payload.type === 'ean13' ? 'EAN13' : 'CODE128';
        JsBarcode('#barcode', payload.value, {
          format,
          width: 2,
          height: 120,
          displayValue: true,
          margin: 10
        });
      } catch (error) {
        document.getElementById('barcode-zone').innerHTML = '<p>Failed to render barcode: ' + String(error) + '</p>';
      }
    }

    barcodeZone.addEventListener('click', () => {
      copyBarcodeImageToClipboard();
    });

    exportPdfBtn.addEventListener('click', async () => {
      try {
        const dataUrl = await getCurrentBarcodeDataUrl();
        vscodeApi.postMessage({ type: 'export-pdf', dataUrl });
      } catch (_error) {
        showToast('Export PDF failed');
      }
    });
    render();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsStringEscape(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
