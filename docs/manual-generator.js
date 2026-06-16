/**
 * Linked Lamp — Personalized Manual Generator
 * 
 * Overlays user-specific data (name, UID string, QR code) onto the
 * "Linked Lamp.pdf" template and triggers a download of the personalized PDF.
 *
 * Dependencies (loaded via CDN before this script):
 *   - pdf-lib  (https://pdf-lib.js.org/)
 *   - qrcode-generator  (https://github.com/kazuhikoarase/qrcode-generator)
 *
 * License: GNU GPLv3
 */
(function () {
    'use strict';

    // =========================================================================
    // Template path (relative to the HTML page that loads this script)
    // =========================================================================
    const TEMPLATE_PDF_PATH = 'Linked%20Lamp.pdf';

    // =========================================================================
    // Layout Configuration
    // =========================================================================
    // Coordinate system: PDF standard — origin at bottom-left, y increases UP.
    // The TOP HALF of the page is printed upside-down (rotated 180°).
    //
    //  ADJUSTING POSITIONS
    //  ────────────────────
    //  • Increase x → element moves RIGHT on the physical page.
    //  • Increase y → element moves UP on the physical page.
    //  • All upside-down elements use  rotate: degrees(180).
    //    With 180° rotation the text anchor is the first character's origin
    //    and the string extends to the LEFT in physical page coordinates.
    // =========================================================================

    const LAYOUT = {
        // ── "User: [name]" ──────────────────────────────────────────────
        userName: {
            centerX: 98.65,   // center under "Setup & Usage Manual"
            centerY: 568,     // vertical centre
            fontSize: 11,
            // White rectangle to cover the existing "User:" text
            clearRect: { x: 20, y: 555, width: 160, height: 26 },
        },

        // ── UID string in the grey box ──────────────────────────────────
        uidBox: {
            centerX: 493,     // horizontal centre of the grey box
            centerY: 423,     // vertical centre of the grey box
            maxWidth: 155,    // max text width  (pts)
            maxHeight: 60,    // max text height (pts)
        },

        // ── QR code ─────────────────────────────────────────────────────
        qrCode: {
            centerX: 501,     // horizontal centre
            centerY: 526,     // vertical centre
            size: 74,         // width = height  (pts)
            bgPadding: 4,     // extra white padding around the QR image
        },
    };

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Generate and download a personalised manual PDF.
     *
     * @param {string} userName  Display name (e.g. "Alice")
     * @param {string} uid       Base64url UID string (≈80–160 chars)
     */
    async function generateManual(userName, uid) {
        /* ── guard: libraries loaded? ── */
        if (typeof PDFLib === 'undefined') {
            throw new Error('pdf-lib is not loaded. Add the CDN script tag.');
        }
        if (typeof qrcode === 'undefined') {
            throw new Error('qrcode-generator is not loaded. Add the CDN script tag.');
        }

        const { PDFDocument, rgb, StandardFonts, degrees } = PDFLib;

        /* ── load the template PDF ── */
        const resp = await fetch(TEMPLATE_PDF_PATH);
        if (!resp.ok) throw new Error('Could not fetch the template PDF (' + resp.status + ')');
        const templateBytes = await resp.arrayBuffer();

        const pdfDoc = await PDFDocument.load(templateBytes);
        const page   = pdfDoc.getPages()[0];
        const { width: pageW, height: pageH } = page.getSize();

        /* ── embed standard fonts ── */
        const courierFont       = await pdfDoc.embedFont(StandardFonts.Courier);
        const helveticaBoldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        /* ── 1. User name ── */
        _drawUserName(page, userName, helveticaBoldFont);

        /* ── 2. UID in grey box ── */
        _drawUID(page, uid, courierFont);

        /* ── 3. QR code ── */
        await _drawQRCode(page, pdfDoc, uid);

        /* ── save & download ── */
        const pdfBytes = await pdfDoc.save();
        _download(pdfBytes, 'Linked Lamp - ' + userName + '.pdf');
    }

    // =========================================================================
    // Internal drawing helpers
    // =========================================================================

    /** White-out existing "User:" label and redraw "User: <name>" */
    function _drawUserName(page, name, font) {
        const { rgb, degrees } = PDFLib;
        const cfg = LAYOUT.userName;
        const cr  = cfg.clearRect;

        // White-out
        page.drawRectangle({
            x: cr.x, y: cr.y, width: cr.width, height: cr.height,
            color: rgb(1, 1, 1), borderWidth: 0,
        });

        // Re-draw with name centered
        const fullText = 'User: ' + name;
        const textW = font.widthOfTextAtSize(fullText, cfg.fontSize);
        
        // 180° rotation anchor is top-right, so x = centerX + width / 2
        // For vertical center, visual top is the anchor, so y = centerY + height / 2.
        // Approximate text height is 0.7 * fontSize
        const textH = cfg.fontSize * 0.7;

        page.drawText(fullText, {
            x: cfg.centerX + textW / 2,
            y: cfg.centerY + textH / 2,
            size: cfg.fontSize,
            font: font,
            color: rgb(0, 0, 0),
            rotate: degrees(180),
        });
    }

    /** Draw the UID string centred inside the grey box, monospace, wrapped. */
    function _drawUID(page, uid, font) {
        const { rgb, degrees } = PDFLib;
        const cfg      = LAYOUT.uidBox;
        const uidLen   = uid.length;

        // ── choose best wrapping ──
        // Prefer even line-count divisors for clean wrapping.
        const preferred = [5, 4, 6, 3, 2, 8];
        let charsPerLine = Math.ceil(uidLen / 5);
        let fontSize     = 8;
        let lineCount    = 5;

        for (const lc of preferred) {
            const cpl  = Math.ceil(uidLen / lc);
            const cw   = cfg.maxWidth / cpl;
            const fsW  = cw / 0.6;                  // max font size by width
            const fsH  = cfg.maxHeight / (lc * 1.35); // max font size by height
            const fs   = Math.min(fsW, fsH);        // take the smaller to ensure it fits both
            
            if (fs >= 4.5 && fs <= 12) {
                lineCount    = lc;
                charsPerLine = cpl;
                fontSize     = fs;
                break;
            }
        }

        const lineHeight = fontSize * 1.35;

        // ── split UID into lines ──
        const lines = [];
        for (let i = 0; i < uidLen; i += charsPerLine) {
            lines.push(uid.substring(i, i + charsPerLine));
        }

        const totalH = lines.length * lineHeight;

        // ── draw each line ──
        lines.forEach(function (line, idx) {
            var lineW = font.widthOfTextAtSize(line, fontSize);

            // Centre-align with 180° rotation:
            //   anchor x = centerX + lineWidth / 2  (text extends LEFT)
            var textX = cfg.centerX + lineW / 2;

            // Calculate startY so the entire block is centered around centerY
            // Span of block is [startY - fontSize, startY + (lineCount - 1) * lineHeight]
            var startY = cfg.centerY - ((lineCount - 1) / 2) * lineHeight + (fontSize / 2);
            var textY  = startY + (idx * lineHeight);

            page.drawText(line, {
                x: textX, y: textY,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0),
                rotate: degrees(180),
            });
        });
    }

    /** Generate a QR code from the UID URL and embed it into the page. */
    async function _drawQRCode(page, pdfDoc, uid) {
        const { rgb, degrees } = PDFLib;
        const cfg = LAYOUT.qrCode;

        var url = 'https://www.linkedlamp.com/my/index.html?uid=' + uid;

        // ── render QR to a PNG via <canvas> ──
        var pngBytes = _renderQRtoPNG(url);
        var qrImage  = await pdfDoc.embedPng(pngBytes);

        // ── white background (covers any placeholder in the template) ──
        var bg = cfg.size + cfg.bgPadding * 2;
        page.drawRectangle({
            x: cfg.centerX - bg / 2,
            y: cfg.centerY - bg / 2,
            width: bg, height: bg,
            color: rgb(1, 1, 1), borderWidth: 0,
        });

        // ── draw QR image, rotated 180° ──
        // For 180° rotation centred at (cx, cy):
        //   anchor = (cx + size/2,  cy + size/2)
        page.drawImage(qrImage, {
            x: cfg.centerX + cfg.size / 2,
            y: cfg.centerY + cfg.size / 2,
            width:  cfg.size,
            height: cfg.size,
            rotate: degrees(180),
        });
    }

    // =========================================================================
    // QR rendering (qrcode-generator → Canvas → PNG bytes)
    // =========================================================================

    function _renderQRtoPNG(text) {
        var qr = qrcode(0, 'M');   // auto version, medium error-correction
        qr.addData(text);
        qr.make();

        var cellSize    = 4;
        var margin      = 2;                       // modules of white padding
        var moduleCount = qr.getModuleCount();
        var imageSize   = (moduleCount + margin * 2) * cellSize;

        var canvas = document.createElement('canvas');
        canvas.width  = imageSize;
        canvas.height = imageSize;
        var ctx = canvas.getContext('2d');

        // White background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, imageSize, imageSize);

        // Dark modules
        ctx.fillStyle = '#000000';
        for (var r = 0; r < moduleCount; r++) {
            for (var c = 0; c < moduleCount; c++) {
                if (qr.isDark(r, c)) {
                    ctx.fillRect(
                        (c + margin) * cellSize,
                        (r + margin) * cellSize,
                        cellSize, cellSize
                    );
                }
            }
        }

        // Convert canvas → PNG Uint8Array
        var dataUrl = canvas.toDataURL('image/png');
        var b64     = dataUrl.split(',')[1];
        var bin     = atob(b64);
        var bytes   = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    // =========================================================================
    // Download helper
    // =========================================================================

    function _download(bytes, filename) {
        var blob = new Blob([bytes], { type: 'application/pdf' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    // =========================================================================
    // Export
    // =========================================================================
    window.LinkedLampManual = { generateManual: generateManual };

})();
