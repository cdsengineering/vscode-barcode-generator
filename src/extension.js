const vscode = require('vscode');
const QRCode = require('qrcode');
const fs = require('fs/promises');
const { PDFDocument } = require('pdf-lib');

const COMMAND_ID = 'barcodeGenerator.generateFromSelection';

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
  if (/^\d{12}$/.test(value)) {
    const completed = `${value}${computeEan13CheckDigit(value)}`;
    vscode.window.showInformationMessage(`EAN13 generated with check digit: ${completed}`);
    return {
      type: 'ean13',
      value: completed,
      label: 'EAN13'
    };
  }

  if (/^\d{13}$/.test(value)) {
    if (!isValidEan13(value)) {
      vscode.window.showErrorMessage('Invalid EAN13: check digit parity is incorrect. Generation is not possible.');
      return null;
    }

    return {
      type: 'ean13',
      value,
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
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const defaultUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, 'barcode.pdf')
    : undefined;

  const saveUri = await vscode.window.showSaveDialog({
    title: 'Export Barcode as PDF',
    filters: { PDF: ['pdf'] },
    saveLabel: 'Export PDF',
    defaultUri
  });

  if (!saveUri) {
    return;
  }

  try {
    const pngBytes = dataUrlToBytes(dataUrl);
    const pdf = await PDFDocument.create();
    const pngImage = await pdf.embedPng(pngBytes);

    const a4Width = 595.28;
    const a4Height = 841.89;
    const page = pdf.addPage([a4Width, a4Height]);
    const margin = 36;
    const maxWidth = a4Width - margin * 2;
    const maxHeight = a4Height - margin * 2;
    const scale = Math.min(maxWidth / pngImage.width, maxHeight / pngImage.height, 1);
    const drawWidth = pngImage.width * scale;
    const drawHeight = pngImage.height * scale;
    const x = (a4Width - drawWidth) / 2;
    const y = (a4Height - drawHeight) / 2;

    page.drawImage(pngImage, { x, y, width: drawWidth, height: drawHeight });

    const pdfBytes = await pdf.save();
    await fs.writeFile(saveUri.fsPath, Buffer.from(pdfBytes));
    vscode.window.showInformationMessage(`PDF exported: ${saveUri.fsPath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to export PDF: ${String(error)}`);
  }
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
