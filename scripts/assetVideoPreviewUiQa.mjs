import assert from 'node:assert/strict';

// Reusable assertions for a caller-owned Playwright Interactive session. The
// caller must first load isolated test media; these helpers never import user
// data, run paid generation, or start a browser themselves.
export async function sampleSidebarStability(page, sampleCount = 120) {
  return page.evaluate(async (count) => {
    const nextFrame = () => new Promise((resolve) => { const timer = setTimeout(resolve, 100); requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
    for (let index = 0; index < 20; index += 1) await nextFrame();
    const nav = document.querySelector('.sidebar nav'); const content = nav.querySelector('.sidebar-nav-fit-content');
    let styleChanges = 0;
    const observer = new MutationObserver((changes) => { styleChanges += changes.length; });
    observer.observe(content, { attributes: true, attributeFilter: ['style'] });
    const shapes = []; const deadline = Date.now() + 8000;
    for (let index = 0; index < count && Date.now() < deadline; index += 1) {
      await nextFrame();
      shapes.push([...nav.querySelectorAll('.nav-item')].map((item) => {
        const rect = item.getBoundingClientRect(); return [rect.height, rect.y, rect.width].map((value) => value.toFixed(3)).join(',');
      }).join('|'));
    }
    observer.disconnect();
    return { frames: shapes.length, unique: new Set(shapes).size, styleChanges, scale: nav.dataset.fitScale,
      footerBottom: document.querySelector('.sidebar-footer').getBoundingClientRect().bottom, height: innerHeight };
  }, sampleCount);
}

export async function assertSingleVideoPreview(page) {
  await page.getByRole('button', { name: '资产库', exact: true }).click();
  await page.getByRole('button', { name: '视频资产库', exact: true }).click();
  const count = await page.locator('.asset-video-thumbnail').count(); assert.ok(count >= 2, 'seed at least two isolated videos');
  assert.equal(await page.locator('video').count(), 0, 'the list must not create any players');
  for (const index of [0, 1]) {
    await page.locator('.asset-video-thumbnail').nth(index).click();
    await page.waitForFunction(() => document.querySelector('.asset-video-dialog video')?.readyState >= 2);
    assert.equal(await page.locator('video').count(), 1);
    await page.evaluate(() => { window.__qaReleasedAssetVideo = document.querySelector('video'); });
    if (index === 0) await page.getByRole('button', { name: '关闭视频播放', exact: true }).click();
    else await page.keyboard.press('Escape');
    assert.equal(await page.locator('video').count(), 0);
    const released = await page.evaluate(() => {
      const video = window.__qaReleasedAssetVideo; const result = video.paused && video.getAttribute('src') === null;
      delete window.__qaReleasedAssetVideo; return result;
    });
    assert.equal(released, true, 'close must pause, clear source and release the decoder');
  }
  const stability = await sampleSidebarStability(page);
  assert.equal(stability.frames, 120); assert.equal(stability.unique, 1); assert.equal(stability.styleChanges, 0);
  assert.ok(stability.footerBottom <= stability.height + 1);
  return { cards: count, initialPlayers: 0, openedPlayers: 1, closedPlayers: 0, stability };
}
