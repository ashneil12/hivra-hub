import { expect, test } from "@playwright/test";

// WebKit does not buffer until play() is called, so that first promise can reject
// with AbortError before a frame exists. Wait until the element has data, then
// play once if it is still paused. A media error fails. There is no timer and
// no second attempt after that.
async function playWhenReady(element: HTMLVideoElement): Promise<void> {
  element.muted = true;
  if (element.error) throw new Error(element.error.message);
  const dataReady = () =>
    element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || element.currentTime > 0;
  const first = element.play();
  if (!dataReady()) {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        element.removeEventListener("loadeddata", done);
        element.removeEventListener("playing", done);
        element.removeEventListener("timeupdate", done);
        element.removeEventListener("error", fail);
      };
      const done = () => {
        stop();
        resolve();
      };
      const fail = () => {
        stop();
        reject(new Error(element.error?.message || "The video could not be decoded"));
      };
      element.addEventListener("loadeddata", done);
      element.addEventListener("playing", done);
      element.addEventListener("timeupdate", done);
      element.addEventListener("error", fail);
      if (dataReady()) done();
    });
  }
  try {
    await first;
  } catch (error) {
    if (element.error) throw error;
    const name = error instanceof DOMException ? error.name : "";
    if (name !== "AbortError") throw error;
  }
  if (element.error) throw new Error(element.error.message);
  if (element.paused) await element.play();
}

test("file preview decodes, plays and seeks a video, then pauses on tab change", async ({
  page,
}) => {
  await page.goto("/tests/browser/video-preview.html");
  const video = page.locator('video[aria-label="Video preview: clip.mp4"]');
  await expect(video).toBeVisible();
  await expect
    .poll(
      () =>
        video.evaluate((element: HTMLVideoElement) => ({
          metadataReady: element.readyState >= HTMLMediaElement.HAVE_METADATA,
          error: element.error
            ? { code: element.error.code, message: element.error.message }
            : null,
          networkState: element.networkState,
        })),
      // Allow the cold WebKit media pipeline to initialize on shared runners.
      {
        timeout: 15_000,
        message: "Video should load metadata without a media error",
      },
    )
    .toMatchObject({ metadataReady: true, error: null });
  await expect(page.locator("footer").first()).toContainText("160 × 90");
  await expect(page.locator("footer").first()).toContainText("0:03");

  // Metadata is not enough on a cold WebKit pipeline: it does not buffer until
  // play() is called, and that promise can reject before a frame exists. Wait
  // until the element has data, then play once if it is still paused.
  await video.evaluate(playWhenReady);
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 1.5;
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThanOrEqual(1.5);

  await page.getByText("other.mp4", { exact: true }).click();
  await expect(video).toBeHidden();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
    .toBe(true);
  await page.getByText("clip.mp4", { exact: true }).click();
  await expect(video).toBeVisible();
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.paused),
  ).toBe(true);

  const bounds = await video.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(850);
  expect(bounds!.height).toBeLessThanOrEqual(600);

  await video.evaluate(playWhenReady);
  await page.getByRole("button", { name: "Hide workspace" }).click();
  await expect(video).toBeHidden();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
    .toBe(true);
  await page.getByRole("button", { name: "Show workspace" }).click();
  await expect(video).toBeVisible();
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.paused),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("video-preview.png") });
});
