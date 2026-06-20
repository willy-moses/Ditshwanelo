function exportToPDF() {
  // Deduplicate by case number
  const seen = new Set();
  const uniqueCases = cases.filter(c => {
    if (seen.has(c.num)) return false;
    seen.add(c.num);
    return true;
  });

  if (uniqueCases.length === 0) { showToast('No cases to export', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const pw  = doc.internal.pageSize.getWidth();
  const ph  = doc.internal.pageSize.getHeight();
  const MARGIN  = 10;
  const cardW   = pw - MARGIN * 2;

  const NAVY  = [15, 37, 64];
  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];
  const LIGHT = [240, 240, 240];
  const CARD_GAP = 5;

  // Fixed row heights (rows 1 & 2)
  const headerH     = 6;
  const valueH      = 12;
  const row2HeaderH = 6;
  const row2ValueH  = 14;
  const row3HeaderH = 6;
  const MIN_ROW3_VALUE_H = 14;

  let y = MARGIN;

  // ── Helpers ──────────────────────────────────────────────

  function getLineCount(text, maxW, fontSize) {
    if (!text) return 1;
    doc.setFontSize(fontSize);
    return doc.splitTextToSize(String(text), maxW - 4).length;
  }

  function computeRow3ValueH(c) {
    const halfW    = cardW / 2;
    const lineH    = 7 * 0.45;
    const padding  = 5;
    const descLines  = getLineCount(c.desc,   halfW, 7);
    const assistLines = getLineCount(c.assist, halfW, 7);
    const needed = Math.max(descLines, assistLines) * lineH + padding;
    return Math.max(MIN_ROW3_VALUE_H, needed);
  }

  function computeCardHeight(c) {
    return headerH + valueH + row2HeaderH + row2ValueH + row3HeaderH + computeRow3ValueH(c);
  }

  function drawPageHeader() {
    doc.setFillColor(...NAVY);
    doc.rect(MARGIN, y, cardW, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...WHITE);
    doc.text('DITSHWANELO BOTSWANA — CASE REGISTER', pw / 2, y + 5.5, { align: 'center' });
    y += 11;
  }

  function drawFooter() {
    const total = doc.internal.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(120, 120, 120);
      doc.text(
        'Ditshwanelo Botswana · Confidential · Generated ' + new Date().toLocaleDateString('en-GB'),
        MARGIN, ph - 4
      );
      doc.text('Page ' + i + ' of ' + total, pw - MARGIN, ph - 4, { align: 'right' });
    }
  }

  function checkNewPage(neededH) {
    if (y + neededH > ph - 14) {
      doc.addPage();
      y = MARGIN;
      drawPageHeader();
    }
  }

  function drawCell(x, cellY, w, h, text, opts = {}) {
    doc.setDrawColor(...BLACK);
    doc.setLineWidth(0.3);

    if (opts.header) {
      doc.setFillColor(...LIGHT);
      doc.rect(x, cellY, w, h, 'FD');
    } else {
      doc.rect(x, cellY, w, h, 'S');
    }

    if (text === null || text === undefined || text === '') return;

    const pad      = 2;
    const fontSize = opts.fontSize || 7;
    doc.setFont('helvetica', opts.bold || opts.header ? 'bold' : 'normal');
    doc.setFontSize(fontSize);
    doc.setTextColor(...BLACK);

    const maxW      = w - pad * 2;
    const lines     = doc.splitTextToSize(String(text), maxW);
    const lineH     = fontSize * 0.45;
    const totalTextH = lines.length * lineH;

    // Top-align text in tall cells, centre in short ones
    const textY = h > 16
      ? cellY + pad + lineH
      : cellY + (h - totalTextH) / 2 + lineH * 0.85;

    doc.text(lines, x + pad, textY);
  }

  // ── Draw one case card ────────────────────────────────────

  function drawCaseCard(c, startY) {
    let cx;
    const row3ValueH = computeRow3ValueH(c);

    // ── ROW 1: headers ──
    const cols1 = (() => {
      const raw   = [22, 36, 22, 20, 22, 28, 28, 22];
      const total = raw.reduce((a, b) => a + b, 0);
      const scale = cardW / total;
      return raw.map(w => parseFloat((w * scale).toFixed(2)));
    })();

    const headers1 = ['CASE NO.', 'FULL NAMES', 'ID NO.', 'DOB', 'DATE OF CASE', 'VILLAGE', 'TYPE', 'STATUS'];
    const vals1    = [
      c.num       || '',
      c.name      || '',
      c.idNumber  || '',
      c.dob       || '',
      c.caseDate  || '',
      c.village   || '',
      c.type      || '',
      c.status    || ''
    ];

    cx = MARGIN;
    headers1.forEach((h, i) => {
      drawCell(cx, startY, cols1[i], headerH, h, { header: true, fontSize: 6 });
      cx += cols1[i];
    });
    cx = MARGIN;
    vals1.forEach((v, i) => {
      drawCell(cx, startY + headerH, cols1[i], valueH, v, { bold: i === 0, fontSize: 7 });
      cx += cols1[i];
    });

    // ── ROW 2: headers ──
    const cols2 = (() => {
      const raw   = [28, 32, 30, 50, 50];
      const total = raw.reduce((a, b) => a + b, 0);
      const scale = cardW / total;
      return raw.map(w => parseFloat((w * scale).toFixed(2)));
    })();

    const row2Y    = startY + headerH + valueH;
    const headers2 = ['TRIBE', 'EMPLOYMENT STATUS', 'CONTACTS', 'ADDRESS', 'OFFICER'];
    const vals2    = [
      c.tribe         || '',
      c.employStatus  || '',
      c.contacts      || '',
      c.address       || '',
      c.createdByName || ''
    ];

    cx = MARGIN;
    headers2.forEach((h, i) => {
      drawCell(cx, row2Y, cols2[i], row2HeaderH, h, { header: true, fontSize: 6 });
      cx += cols2[i];
    });
    cx = MARGIN;
    vals2.forEach((v, i) => {
      drawCell(cx, row2Y + row2HeaderH, cols2[i], row2ValueH, v, { fontSize: 7 });
      cx += cols2[i];
    });

    // ── ROW 3: Description & Assistance Given (dynamic height) ──
    const row3Y  = row2Y + row2HeaderH + row2ValueH;
    const halfW  = cardW / 2;

    drawCell(MARGIN,         row3Y, halfW, row3HeaderH, 'DESCRIPTION',     { header: true, fontSize: 6 });
    drawCell(MARGIN + halfW, row3Y, halfW, row3HeaderH, 'ASSISTANCE GIVEN', { header: true, fontSize: 6 });

    drawCell(MARGIN,         row3Y + row3HeaderH, halfW, row3ValueH, c.desc   || '', { fontSize: 7 });
    drawCell(MARGIN + halfW, row3Y + row3HeaderH, halfW, row3ValueH, c.assist || '', { fontSize: 7 });
  }

  // ── Build PDF ─────────────────────────────────────────────

  drawPageHeader();

  uniqueCases.forEach(c => {
    const cardH = computeCardHeight(c);
    checkNewPage(cardH + CARD_GAP);
    drawCaseCard(c, y);
    y += cardH + CARD_GAP;
  });

  drawFooter();
  doc.save('case_register_' + new Date().toISOString().slice(0, 10) + '.pdf');
  showToast('PDF exported', 'success');
}