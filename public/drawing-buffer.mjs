// Reuse the vector drawing's own paint order and styles to build gesture previews.
export function createDrawingBuffer(canvas, viewport, world) {
  const context = canvas.getContext('2d');
  let source, overview, detail, revision = 0, overviewTimer, detailTimer;

  async function capture(view, markup) {
    const scale = Math.min(viewport.clientWidth * 2 * Math.min(devicePixelRatio, 2) / view.width,
      2560 / Math.max(view.width, view.height));
    const width = Math.max(1, Math.round(view.width * scale));
    const height = Math.max(1, Math.round(view.height * scale));
    const url = URL.createObjectURL(new Blob([
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" preserveAspectRatio="none"
        font-family="Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, Arial, sans-serif" xml:space="preserve"
        viewBox="${view.x} ${view.y} ${view.width} ${view.height}">`, markup, '</svg>',
    ], { type: 'image/svg+xml' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { view, bitmap: await createImageBitmap(image) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function reset(view) {
    const version = ++revision;
    clearTimeout(overviewTimer);
    clearTimeout(detailTimer);
    overview?.bitmap.close();
    detail?.bitmap.close();
    source = overview = detail = undefined;
    if (!context || !view) return;
    overviewTimer = setTimeout(async () => {
      // SVG images inherit the host's CSP. Presentation attributes preserve
      // the drawing under style-src 'self' without an inline stylesheet.
      const snapshot = world.cloneNode(true);
      const background = getComputedStyle(viewport).getPropertyValue('--drawing-background').trim();
      for (const element of snapshot.querySelectorAll('.layer-off')) element.setAttribute('display', 'none');
      for (const element of snapshot.querySelectorAll('.wipeout-fill')) element.setAttribute('fill', background);
      source = new Blob([snapshot.outerHTML]);
      try {
        const image = await capture(view, source);
        if (version === revision) overview = image;
        else image.bitmap.close();
      } catch {
        // The live SVG remains available if rasterization is unsupported.
      }
    }, 60);
  }

  function cancelDetail() {
    clearTimeout(detailTimer);
  }

  function prepareDetail(view) {
    cancelDetail();
    if (!overview || view.width * 1.5 >= overview.view.width) return;
    const cached = detail?.view;
    if (cached && view.width >= cached.width / 2.5 && view.width <= cached.width &&
        view.x >= cached.x && view.y >= cached.y &&
        view.x + view.width <= cached.x + cached.width && view.y + view.height <= cached.y + cached.height) return;
    const version = revision;
    detailTimer = setTimeout(async () => {
      try {
        const image = await capture({
          x: view.x - view.width / 2, y: view.y - view.height / 2,
          width: view.width * 2, height: view.height * 2,
        }, source);
        if (version === revision) {
          detail?.bitmap.close();
          detail = image;
        } else image.bitmap.close();
      } catch {
        // The overview remains usable during gestures.
      }
    }, 260);
  }

  function drawRegion({ view: bounds, bitmap }, view, replace = false) {
    const x = Math.max(bounds.x, view.x);
    const y = Math.max(bounds.y, view.y);
    const width = Math.min(bounds.x + bounds.width, view.x + view.width) - x;
    const height = Math.min(bounds.y + bounds.height, view.y + view.height) - y;
    if (width <= 0 || height <= 0) return;
    const srcX = bitmap.width / bounds.width, srcY = bitmap.height / bounds.height;
    const destX = canvas.width / view.width, destY = canvas.height / view.height;
    const left = (x - view.x) * destX, top = (y - view.y) * destY;
    if (replace) context.clearRect(left, top, width * destX, height * destY);
    context.drawImage(bitmap, (x - bounds.x) * srcX, (y - bounds.y) * srcY, width * srcX, height * srcY,
      left, top, width * destX, height * destY);
  }

  function draw(view) {
    if (!overview) return false;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!width || !height) return false;
    const density = Math.min(devicePixelRatio, 2, 2560 / Math.max(width, height));
    const pixelWidth = Math.round(width * density), pixelHeight = Math.round(height * density);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawRegion(overview, view);
    if (detail && view.width <= detail.view.width) drawRegion(detail, view, true);
    canvas.hidden = false;
    return true;
  }

  return { reset, draw, cancelDetail, prepareDetail };
}
