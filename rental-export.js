(function () {
  'use strict';
  let busy = false;
  function verifyLayout(sheet) {
    if (!sheet || sheet.offsetWidth !== 794 || getComputedStyle(sheet).paddingLeft !== '30px') {
      throw new Error('确认单样式未完整加载，请刷新页面后重新导出。');
    }
  }
  async function canvasFor(html) {
    if (!window.html2canvas) throw new Error('图片导出组件未加载，请刷新后重试。');
    const stage = document.createElement('div');
    stage.className = 'rental-render-stage';
    stage.innerHTML = html;
    document.body.appendChild(stage);
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const sheet = stage.firstElementChild;
      verifyLayout(sheet);
      return await window.html2canvas(sheet, { scale: 2, backgroundColor: '#ffffff', logging: false, width: 794, height: sheet.offsetHeight, windowWidth: 1000, scrollX: 0, scrollY: 0 });
    } finally { stage.remove(); }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function readablePdfPages(data) {
    if (document.fonts?.ready) await document.fonts.ready;
    const stage = document.createElement('div');
    stage.className = 'rental-render-stage';document.body.appendChild(stage);
    try {
      for (let rows = 36; rows >= 1; rows--) {
        const pages = window.RentalDocument.pdfPages(data, rows);
        stage.innerHTML = pages.join('');
        [...stage.children].forEach(verifyLayout);
        // Keep printed 12px table text above 8pt, even for long vehicle/customer names.
        if ([...stage.children].every(sheet => sheet.offsetHeight <= 1180)) return pages;
      }
      throw new Error('确认单内容过长，请缩短车辆名称后重试。');
    } finally { stage.remove(); }
  }
  async function exportFile(result, format, isCurrent) {
    if (busy) return;
    busy = true;
    const status = document.getElementById('rental-export-status');
    const buttons = ['rental-png', 'rental-pdf'].map(id => document.getElementById(id));
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = '正在生成，请稍候…';
    try {
      const data = window.RentalDocument.customerData(result);
      let blob;
      if (format === 'png') {
        const canvas = await canvasFor(window.RentalDocument.documentHtml(data));
        blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败，请重试。')), 'image/png'));
        canvas.width = canvas.height = 0;
      } else {
        if (!window.jspdf?.jsPDF) throw new Error('PDF导出组件未加载，请刷新后重试。');
        const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
        const pages = await readablePdfPages(data);
        for (let index = 0; index < pages.length; index++) {
          const canvas = await canvasFor(pages[index]);
          if (index) pdf.addPage();
          const width = Math.min(200, 287 * canvas.width / canvas.height), height = width * canvas.height / canvas.width;
          pdf.addImage(canvas, 'PNG', (210 - width) / 2, 5, width, height, undefined, 'FAST');
          canvas.width = canvas.height = 0;
        }
        pdf.setProperties({ title: `车辆租赁付款计划确认单 ${data.schemeId}`, subject: '车辆租赁付款安排', creator: 'HOKU MOTORS / 好车库' });
        blob = pdf.output('blob');
      }
      if (!isCurrent()) throw new Error('方案已变更，未下载旧确认单。请重新生成。');
      download(blob, `车辆租赁付款计划确认单_${data.schemeId}.${format}`);
      status.textContent = `${format.toUpperCase()}已生成并发起下载。请在浏览器下载记录或文件管理中确认文件；微信内无法下载时，请在系统浏览器打开。`;
    } catch (error) {
      status.textContent = `导出未完成：${error.message || '请重试。'}`;
    } finally {
      busy = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  window.RentalExport = { exportFile };
})();
