import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const baseUrl = process.env.CANOPY_OBSERVATORY_URL || "http://127.0.0.1:8765";
const chromePath = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outputDir = new URL("../.data/visual/", import.meta.url);

function pixelStats(buffer) {
  const image = PNG.sync.read(buffer);
  let samples = 0;
  let sum = 0;
  let sumSquares = 0;
  const colors = new Set();
  const stride = Math.max(1, Math.floor((image.width * image.height) / 12000));
  for (let pixel = 0; pixel < image.width * image.height; pixel += stride) {
    const index = pixel * 4;
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    const alpha = image.data[index + 3];
    if (alpha < 10) continue;
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    samples += 1;
    sum += luminance;
    sumSquares += luminance * luminance;
    colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
  }
  const mean = samples ? sum / samples : 0;
  const variance = samples ? sumSquares / samples - mean * mean : 0;
  return {
    width: image.width,
    height: image.height,
    samples,
    colorBuckets: colors.size,
    luminanceDeviation: Math.sqrt(Math.max(variance, 0)),
  };
}

function rectDelta(left, right) {
  if (!left || !right) return 0;
  return ["x", "y", "width", "height"].reduce(
    (total, key) => total + Math.abs(left[key] - right[key]),
    0,
  );
}

async function clickControl(locator) {
  await locator.click({ force: true });
}

async function pointerClick(page, locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("control has no pointer bounds");
  await page.mouse.click(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
}

async function cloudLayerStyle(page) {
  return page.locator(".app-shell").evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { animationName: style.animationName, opacity: Number(style.opacity) };
  });
}

async function installWebglCounter(page) {
  await page.addInitScript(() => {
    const counter = { clears: 0, draws: 0 };
    Object.defineProperty(globalThis, "__canopyWebglCounter", { value: counter, configurable: false });
    const patch = (prototype, method, field) => {
      if (!prototype) return;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      if (!descriptor || typeof descriptor.value !== "function") return;
      const original = descriptor.value;
      try {
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value(...args) {
            counter[field] += 1;
            return Reflect.apply(original, this, args);
          },
        });
      } catch {
        // The counter is diagnostic only; unsupported WebGL descriptors must
        // not prevent the application itself from loading.
      }
    };
    const prototypes = [
      globalThis.WebGLRenderingContext?.prototype,
      globalThis.WebGL2RenderingContext?.prototype,
    ];
    prototypes.forEach((prototype) => {
      patch(prototype, "clear", "clears");
      patch(prototype, "drawArrays", "draws");
      patch(prototype, "drawElements", "draws");
      patch(prototype, "drawArraysInstanced", "draws");
      patch(prototype, "drawElementsInstanced", "draws");
    });
  });
}

async function verifyRenderBudget(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { background: "detailed" });
  const sampleMs = 3000;
  const counterReady = await page.evaluate(() => {
    const counter = globalThis.__canopyWebglCounter;
    if (!counter) return false;
    counter.clears = 0;
    counter.draws = 0;
    return true;
  });
  await page.waitForTimeout(sampleMs);
  const counter = await page.evaluate(() => ({ ...globalThis.__canopyWebglCounter }));
  const idleClearRate = counter.clears * 1000 / sampleMs;
  const drawCallRate = counter.draws * 1000 / sampleMs;
  const failures = [];
  if (!counterReady) failures.push("WebGL render counter could not be installed");
  if (idleClearRate > 42) failures.push(`idle WebGL redraw rate remained too high: ${idleClearRate.toFixed(1)}/s`);
  if (idleClearRate < 20) failures.push(`idle WebGL animation redraw rate was too low: ${idleClearRate.toFixed(1)}/s`);
  return { sampleMs, clearCalls: counter.clears, drawCalls: counter.draws, idleClearRate, drawCallRate, failures };
}

async function clickOrganBody(page, name, viewportWidth) {
  const label = page.getByRole("button", { name, exact: true });
  const bounds = await label.boundingBox();
  if (!bounds) throw new Error(`${name} label has no projected bounds`);
  const bodyOffset = viewportWidth <= 560 ? 30 : 52;
  await page.mouse.click(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height + bodyOffset,
  );
}

async function prepare(page, { locale = "zh-TW", background = "detailed", lifeStream = "closed" } = {}) {
  if (!page.url().startsWith(baseUrl)) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  }
  await page.evaluate(({ localeValue, backgroundValue, lifeStreamValue }) => {
    localStorage.setItem("canopy.locale", localeValue);
    localStorage.setItem("canopy.background", backgroundValue);
    localStorage.setItem("canopy.music", "greenhouse");
    localStorage.setItem("canopy.music.volume", "0.88");
    localStorage.setItem("canopy.bgm", "on");
    localStorage.setItem("canopy.sfx", "on");
    localStorage.setItem("canopy.life-stream", lifeStreamValue);
  }, { localeValue: locale, backgroundValue: background, lifeStreamValue: lifeStream });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  try {
    await page.locator("canvas").waitFor({ state: "visible", timeout: 60000 });
  } catch (error) {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 1200);
    throw new Error(`3D canvas did not become visible. Body: ${body}`, { cause: error });
  }
  // The host-shell label can legitimately be occluded by a foreground living
  // unit at some camera angles. Wait for any projected label, not whichever
  // label happens to be first in DOM order.
  try {
    await page.locator(".scene-label:visible").first().waitFor({ state: "visible", timeout: 60000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      body: document.body.innerText.slice(0, 900),
      visibility: document.visibilityState,
      labels: [...document.querySelectorAll(".scene-label")].slice(0, 4).map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { text: element.textContent, rect: rect.toJSON(), display: style.display, visibility: style.visibility, opacity: style.opacity };
      }),
      canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        rect: canvas.getBoundingClientRect().toJSON(),
      })),
    }));
    throw new Error(`3D labels did not project. ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await page.waitForTimeout(1800);
}

async function verifyZoomPersistence(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  const canvas = page.locator("canvas");
  const label = page.getByRole("button", { name: "Seed 大腦", exact: true });
  const before = await label.boundingBox();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("canvas has no interactive bounds");
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(900);
  const zoomed = await label.boundingBox();
  await page.waitForTimeout(1400);
  const settled = await label.boundingBox();
  const zoomDelta = rectDelta(before, zoomed);
  const settleDrift = rectDelta(zoomed, settled);
  const failures = [];
  if (zoomDelta < 8) failures.push("wheel zoom did not materially change the scene");
  if (zoomDelta >= 8 && settleDrift > zoomDelta * 0.35) failures.push("camera moved back after wheel zoom");
  return { zoomDelta, settleDrift, failures };
}

async function verifyControls(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  const failures = [];
  const scene = page.locator(".scene-stage");
  const renderSurface = page.locator('[data-render-policy="adaptive-idle-30"][data-shadow-policy="state-driven"]');
  if (await renderSurface.count() !== 1) failures.push("adaptive render and shadow budgets were not active");
  const connectionCount = Number(await scene.getAttribute("data-architecture-connections"));
  if (connectionCount !== 11) failures.push(`expected 11 architecture connections, got ${connectionCount}`);
  await clickControl(page.getByRole("button", { name: "Seed 大腦", exact: true }).first());
  await page.waitForTimeout(450);
  const flowLabels = await page.locator(".flow-label").count();
  const detailFlows = await page.locator(".flow-list button").count();
  if (flowLabels < 2) failures.push(`expected selected neural flow labels, got ${flowLabels}`);
  if (detailFlows < 2) failures.push(`expected architecture navigation rows, got ${detailFlows}`);

  await pointerClick(page, page.getByRole("button", { name: "設定" }));
  await clickControl(page.getByRole("button", { name: "EN", exact: true }));
  await page.getByText("STRUCTURE", { exact: true }).waitFor();
  if ((await page.locator("html").getAttribute("lang")) !== "en") failures.push("English locale was not applied");

  await clickControl(page.getByRole("button", { name: "简体", exact: true }));
  await page.getByText("生命体系统设置", { exact: true }).waitFor();
  if ((await page.locator("html").getAttribute("lang")) !== "zh-CN") failures.push("Simplified Chinese locale was not applied");

  await clickControl(page.getByRole("button", { name: "繁體", exact: true }));
  await page.getByText("生命體系統設定", { exact: true }).waitFor();
  await clickControl(page.getByRole("button", { name: "可愛冒險圖", exact: true }));
  if ((await page.locator(".app-shell").getAttribute("data-background")) !== "simple") failures.push("simple background was not applied");
  if ((await scene.getAttribute("data-world-tree")) !== "simple") failures.push("simple tree contract was not applied");
  if ((await scene.getAttribute("data-ancient-ruins")) !== "hidden") failures.push("ruins leaked into simple mode");
  const simpleAtmosphere = await cloudLayerStyle(page);
  if (simpleAtmosphere.animationName !== "none" || simpleAtmosphere.opacity > 0.01) failures.push("full drifting clouds leaked into simple mode");
  await clickControl(page.getByRole("button", { name: "純淨模式", exact: true }));
  if ((await page.locator(".app-shell").getAttribute("data-background")) !== "none") failures.push("no-background mode was not applied");
  if ((await scene.getAttribute("data-world-tree")) !== "none") failures.push("tree leaked into no-background mode");
  if ((await scene.getAttribute("data-ancient-ruins")) !== "hidden") failures.push("ruins leaked into no-background mode");
  const cleanAtmosphere = await cloudLayerStyle(page);
  if (cleanAtmosphere.animationName !== "none" || cleanAtmosphere.opacity > 0.01) failures.push("atmosphere leaked into no-background mode");
  await clickControl(page.getByRole("button", { name: "古樹遺跡", exact: true }));
  if ((await scene.getAttribute("data-world-tree")) !== "detailed") failures.push("detailed tree contract was not applied");
  if ((await scene.getAttribute("data-ancient-ruins")) !== "visible") failures.push("ancient ruins contract was not applied");
  const detailedAtmosphere = await cloudLayerStyle(page);
  if (detailedAtmosphere.animationName !== "canopy-cloud-drift" || detailedAtmosphere.opacity < 0.25) failures.push("detailed drifting cloud layer was not active");

  const volume = page.getByRole("slider", { name: "背景音量" });
  await volume.fill("1");
  if ((await volume.inputValue()) !== "1") failures.push("BGM volume control did not reach 100%");
  if ((await page.evaluate(() => localStorage.getItem("canopy.music.volume"))) !== "1") failures.push("BGM volume preference was not persisted");
  const musicOptionCount = await page.locator("[data-testid='music-settings'] button").count();
  if (musicOptionCount !== 9) failures.push(`expected 9 BGM choices, got ${musicOptionCount}`);
  await pointerClick(page, page.getByRole("button", { name: "神木之鈴", exact: true }));
  await page.waitForFunction(() => localStorage.getItem("canopy.music") === "sacred-grove", null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio[data-canopy-bgm='sacred-grove']");
    return audio instanceof HTMLAudioElement && audio.readyState >= HTMLMediaElement.HAVE_METADATA;
  }, null, { timeout: 15000 });
  const sacredCredit = await page.locator(".music-credit").innerText();
  if (!sacredCredit.includes("Sacred Grove Bells") || !sacredCredit.includes("yd")) {
    failures.push("Sacred Grove Bells attribution is not visible");
  }
  const audioAssetsReady = await page.evaluate(async () => {
    const paths = [
      "/assets/audio/tracks/sacred-grove-bells.mp3",
      "/assets/audio/tracks/resonant-chimes.mp3",
      "/assets/audio/tracks/shrine-ritual.mp3",
      "/assets/audio/tracks/ancient-temple.mp3",
    ];
    return Promise.all(paths.map(async (path) => {
      const response = await fetch(path, { method: "HEAD" });
      return { path, ok: response.ok, contentType: response.headers.get("content-type") };
    }));
  });
  const unavailableAudio = audioAssetsReady.filter((asset) => !asset.ok || asset.contentType !== "audio/mpeg");
  if (unavailableAudio.length) failures.push(`new BGM assets unavailable: ${unavailableAudio.map((asset) => asset.path).join(", ")}`);
  await clickControl(page.getByRole("button", { name: "關閉設定" }));

  await pointerClick(page, page.getByRole("button", { name: "關閉背景音樂" }));
  const bgm = page.getByRole("button", { name: "播放背景音樂" });
  await bgm.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => localStorage.getItem("canopy.bgm") === "off", null, { timeout: 10000 });

  await clickControl(page.getByRole("button", { name: "進入根系記憶" }).first());
  await page.getByText("讓新工具延續既有習慣", { exact: true }).first().waitFor({ timeout: 10000 });
  await page.getByText("seed.capability.map_new_tools_to_habits", { exact: true }).first().waitFor({ timeout: 10000 });
  return { connectionCount, flowLabels, detailFlows, musicOptionCount, audioAssetsReady, detailedAtmosphere, failures };
}

async function verifyNarrowMusicSettings(page) {
  const failures = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { background: "simple" });
  await pointerClick(page, page.getByRole("button", { name: "設定" }));
  const panel = page.locator(".settings-panel");
  await panel.waitFor({ state: "visible", timeout: 10000 });
  const lastTrack = panel.getByRole("button", { name: "晨光鋼琴", exact: true });
  await lastTrack.scrollIntoViewIfNeeded();
  const panelBounds = await panel.boundingBox();
  const lastTrackBounds = await lastTrack.boundingBox();
  const panelMetrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (panelMetrics.scrollWidth > panelMetrics.clientWidth + 1) failures.push("narrow music settings scroll horizontally");
  if (
    !panelBounds
    || !lastTrackBounds
    || lastTrackBounds.x < 0
    || lastTrackBounds.x + lastTrackBounds.width > 390
    || lastTrackBounds.y < panelBounds.y
    || lastTrackBounds.y + lastTrackBounds.height > panelBounds.y + panelBounds.height
  ) {
    failures.push("last BGM choice is not reachable inside narrow settings");
  }
  const resonantChimes = panel.getByRole("button", { name: "神鈴回響", exact: true });
  await resonantChimes.scrollIntoViewIfNeeded();
  await pointerClick(page, resonantChimes);
  await page.waitForFunction(() => localStorage.getItem("canopy.music") === "resonant-chimes", null, { timeout: 10000 });
  return { panelBounds, lastTrackBounds, panelMetrics, failures };
}

async function verifyPickingAndNavigation(page) {
  const failures = [];
  const modeResults = [];
  for (const background of ["detailed", "simple", "none"]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page, { background });
    await clickOrganBody(page, "Seed 大腦", 1440);
    await page.waitForTimeout(500);
    const detailTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
    const structureTrail = await page.locator(".structure-breadcrumb").count();
    if (detailTitle !== "Seed 大腦") failures.push(`${background}: direct living-unit body selected ${detailTitle || "nothing"}`);
    if (structureTrail) failures.push(`${background}: direct living-unit body entered structure view`);
    modeResults.push({ background, detailTitle, structureTrail });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { background: "detailed" });
  const canvas = page.locator("canvas");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("canvas has no interaction bounds");
  const dragStart = { x: canvasBox.x + canvasBox.width * 0.5, y: canvasBox.y + canvasBox.height * 0.52 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 84, dragStart.y + 8, { steps: 7 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const dragDetailCount = await page.locator(".detail-panel").count();
  const dragStructureCount = await page.locator(".structure-breadcrumb").count();
  if (dragDetailCount || dragStructureCount) failures.push("orbit drag triggered a selection or structure navigation");
  await clickOrganBody(page, "Seed 大腦", 1440);
  await page.waitForTimeout(500);
  const rotatedDetailTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
  if (rotatedDetailTitle !== "Seed 大腦") failures.push(`rotated living-unit body selected ${rotatedDetailTitle || "nothing"}`);

  await prepare(page, { background: "detailed" });
  await page.mouse.click(1210, 690);
  await page.waitForTimeout(450);
  const shellTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
  if (shellTitle !== "Canopy 宿主") failures.push(`blank shell selected ${shellTitle || "nothing"}`);

  await prepare(page, { background: "none" });
  await page.mouse.click(1210, 690);
  await page.waitForTimeout(350);
  if (await page.locator(".detail-panel").count()) failures.push("blank no-background space selected a scene object");

  await prepare(page, { background: "detailed" });
  await clickOrganBody(page, "Seed 大腦", 1440);
  const overviewExplore = page.locator(".detail-panel").getByRole("button", { name: "探索內部結構", exact: true });
  if ((await overviewExplore.count()) !== 1) failures.push("overview living unit with children did not expose one explore action");
  await clickControl(overviewExplore);
  await page.waitForTimeout(450);
  const structurePanel = page.locator(".detail-panel");
  const insideScope = await structurePanel.getAttribute("data-navigation-scope");
  const unitDepth = await structurePanel.getAttribute("data-navigation-depth");
  if (insideScope !== "inside" || unitDepth !== "2") failures.push(`living-unit navigation state was ${insideScope}/${unitDepth}`);
  if (await structurePanel.getByRole("button", { name: "探索內部結構", exact: true }).count()) failures.push("inside living unit repeated the same explore action");
  await clickControl(structurePanel.locator(".structure-relations button").filter({ hasText: "Brain Circuits" }));
  await page.waitForTimeout(350);
  await clickControl(page.locator(".detail-panel .structure-relations button").filter({ hasText: "test_seed_brain.py" }));
  await page.waitForTimeout(350);
  const leafPanel = page.locator(".detail-panel");
  const leafTitle = await leafPanel.locator("h2").innerText();
  const leafExploreCount = await leafPanel.getByRole("button", { name: "探索內部結構", exact: true }).count();
  const leafBackCount = await leafPanel.getByRole("button", { name: "上一層", exact: true }).count();
  const leafEmpty = await page.getByText("沒有更多下層元件", { exact: true }).isVisible();
  if (leafTitle !== "test_seed_brain.py" || leafExploreCount || leafBackCount !== 1 || !leafEmpty) {
    failures.push("leaf navigation did not reduce to its empty state and one back action");
  }

  const narrowResults = [];
  for (const background of ["detailed", "simple", "none"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepare(page, { background });
    await clickOrganBody(page, "Seed 大腦", 390);
    await page.waitForTimeout(450);
    const detailTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
    const structureTrail = await page.locator(".structure-breadcrumb").count();
    if (detailTitle !== "Seed 大腦") failures.push(`narrow ${background}: direct living-unit body selected ${detailTitle || "nothing"}`);
    if (structureTrail) failures.push(`narrow ${background}: direct living-unit body entered structure view`);
    narrowResults.push({ background, detailTitle, structureTrail });
  }

  return {
    modeResults,
    narrowResults,
    dragDetailCount,
    dragStructureCount,
    rotatedDetailTitle,
    shellTitle,
    leafTitle,
    failures,
  };
}

async function verifyActivityAndTreatments(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  const failures = [];
  await clickControl(page.getByRole("button", { name: "歷程", exact: true }));
  const timeline = page.getByTestId("activity-timeline");
  await timeline.waitFor({ state: "visible", timeout: 10000 });
  const days = await timeline.getByRole("listitem").count();
  if (days !== 30) failures.push(`expected 30 activity days, got ${days}`);
  if ((await timeline.getByText("只顯示有限摘要", { exact: false }).count()) !== 1) failures.push("activity privacy boundary is not visible");

  const dateLabel = timeline.locator(".timeline-date-row strong");
  const before = await dateLabel.innerText();
  await clickControl(timeline.getByRole("button", { name: "前一天", exact: true }));
  const previous = await dateLabel.innerText();
  if (before === previous) failures.push("activity previous-day control did not change the date");
  await clickControl(timeline.getByRole("button", { name: "播放成長歷程", exact: true }));
  await page.waitForTimeout(1300);
  const replayed = await dateLabel.innerText();
  if (replayed === previous) failures.push("activity playback did not advance the date");

  const activeModule = timeline.locator(".timeline-modules button:not(:disabled)").first();
  await clickControl(activeModule);
  await page.locator(".recent-activity").waitFor({ state: "visible", timeout: 10000 });
  await clickControl(page.getByRole("button", { name: "提出生命單元改善", exact: true }));
  await page.getByRole("heading", { name: "提出生命單元改善方向", exact: true }).waitFor();
  await clickControl(page.getByRole("button", { name: "關閉", exact: true }));

  await clickControl(page.locator(".detail-panel").getByRole("button", { name: "進入根系記憶", exact: true }));
  await clickControl(page.getByRole("button", { name: "新增記憶提案", exact: true }));
  await page.getByRole("heading", { name: "提出新的 Seed 記憶", exact: true }).waitFor();
  await clickControl(page.getByRole("button", { name: "關閉", exact: true }));
  return { days, before, previous, replayed, failures };
}

async function verifyLifeStream(page) {
  const failures = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { lifeStream: "open" });
  const panel = page.locator(".life-stream-panel");
  await panel.waitFor({ state: "visible", timeout: 15000 });
  await clickControl(panel.getByRole("button", { name: "收合生命歷程", exact: true }));
  const desktopPeek = page.locator(".life-stream-peek");
  await desktopPeek.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(260);
  const desktopPeekBounds = await desktopPeek.boundingBox();
  if (!desktopPeekBounds || desktopPeekBounds.width > 50 || desktopPeekBounds.height <= desktopPeekBounds.width) {
    failures.push("desktop life history did not collapse into a vertical edge tab");
  }
  if (desktopPeekBounds && desktopPeekBounds.x + desktopPeekBounds.width > 1440) {
    failures.push("desktop life history edge tab escapes the viewport");
  }
  await clickControl(desktopPeek);
  await panel.waitFor({ state: "visible", timeout: 10000 });
  const eventCount = await panel.locator(".life-event").count();
  const learningCount = await panel.locator(".life-learning").count();
  const privacyVisible = await panel.getByText("不保存原始 prompt", { exact: false }).isVisible();
  const retentionCopy = await panel.locator(".life-stream-footer span").innerText();
  const apiContract = await page.evaluate(async () => {
    const response = await fetch("/api/life-events?limit=80");
    const payload = await response.json();
    const events = payload.events || [];
    const serialized = JSON.stringify(events);
    return {
      ok: response.ok,
      total: payload.stats?.total || 0,
      retentionDays: payload.retention_days,
      syncStatus: payload.sync?.status || "",
      visibleLearningCount: events.slice(0, 36).filter((event) => String(event.learning || "").trim()).length,
      containsRawToolInput: serialized.includes("tool_input") || serialized.includes("tool_response"),
    };
  });
  if (!eventCount) failures.push("life history contains no visible activity events");
  if (learningCount !== apiContract.visibleLearningCount) {
    failures.push(`life history learning evidence mismatch: API ${apiContract.visibleLearningCount}, UI ${learningCount}`);
  }
  if (!privacyVisible) failures.push("life history privacy boundary is not visible");
  if (!retentionCopy.includes("60 天")) failures.push(`life history retention copy was ${retentionCopy}`);
  if (!apiContract.ok || !apiContract.total) failures.push("life event SQLite projection is empty or unavailable");
  if (apiContract.retentionDays !== 60) failures.push(`life event retention was ${apiContract.retentionDays}`);
  if (apiContract.containsRawToolInput) failures.push("life event API leaked raw tool input or response");

  const inspectableTurn = panel.locator('.life-event[data-kind="turn"]').first();
  await clickControl(inspectableTurn.locator(".life-event-main"));
  await page.waitForTimeout(350);
  const eventDetails = inspectableTurn.locator(".life-event-details");
  const eventDetailsVisible = await eventDetails.isVisible().catch(() => false);
  const eventDetailsText = eventDetailsVisible ? await eventDetails.innerText() : "";
  const learningStatus = inspectableTurn.locator(".life-learning-status");
  const learningStatusVisible = await learningStatus.isVisible().catch(() => false);
  const learningStatusText = learningStatusVisible ? await learningStatus.innerText() : "";
  if (!eventDetailsVisible) failures.push("clicking a life event did not reveal its turn details");
  if (eventDetailsVisible && !eventDetailsText.includes("實際幫了什麼") && !eventDetailsText.includes("實際驗證")) {
    failures.push("life event details do not explain assistance or verification");
  }
  if (!learningStatusVisible || !learningStatusText.includes("本回合學習判定")) {
    failures.push("life event details do not distinguish learning from ordinary completion");
  }
  const detail = page.locator(".detail-panel");
  const desktopPeekWithDetail = page.locator(".life-stream-peek");
  await clickControl(panel.getByRole("button", { name: "收合生命歷程", exact: true }));
  await desktopPeekWithDetail.waitFor({ state: "visible", timeout: 10000 });
  await clickControl(page.getByRole("button", { name: "總覽", exact: true }));
  await page.waitForTimeout(1800);
  await clickControl(page.getByRole("button", { name: "Seed 大腦", exact: true }).first());
  await page.waitForTimeout(350);
  await detail.waitFor({ state: "visible", timeout: 10000 });
  const detailBounds = await detail.boundingBox();
  const desktopPeekWithDetailBounds = await desktopPeekWithDetail.boundingBox();
  if (
    !detailBounds
    || !desktopPeekWithDetailBounds
    || desktopPeekWithDetailBounds.x + desktopPeekWithDetailBounds.width > detailBounds.x
  ) {
    failures.push("desktop life history edge tab overlaps selected-unit details");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { background: "simple", lifeStream: "open" });
  const narrowPanel = page.locator(".life-stream-panel");
  const narrowBounds = await narrowPanel.boundingBox();
  if (!narrowBounds || narrowBounds.x < 0 || narrowBounds.x + narrowBounds.width > 390 || narrowBounds.y + narrowBounds.height > 844) {
    failures.push("narrow life history escapes the viewport");
  }
  await clickControl(narrowPanel.getByRole("button", { name: "收合生命歷程", exact: true }));
  const peek = page.locator(".life-stream-peek");
  await peek.waitFor({ state: "visible", timeout: 10000 });
  const peekBounds = await peek.boundingBox();
  if (!peekBounds || peekBounds.x < 0 || peekBounds.x + peekBounds.width > 390) failures.push("narrow life history summary escapes the viewport");
  if (narrowBounds && peekBounds && Math.abs(narrowBounds.width - peekBounds.width) > 2) failures.push("life history collapsed sideways instead of vertically");
  if (narrowBounds && peekBounds && peekBounds.height >= narrowBounds.height) failures.push("life history vertical collapse did not reduce its height");
  await clickOrganBody(page, "Seed 大腦", 390);
  await page.waitForTimeout(350);
  const narrowSelection = await page.locator(".detail-panel h2").innerText().catch(() => "");
  if (narrowSelection !== "Seed 大腦") failures.push(`collapsed narrow life history prevented 3D selection: ${narrowSelection || "nothing"}`);
  return { desktopPeekBounds, desktopPeekWithDetailBounds, eventCount, learningCount, retentionCopy, apiContract, eventDetailsVisible, learningStatusVisible, learningStatusText, narrowSelection, failures };
}

async function inspect(page, name, viewport, { enterSeed = false, enterTimeline = false, background = "detailed" } = {}) {
  await page.setViewportSize(viewport);
  await prepare(page, { background });
  if (enterSeed) {
    await clickControl(page.locator(".left-dock").getByRole("button", { name: "進入根系記憶", exact: true }));
    await page.locator(".seed-navigator").waitFor({ state: "visible" });
    await page.waitForTimeout(900);
  }
  if (enterTimeline) {
    await clickControl(page.getByRole("button", { name: "歷程", exact: true }));
    await page.locator(".activity-timeline").waitFor({ state: "visible" });
    await page.waitForTimeout(700);
  }
  const screenshot = await page.screenshot({ fullPage: false, timeout: 90000 });
  const canvas = await page.locator("canvas").screenshot({ timeout: 90000 });
  const imagePath = new URL(`${name}.png`, outputDir);
  await writeFile(imagePath, screenshot);
  const stats = pixelStats(canvas);
  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
    };
    const intersects = (left, right) => Boolean(
      left && right && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
    );
    const top = rect(".top-hud");
    const bottom = rect(".bottom-hud");
    const detail = rect(".detail-panel");
    const navigator = rect(".seed-navigator");
    const dock = rect(".left-dock");
    const timeline = rect(".activity-timeline");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      topDetailOverlap: intersects(top, detail),
      bottomDetailOverlap: intersects(bottom, detail),
      seedDetailOverlap: intersects(navigator, detail),
      dockTimelineOverlap: intersects(dock, timeline),
      bottomTimelineOverlap: intersects(bottom, timeline),
      canvas: rect("canvas"),
      visibleButtons: Array.from(document.querySelectorAll("button")).filter((button) => {
        const style = getComputedStyle(button);
        const value = button.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && value.width > 0 && value.height > 0;
      }).length,
    };
  });
  const failures = [];
  if (stats.colorBuckets < 55 || stats.luminanceDeviation < 7) failures.push("canvas appears blank or visually flat");
  if (layout.horizontalOverflow > 1) failures.push(`horizontal overflow ${layout.horizontalOverflow}px`);
  if (layout.topDetailOverlap) failures.push("top HUD overlaps detail panel");
  if (layout.bottomDetailOverlap) failures.push("bottom HUD overlaps detail panel");
  if (layout.seedDetailOverlap) failures.push("Seed navigator overlaps detail panel");
  if (layout.dockTimelineOverlap) failures.push("navigation dock overlaps activity timeline");
  if (layout.bottomTimelineOverlap) failures.push("bottom HUD overlaps activity timeline");
  if (!layout.canvas || layout.canvas.right - layout.canvas.left < viewport.width * 0.9) failures.push("canvas is not full bleed");
  return { name, viewport, background, stats, layout, failures, screenshot: imagePath.pathname };
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--enable-webgl", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  await installWebglCounter(page);
  const runtimeErrors = [];
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
    console.error(`[browser] pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
      console.error(`[browser] console: ${message.text()}`);
    }
  });
  const runStage = async (name, operation) => {
    console.error(`[visual] ${name}`);
    return operation();
  };
  const renderBudget = await runStage("render-budget", () => verifyRenderBudget(page));
  const zoom = await runStage("zoom", () => verifyZoomPersistence(page));
  const controls = await runStage("controls", () => verifyControls(page));
  const musicLayout = await runStage("music-layout", () => verifyNarrowMusicSettings(page));
  const picking = await runStage("picking-navigation", () => verifyPickingAndNavigation(page));
  const activity = await runStage("activity", () => verifyActivityAndTreatments(page));
  const lifeStream = await runStage("life-stream", () => verifyLifeStream(page));
  const scenes = [
    ["desktop-detailed", { width: 1440, height: 900 }, { background: "detailed" }],
    ["desktop-simple", { width: 1440, height: 900 }, { background: "simple" }],
    ["desktop-none", { width: 1440, height: 900 }, { background: "none" }],
    ["mobile-overview", { width: 390, height: 844 }, { background: "simple" }],
    ["mobile-seed", { width: 390, height: 844 }, { enterSeed: true, background: "simple" }],
    ["mobile-timeline", { width: 390, height: 844 }, { enterTimeline: true, background: "simple" }],
  ];
  const results = [];
  for (const [name, viewport, options] of scenes) {
    results.push(await runStage(name, () => inspect(page, name, viewport, options)));
  }
  const failures = [
    ...results.flatMap((result) => result.failures.map((failure) => `${result.name}: ${failure}`)),
    ...renderBudget.failures.map((failure) => `render-budget: ${failure}`),
    ...zoom.failures.map((failure) => `desktop-zoom: ${failure}`),
    ...controls.failures.map((failure) => `controls: ${failure}`),
    ...musicLayout.failures.map((failure) => `music-layout: ${failure}`),
    ...picking.failures.map((failure) => `picking-navigation: ${failure}`),
    ...activity.failures.map((failure) => `activity: ${failure}`),
    ...lifeStream.failures.map((failure) => `life-stream: ${failure}`),
    ...runtimeErrors,
  ];
  console.log(JSON.stringify({ status: failures.length ? "FAIL" : "PASS", renderBudget, zoom, controls, musicLayout, picking, activity, lifeStream, results, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
