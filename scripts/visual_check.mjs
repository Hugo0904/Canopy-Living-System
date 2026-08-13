import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const baseUrl = process.env.CANOPY_LIVING_SYSTEM_URL || process.env.CANOPY_OBSERVATORY_URL || "http://127.0.0.1:8765";
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
    const matrixValues = style.transform === "none"
      ? []
      : style.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
    const is3d = style.transform.startsWith("matrix3d");
    return {
      animationName: style.animationName,
      backgroundImage: style.backgroundImage,
      opacity: Number(style.opacity),
      transform: style.transform,
      translateX: is3d ? matrixValues[12] ?? 0 : matrixValues[4] ?? 0,
      translateY: is3d ? matrixValues[13] ?? 0 : matrixValues[5] ?? 0,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
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

async function installUiAudioProbe(page) {
  await page.addInitScript(() => {
    const peaks = [];
    Object.defineProperty(globalThis, "__canopyUiGainPeaks", { value: peaks, configurable: false });
    const prototype = globalThis.AudioParam?.prototype;
    const original = prototype?.exponentialRampToValueAtTime;
    if (!prototype || typeof original !== "function") return;
    try {
      Object.defineProperty(prototype, "exponentialRampToValueAtTime", {
        configurable: true,
        writable: true,
        value(value, endTime) {
          // Oscillator frequency also uses exponential ramps (for example
          // 690 Hz). UI click amplitude is normalized, so only retain gain-
          // shaped values in the 0..1 range.
          if (Number(value) > 0.001 && Number(value) <= 1) peaks.push(Number(value));
          return Reflect.apply(original, this, [value, endTime]);
        },
      });
    } catch {
      // The probe is diagnostic only. The application must keep working if a
      // browser exposes a non-configurable Web Audio prototype.
    }
  });
}

async function verifyRenderBudget(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Three.js can clear the shadow, auxiliary, and main targets during one
  // scheduled frame. The scene is budgeted at 10fps, so this ceiling measures
  // buffer operations (not frames) with a small scheduling allowance.
  const maxScheduledClearRate = 34;
  const sample = async (sampleMs) => {
    const counterReady = await page.evaluate(() => {
      const counter = globalThis.__canopyWebglCounter;
      if (!counter) return false;
      counter.clears = 0;
      counter.draws = 0;
      return true;
    });
    await page.waitForTimeout(sampleMs);
    const counter = await page.evaluate(() => ({ ...globalThis.__canopyWebglCounter }));
    return {
      sampleMs,
      counterReady,
      clearCalls: counter.clears,
      drawCalls: counter.draws,
      clearRate: counter.clears * 1000 / sampleMs,
      drawCallRate: counter.draws * 1000 / sampleMs,
    };
  };
  const failures = [];
  await prepare(page, { background: "detailed", effects: "off" });
  const inactive = await sample(2400);
  const inactivePolicy = await page.locator("[data-render-policy]").getAttribute("data-render-policy");
  if (!inactive.counterReady) failures.push("WebGL render counter could not be installed");
  if (inactivePolicy !== "interaction-only") failures.push(`effects-off render policy was ${inactivePolicy}`);
  if (inactive.clearRate > 6) failures.push(`effects-off scene kept redrawing at ${inactive.clearRate.toFixed(1)}/s`);

  await prepare(page, { background: "detailed", effects: "on", enabledEffects: ["clouds"] });
  const cloudOnly = await sample(2400);
  const cloudOnlyFarState = await page.locator(".app-shell").evaluate((element) => ({
    distance: element.getAttribute("data-effect-distance"),
    particles: element.getAttribute("data-effect-particles"),
    clouds: element.getAttribute("data-effect-clouds"),
  }));
  const cloudOnlyPolicy = await page.locator("[data-render-policy]").getAttribute("data-render-policy");
  if (cloudOnlyPolicy !== "interaction-only") failures.push(`cloud-only render policy was ${cloudOnlyPolicy}`);
  if (cloudOnly.clearRate > 6) failures.push(`CSS cloud effect woke the 3D redraw loop at ${cloudOnly.clearRate.toFixed(1)}/s`);
  if (cloudOnlyFarState.distance !== "far" || cloudOnlyFarState.clouds !== "on" || cloudOnlyFarState.particles !== "off") {
    failures.push(`far adaptive effects were ${JSON.stringify(cloudOnlyFarState)}`);
  }
  await page.getByRole("button", { name: "Seed 大腦", exact: true }).evaluate((element) => element.click());
  await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-effect-distance") === "near");
  const cloudOnlyNearState = await page.locator(".app-shell").evaluate((element) => ({
    distance: element.getAttribute("data-effect-distance"),
    particles: element.getAttribute("data-effect-particles"),
    clouds: element.getAttribute("data-effect-clouds"),
  }));
  if (cloudOnlyNearState.clouds !== "off") failures.push(`near view retained clouds: ${JSON.stringify(cloudOnlyNearState)}`);

  await prepare(page, { background: "detailed", effects: "on", enabledEffects: ["particles"] });
  const particleFarState = await page.locator(".app-shell").getAttribute("data-effect-particles");
  if (particleFarState !== "off") failures.push("far view retained floating motes");
  await page.getByRole("button", { name: "Seed 大腦", exact: true }).evaluate((element) => element.click());
  await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-effect-distance") === "near");
  await page.waitForTimeout(900);
  const particlesOnly = await sample(2400);
  const particlesOnlyPolicy = await page.locator("[data-render-policy]").getAttribute("data-render-policy");
  const particlesOnlyBudget = await page.locator("[data-render-policy]").getAttribute("data-animation-budget-fps");
  const particleBufferWidth = await page.locator("canvas").evaluate((element) => element.width);
  if (particlesOnlyPolicy !== "adaptive-idle-10") failures.push(`particle-only render policy was ${particlesOnlyPolicy}`);
  if (particlesOnlyBudget !== "10") failures.push(`particle-only animation budget was ${particlesOnlyBudget}fps`);
  if ((await page.locator(".app-shell").getAttribute("data-effect-particles")) !== "on") failures.push("near view did not enable floating motes");
  if (particlesOnly.clearRate > maxScheduledClearRate || particlesOnly.clearRate < 6) failures.push(`particle-only render activity was ${particlesOnly.clearRate.toFixed(1)} clears/s`);
  if (particleBufferWidth > 1810) failures.push(`particle-only detailed buffer stayed too dense at ${particleBufferWidth}px`);

  await prepare(page, { background: "detailed", effects: "on" });
  const active = await sample(3000);
  const activePolicy = await page.locator("[data-render-policy]").getAttribute("data-render-policy");
  if (activePolicy !== "adaptive-idle-10") failures.push(`effects-on render policy was ${activePolicy}`);
  if (active.clearRate > maxScheduledClearRate) failures.push(`effects-on clear activity remained too high: ${active.clearRate.toFixed(1)}/s`);
  if (active.clearRate < 6) failures.push(`effects-on animation redraw rate was too low: ${active.clearRate.toFixed(1)}/s`);

  await prepare(page, { background: "detailed", effects: "off" });
  const inactiveAgain = await sample(2400);
  if (inactiveAgain.clearRate > 6) failures.push(`effects-off redraw loop accumulated after toggling: ${inactiveAgain.clearRate.toFixed(1)}/s`);
  return { inactive, cloudOnly, cloudOnlyFarState, cloudOnlyNearState, particlesOnly, particlesOnlyBudget, particleBufferWidth, active, inactiveAgain, failures };
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

async function prepare(page, { locale = "zh-TW", background = "detailed", lifeStream = "closed", effects = "off", enabledEffects = null } = {}) {
  if (!page.url().startsWith(baseUrl)) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  }
  await page.evaluate(({ localeValue, backgroundValue, lifeStreamValue, effectsValue, enabledEffectValues }) => {
    localStorage.setItem("canopy.locale", localeValue);
    localStorage.setItem("canopy.background", backgroundValue);
    localStorage.setItem("canopy.music", "greenhouse");
    localStorage.setItem("canopy.music.volume", "0.88");
    localStorage.setItem("canopy.bgm", "on");
    localStorage.setItem("canopy.sfx", "on");
    localStorage.setItem("canopy.fura-notebook", lifeStreamValue);
    localStorage.setItem("canopy.effects.master", effectsValue);
    ["particles", "flow", "clouds", "glow", "motion", "fura"].forEach((key) => {
      localStorage.setItem(`canopy.effects.${key}`, !enabledEffectValues || enabledEffectValues.includes(key) ? "on" : "off");
    });
  }, { localeValue: locale, backgroundValue: background, lifeStreamValue: lifeStream, effectsValue: effects, enabledEffectValues: enabledEffects });
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
  const restingBufferWidth = await canvas.evaluate((element) => element.width);
  const dragPoint = { x: canvasBox.x + canvasBox.width * 0.58, y: canvasBox.y + canvasBox.height * 0.55 };
  await page.mouse.move(dragPoint.x, dragPoint.y);
  await page.mouse.down();
  await page.mouse.move(dragPoint.x + 70, dragPoint.y + 4, { steps: 5 });
  await page.waitForTimeout(80);
  const interactionBufferWidth = await canvas.evaluate((element) => element.width);
  await page.mouse.up();
  await page.waitForTimeout(320);
  const restoredBufferWidth = await canvas.evaluate((element) => element.width);
  const failures = [];
  if (zoomDelta < 8) failures.push("wheel zoom did not materially change the scene");
  if (zoomDelta >= 8 && settleDrift > zoomDelta * 0.35) failures.push("camera moved back after wheel zoom");
  if (interactionBufferWidth > canvasBox.width * 1.08) failures.push(`camera interaction kept a ${interactionBufferWidth}px high-DPR buffer`);
  if (restingBufferWidth > canvasBox.width * 1.25 && restoredBufferWidth < restingBufferWidth * 0.9) failures.push("camera interaction DPR did not recover after settling");
  return { zoomDelta, settleDrift, restingBufferWidth, interactionBufferWidth, restoredBufferWidth, failures };
}

async function verifyControls(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  const failures = [];
  const scene = page.locator(".scene-stage");
  const renderSurface = page.locator('[data-render-policy="interaction-only"][data-shadow-policy="state-driven"]');
  if (await renderSurface.count() !== 1) failures.push("effects-off interaction-only render and shadow budgets were not active");
  const connectionCount = Number(await scene.getAttribute("data-architecture-connections"));
  const expectedConnectionCount = await page.evaluate(async () => {
    const response = await fetch("/api/snapshot");
    const { snapshot } = await response.json();
    return Array.isArray(snapshot.connections) ? snapshot.connections.length : -1;
  });
  if (connectionCount !== expectedConnectionCount) failures.push(`expected ${expectedConnectionCount} architecture connections, got ${connectionCount}`);
  await clickControl(page.getByRole("button", { name: "Seed 大腦", exact: true }).first());
  await page.waitForTimeout(450);
  const flowLabels = await page.locator(".flow-label").count();
  const detailFlows = await page.locator(".flow-list button").count();
  if (flowLabels < 2) failures.push(`expected selected neural flow labels, got ${flowLabels}`);
  if (detailFlows < 2) failures.push(`expected architecture navigation rows, got ${detailFlows}`);

  await clickControl(page.getByRole("button", { name: "總覽", exact: true }));
  await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-effect-distance") === "far");

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
  await clickControl(page.getByRole("tab", { name: "特效", exact: true }));
  const shell = page.locator(".app-shell");
  const effectsPanel = page.getByTestId("effects-settings");
  const effectsMaster = effectsPanel.getByRole("switch", { name: "特效總開關", exact: true });
  if (await effectsMaster.getAttribute("aria-checked") !== "false") failures.push("effects did not default to off for development and first use");
  await clickControl(effectsMaster);
  if ((await shell.getAttribute("data-effects")) !== "on") failures.push("effects master did not enable the scene");
  for (const key of ["flow", "glow", "motion"]) {
    if ((await shell.getAttribute(`data-effect-${key}`)) !== "on") failures.push(`${key} did not restore with effects master`);
  }
  if ((await shell.getAttribute("data-effect-distance")) !== "far") failures.push("effects settings did not retain the far camera state");
  if ((await shell.getAttribute("data-effect-particles")) !== "off" || (await shell.getAttribute("data-effect-clouds")) !== "on") failures.push("far view did not choose clouds over motes");
  if ((await shell.getAttribute("data-effect-particles-preference")) !== "on" || (await shell.getAttribute("data-effect-clouds-preference")) !== "on") failures.push("adaptive distance changed saved effect preferences");
  if (!await effectsPanel.getByText("遠景自動模式：顯示雲幕、隱藏微光。", { exact: true }).count()) failures.push("adaptive distance status was not explained in settings");
  const flowSwitch = effectsPanel.getByRole("switch", { name: "管路流動", exact: true });
  await clickControl(flowSwitch);
  if ((await shell.getAttribute("data-effect-flow")) !== "off") failures.push("flow effect did not stop independently");
  await clickControl(flowSwitch);
  const cloudSwitch = effectsPanel.getByRole("switch", { name: "流動雲幕", exact: true });
  await clickControl(cloudSwitch);
  if ((await cloudLayerStyle(page)).animationName !== "none") failures.push("cloud effect did not stop independently");
  await clickControl(cloudSwitch);
  const detailedAtmosphereStart = await cloudLayerStyle(page);
  await page.waitForTimeout(1600);
  const detailedAtmosphere = await cloudLayerStyle(page);
  const detailedCloudDrift = Math.hypot(
    detailedAtmosphere.translateX - detailedAtmosphereStart.translateX,
    detailedAtmosphere.translateY - detailedAtmosphereStart.translateY,
  );
  if (detailedAtmosphere.animationName !== "canopy-cloud-drift" || detailedAtmosphere.opacity < 0.35) failures.push("detailed drifting cloud layer was not active");
  if (!detailedAtmosphere.backgroundImage.includes("canopy-cloud-wisps.svg")) failures.push("recognizable cloud artwork was not loaded");
  if (!detailedAtmosphere.reducedMotion && detailedCloudDrift < 9) failures.push(`detailed cloud layer moved only ${detailedCloudDrift.toFixed(1)}px in 1.6s`);

  await clickControl(page.getByRole("tab", { name: "一般", exact: true }));

  const volume = page.getByRole("slider", { name: "背景音量" });
  await volume.fill("1");
  if ((await volume.inputValue()) !== "1") failures.push("BGM volume control did not reach 100%");
  if ((await page.evaluate(() => localStorage.getItem("canopy.music.volume"))) !== "1") failures.push("BGM volume preference was not persisted");
  const interactionVolume = page.getByRole("slider", { name: "互動音量" });
  await interactionVolume.fill("1");
  if ((await interactionVolume.inputValue()) !== "1") failures.push("interaction volume control did not reach 100%");
  if ((await page.evaluate(() => localStorage.getItem("canopy.sfx.volume"))) !== "1") failures.push("interaction volume preference was not persisted");
  const musicSelect = page.getByRole("combobox", { name: "自然音景", exact: true });
  const musicOptionCount = await musicSelect.locator("option").count();
  if (musicOptionCount !== 14) failures.push(`expected 14 BGM choices, got ${musicOptionCount}`);
  await musicSelect.selectOption("sacred-grove");
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
      "/assets/audio/tracks/sakuya4.mp3",
      "/assets/audio/tracks/hanagoyomi2.mp3",
      "/assets/audio/tracks/moonlit-overture.mp3",
      "/assets/audio/tracks/poema.mp3",
      "/assets/audio/tracks/deep-woods5.mp3",
      "/assets/audio/tracks/otogi3.mp3",
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
  await page.waitForTimeout(100);
  const uiClickPeakGain = await page.evaluate(() => Math.max(0, ...(globalThis.__canopyUiGainPeaks ?? [])));
  if (Math.abs(uiClickPeakGain - 0.32) > 0.002) failures.push(`100% interaction sound peak gain was ${uiClickPeakGain}, expected 0.32`);

  await pointerClick(page, page.getByRole("button", { name: "關閉背景音樂" }));
  const bgm = page.getByRole("button", { name: "播放背景音樂" });
  await bgm.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => localStorage.getItem("canopy.bgm") === "off", null, { timeout: 10000 });

  // Physical 3D hit targeting is covered separately below.  Here we are
  // verifying the detail/navigation contract, so dispatch the projected
  // label's own action without letting its moving screen-space position make
  // this control test camera-dependent.
  await scene.getByRole("button", { name: "Seed 記憶", exact: true }).evaluate((element) => element.click());
  const memoryPanel = page.locator(".detail-panel");
  await memoryPanel.getByRole("heading", { name: "Seed 記憶", exact: true }).waitFor({ timeout: 10000 });
  if (await memoryPanel.getByRole("button", { name: "探索內部結構", exact: true }).count()) failures.push("Seed Memory still exposed Seed Core as an internal child");
  await clickControl(memoryPanel.getByRole("button", { name: "進入根系記憶", exact: true }));
  await page.getByText("讓新工具延續既有習慣", { exact: true }).first().waitFor({ timeout: 10000 });
  await page.getByText("seed.capability.map_new_tools_to_habits", { exact: true }).first().waitFor({ timeout: 10000 });
  return { connectionCount, expectedConnectionCount, flowLabels, detailFlows, musicOptionCount, uiClickPeakGain, audioAssetsReady, detailedAtmosphere, detailedCloudDrift, failures };
}

async function verifyNarrowMusicSettings(page) {
  const failures = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { background: "simple" });
  await pointerClick(page, page.getByRole("button", { name: "設定" }));
  const panel = page.locator(".settings-panel");
  await panel.waitFor({ state: "visible", timeout: 10000 });
  const musicSelect = panel.getByRole("combobox", { name: "自然音景", exact: true });
  await musicSelect.scrollIntoViewIfNeeded();
  const panelBounds = await panel.boundingBox();
  const musicSelectBounds = await musicSelect.boundingBox();
  const panelMetrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (panelMetrics.scrollWidth > panelMetrics.clientWidth + 1) failures.push("narrow music settings scroll horizontally");
  if (
    !panelBounds
    || !musicSelectBounds
    || musicSelectBounds.x < 0
    || musicSelectBounds.x + musicSelectBounds.width > 390
    || musicSelectBounds.y < panelBounds.y
    || musicSelectBounds.y + musicSelectBounds.height > panelBounds.y + panelBounds.height
  ) {
    failures.push("BGM select is not reachable inside narrow settings");
  }
  const musicOptionCount = await musicSelect.locator("option").count();
  if (musicOptionCount !== 14) failures.push(`narrow BGM select has ${musicOptionCount} choices`);
  await musicSelect.selectOption("otogi3");
  await page.waitForFunction(() => localStorage.getItem("canopy.music") === "otogi3", null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio[data-canopy-bgm='otogi3']");
    return audio instanceof HTMLAudioElement && audio.readyState >= HTMLMediaElement.HAVE_METADATA;
  }, null, { timeout: 15000 });
  await musicSelect.selectOption("sakuya4");
  await page.waitForFunction(() => localStorage.getItem("canopy.music") === "sakuya4", null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio[data-canopy-bgm='sakuya4']");
    return audio instanceof HTMLAudioElement && audio.readyState >= HTMLMediaElement.HAVE_METADATA;
  }, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio[data-canopy-bgm='sakuya4']");
    return audio instanceof HTMLAudioElement && audio.volume >= 0.42;
  }, null, { timeout: 4000 });
  const sakuyaPlaybackVolume = await page.evaluate(() => {
    const audio = document.querySelector("audio[data-canopy-bgm='sakuya4']");
    return audio instanceof HTMLAudioElement ? audio.volume : null;
  });
  if (sakuyaPlaybackVolume === null || Math.abs(sakuyaPlaybackVolume - 0.44) > 0.02) {
    failures.push(`Sakuya4 safe playback trim is ${sakuyaPlaybackVolume ?? "missing"}, expected 0.44`);
  }
  await clickControl(panel.getByRole("tab", { name: "特效", exact: true }));
  const finalEffect = panel.getByRole("switch", { name: "生命單元懸浮", exact: true });
  await finalEffect.scrollIntoViewIfNeeded();
  const finalEffectBounds = await finalEffect.boundingBox();
  const effectsPanelMetrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (!finalEffectBounds || finalEffectBounds.x < 0 || finalEffectBounds.x + finalEffectBounds.width > 390) failures.push("narrow effects switches escape the settings panel");
  if (effectsPanelMetrics.scrollWidth > effectsPanelMetrics.clientWidth + 1) failures.push("narrow effects settings scroll horizontally");
  return { panelBounds, musicSelectBounds, musicOptionCount, panelMetrics, sakuyaPlaybackVolume, finalEffectBounds, effectsPanelMetrics, failures };
}

async function verifyCameraPanControls(page) {
  const failures = [];
  const labelPosition = async () => {
    const bounds = await page.getByRole("button", { name: "Seed 大腦", exact: true }).boundingBox();
    return bounds ? { x: bounds.x, y: bounds.y } : null;
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { background: "simple" });
  const desktopControls = page.getByRole("group", { name: "攝影機左右移動", exact: true });
  const desktopControlBounds = await desktopControls.boundingBox();
  const desktopHudBounds = await page.locator(".bottom-hud").boundingBox();
  if (!desktopControlBounds) failures.push("desktop camera pan controls are not visible");
  if (desktopControlBounds && desktopHudBounds && desktopControlBounds.y + desktopControlBounds.height > desktopHudBounds.y) {
    failures.push("desktop camera pan controls overlap the bottom information bar");
  }
  const desktopBefore = await labelPosition();
  await pointerClick(page, desktopControls.getByRole("button", { name: "攝影機向右移動", exact: true }));
  await page.waitForTimeout(320);
  const desktopAfterButton = await labelPosition();
  if (!desktopBefore || !desktopAfterButton || Math.abs(desktopAfterButton.x - desktopBefore.x) < 6) {
    failures.push("desktop camera right button did not visibly move the scene horizontally");
  }
  if (await page.locator(".detail-panel").count()) failures.push("camera pan button selected a living unit or opened details");
  await page.locator(".scene-stage").press("ArrowLeft");
  await page.waitForTimeout(320);
  const desktopAfterKeyboard = await labelPosition();
  if (!desktopAfterButton || !desktopAfterKeyboard || desktopAfterKeyboard.x - desktopAfterButton.x < 6) {
    failures.push("ArrowLeft did not move the camera opposite to the right control");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { background: "simple" });
  const narrowControls = page.getByRole("group", { name: "攝影機左右移動", exact: true });
  const narrowControlBounds = await narrowControls.boundingBox();
  const narrowHudBounds = await page.locator(".bottom-hud").boundingBox();
  const narrowButtonBounds = await narrowControls.getByRole("button", { name: "攝影機向左移動", exact: true }).boundingBox();
  if (!narrowControlBounds || narrowControlBounds.x < 0 || narrowControlBounds.x + narrowControlBounds.width > 390) {
    failures.push("narrow camera pan controls escape the viewport");
  }
  if (!narrowButtonBounds || narrowButtonBounds.width < 44 || narrowButtonBounds.height < 44) {
    failures.push("narrow camera pan control is smaller than a 44px touch target");
  }
  if (narrowControlBounds && narrowHudBounds && narrowControlBounds.y + narrowControlBounds.height > narrowHudBounds.y) {
    failures.push("narrow camera pan controls overlap the bottom information bar");
  }
  const narrowBefore = await labelPosition();
  await pointerClick(page, narrowControls.getByRole("button", { name: "攝影機向左移動", exact: true }));
  await page.waitForTimeout(320);
  const narrowAfter = await labelPosition();
  if (!narrowBefore || !narrowAfter || Math.abs(narrowAfter.x - narrowBefore.x) < 6) {
    failures.push("narrow touch control did not visibly move the scene horizontally");
  }
  if (await page.locator(".detail-panel").count()) failures.push("narrow camera pan selected a living unit or opened details");
  return {
    desktopControlBounds,
    desktopBefore,
    desktopAfterButton,
    desktopAfterKeyboard,
    narrowControlBounds,
    narrowButtonBounds,
    narrowBefore,
    narrowAfter,
    failures,
  };
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
  const shellPoint = {
    x: canvasBox.x + canvasBox.width * 0.625,
    y: canvasBox.y + canvasBox.height * 0.767,
  };
  const shellPointElement = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? "", shellPoint);
  let shellTitle = "";
  if (shellPointElement !== "CANVAS") {
    failures.push(`blank shell test point was occluded by ${shellPointElement || "nothing"}`);
  } else {
    await page.mouse.click(shellPoint.x, shellPoint.y);
    await page.waitForTimeout(450);
    shellTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
    if (shellTitle !== "Canopy 宿主") failures.push(`blank shell selected ${shellTitle || "nothing"}`);
  }

  await prepare(page, { background: "none" });
  await page.mouse.click(shellPoint.x, shellPoint.y);
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

  await prepare(page, { background: "detailed" });
  await clickOrganBody(page, "Seed 核心", 1440);
  await page.waitForTimeout(450);
  const corePanel = page.locator(".detail-panel");
  const coreTitle = await corePanel.locator("h2").innerText().catch(() => "");
  if (coreTitle !== "Seed 核心") failures.push(`Seed Core body selected ${coreTitle || "nothing"}`);
  if (!await corePanel.getByText("核心契約", { exact: true }).count()) failures.push("Seed Core flow to Brain was not visible");
  const coreExplore = corePanel.getByRole("button", { name: "探索內部結構", exact: true });
  if ((await coreExplore.count()) !== 1) failures.push("Seed Core did not expose its own structure");
  if (await coreExplore.count()) {
    await clickControl(coreExplore);
    await page.waitForTimeout(350);
    const coreScope = await corePanel.getAttribute("data-navigation-scope");
    const coreDepth = await corePanel.getAttribute("data-navigation-depth");
    if (coreScope !== "inside" || coreDepth !== "2") failures.push(`Seed Core navigation state was ${coreScope}/${coreDepth}`);
    const coreSystem = corePanel.locator(".structure-relations button").filter({ hasText: "Seed Core" }).first();
    if (!await coreSystem.count()) failures.push("Seed Core structure did not contain its contract system");
    else {
      await clickControl(coreSystem);
      await page.waitForTimeout(300);
      if (!await corePanel.locator(".structure-relations button").filter({ hasText: "core" }).count()) failures.push("Seed Core contract paths were not reachable");
    }
  }

  const narrowResults = [];
  for (const background of ["detailed", "simple", "none"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepare(page, { background });
    await pointerClick(page, page.getByRole("button", { name: "Seed 大腦", exact: true }));
    await page.waitForTimeout(450);
    const labelDetailTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
    const labelStructureTrail = await page.locator(".structure-breadcrumb").count();
    if (labelDetailTitle !== "Seed 大腦") failures.push(`narrow ${background}: living-unit label selected ${labelDetailTitle || "nothing"}`);
    if (labelStructureTrail) failures.push(`narrow ${background}: living-unit label entered structure view`);

    await prepare(page, { background });
    await clickOrganBody(page, "Seed 大腦", 390);
    await page.waitForTimeout(450);
    const detailTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
    const structureTrail = await page.locator(".structure-breadcrumb").count();
    if (detailTitle !== "Seed 大腦") failures.push(`narrow ${background}: direct living-unit body selected ${detailTitle || "nothing"}`);
    if (structureTrail) failures.push(`narrow ${background}: direct living-unit body entered structure view`);
    narrowResults.push({ background, labelDetailTitle, labelStructureTrail, detailTitle, structureTrail });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { background: "simple" });
  await pointerClick(page, page.getByRole("button", { name: "演化年輪", exact: true }));
  await page.waitForTimeout(450);
  const evolutionPanel = page.locator(".detail-panel");
  const embeddedEvolutionLabCount = await evolutionPanel.locator(".evolution-lab").count();
  if (embeddedEvolutionLabCount) failures.push("Evolution Rings still embedded the laboratory research view");
  const narrowLaboratoryLink = evolutionPanel.getByRole("button", { name: "前往實驗室", exact: true });
  if (!await narrowLaboratoryLink.count()) failures.push("Evolution Rings did not expose the related laboratory facility");
  else await clickControl(narrowLaboratoryLink);
  await page.waitForTimeout(450);
  const narrowLaboratoryPanel = page.locator(".detail-panel.laboratory-detail");
  const narrowLaboratoryVisible = await narrowLaboratoryPanel.isVisible().catch(() => false);
  const narrowLaboratoryView = await page.locator(".app-shell").getAttribute("data-view");
  if (!narrowLaboratoryVisible || narrowLaboratoryView !== "laboratory") failures.push("narrow laboratory facility did not open as its own UI view");
  if (!await narrowLaboratoryPanel.getByText("這是生命體系統的 UI 設施", { exact: false }).count()) failures.push("laboratory did not disclose its UI-only boundary");

  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { background: "detailed" });
  const laboratorySceneButton = page.getByRole("button", { name: "實驗室", exact: true });
  const laboratorySceneVisible = await laboratorySceneButton.isVisible().catch(() => false);
  if (!laboratorySceneVisible) failures.push("3D overview did not render the laboratory facility");
  else await pointerClick(page, laboratorySceneButton);
  await page.waitForTimeout(450);
  const laboratoryPanel = page.locator(".detail-panel.laboratory-detail");
  const laboratoryTitle = await laboratoryPanel.locator("h2").innerText().catch(() => "");
  const evolutionRuntimeBoundaryVisible = await laboratoryPanel.locator(".lab-runtime-link").isVisible().catch(() => false);
  if (laboratoryTitle !== "實驗室") failures.push(`3D laboratory opened ${laboratoryTitle || "nothing"}`);
  if (!evolutionRuntimeBoundaryVisible) failures.push("laboratory did not explain its relationship to Evolution Runtime");
  const returnToEvolution = laboratoryPanel.getByRole("button", { name: "查看演化年輪", exact: true });
  if (await returnToEvolution.count()) {
    await clickControl(returnToEvolution);
    await page.waitForTimeout(350);
  }
  const evolutionReturnTitle = await page.locator(".detail-panel h2").innerText().catch(() => "");
  if (evolutionReturnTitle !== "演化年輪") failures.push(`laboratory did not return to Evolution Rings (${evolutionReturnTitle || "nothing"})`);

  await prepare(page, { background: "detailed" });
  await pointerClick(page, page.getByRole("button", { name: "演化年輪", exact: true }));
  await page.waitForTimeout(350);
  await clickControl(page.locator(".detail-panel").getByRole("button", { name: "探索內部結構", exact: true }));
  await page.waitForTimeout(450);
  const evolutionInteriorPanel = page.locator(".detail-panel");
  const evolutionInteriorScrollTop = await evolutionInteriorPanel.evaluate((element) => element.scrollTop);
  const evolutionInteriorEmbeddedLabCount = await evolutionInteriorPanel.locator(".evolution-lab").count();
  if (evolutionInteriorScrollTop > 1) failures.push(`Evolution interior reused a stale detail scroll position (${evolutionInteriorScrollTop})`);
  if (evolutionInteriorEmbeddedLabCount) failures.push("Evolution Runtime structure still embedded laboratory content");
  const structureCanvas = page.locator("canvas");
  const structureCanvasBounds = await structureCanvas.boundingBox();
  if (!structureCanvasBounds) throw new Error("structure canvas has no interaction bounds");
  const structureDragStart = {
    x: structureCanvasBounds.x + structureCanvasBounds.width * 0.34,
    y: structureCanvasBounds.y + structureCanvasBounds.height * 0.48,
  };
  await page.mouse.move(structureDragStart.x, structureDragStart.y);
  await page.mouse.down();
  await page.mouse.move(structureDragStart.x + 76, structureDragStart.y + 9, { steps: 7 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  const structureLaboratoryLinkAfterDrag = await evolutionInteriorPanel.getByRole("button", { name: "前往實驗室", exact: true }).isVisible().catch(() => false);
  if (!structureLaboratoryLinkAfterDrag) failures.push("structure camera movement hid the laboratory relationship entry");

  return {
    modeResults,
    narrowResults,
    dragDetailCount,
    dragStructureCount,
    rotatedDetailTitle,
    shellTitle,
    leafTitle,
    coreTitle,
    embeddedEvolutionLabCount,
    narrowLaboratoryVisible,
    narrowLaboratoryView,
    laboratorySceneVisible,
    laboratoryTitle,
    evolutionReturnTitle,
    evolutionInteriorScrollTop,
    evolutionInteriorEmbeddedLabCount,
    structureLaboratoryLinkAfterDrag,
    evolutionRuntimeBoundaryVisible,
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
  const latestGrowth = await page.locator(".scene-stage").evaluate((element) => ({
    scale: Number(element.getAttribute("data-tree-maturity-scale")),
    evidence: Number(element.getAttribute("data-tree-maturity-evidence")),
  }));
  if (days > 1) {
    await clickControl(timeline.getByRole("listitem").first());
    await page.waitForTimeout(120);
  }
  const earliestGrowth = await page.locator(".scene-stage").evaluate((element) => ({
    scale: Number(element.getAttribute("data-tree-maturity-scale")),
    evidence: Number(element.getAttribute("data-tree-maturity-evidence")),
  }));
  if (earliestGrowth.scale > latestGrowth.scale || earliestGrowth.evidence > latestGrowth.evidence) {
    failures.push(`historical tree growth was not monotonic: ${JSON.stringify({ earliestGrowth, latestGrowth })}`);
  }
  await clickControl(timeline.getByRole("button", { name: "回到現在", exact: true }));
  const restoredGrowth = await page.locator(".scene-stage").evaluate((element) => ({
    scale: Number(element.getAttribute("data-tree-maturity-scale")),
    evidence: Number(element.getAttribute("data-tree-maturity-evidence")),
    stored: Number(localStorage.getItem("canopy.tree.maturity-evidence.v1")),
  }));
  if (restoredGrowth.scale < latestGrowth.scale || restoredGrowth.evidence < latestGrowth.evidence || restoredGrowth.stored < latestGrowth.evidence) {
    failures.push(`current tree maturity shrank after history playback: ${JSON.stringify({ latestGrowth, restoredGrowth })}`);
  }

  const dateLabel = timeline.locator(".timeline-date-row strong");
  const before = await dateLabel.innerText();
  await clickControl(timeline.getByRole("button", { name: "前一天", exact: true }));
  const previous = await dateLabel.innerText();
  if (before === previous) failures.push("activity previous-day control did not change the date");
  await clickControl(timeline.getByRole("button", { name: "播放成長歷程", exact: true }));
  await page.waitForTimeout(1300);
  const replayed = await dateLabel.innerText();
  if (replayed === previous) failures.push("activity playback did not advance the date");

  const activeDate = await page.evaluate(async () => {
    const response = await fetch("/api/snapshot");
    const { snapshot } = await response.json();
    return [...(snapshot.activity?.daily ?? [])].reverse().find((day) => (
      Object.values(day.module_counts ?? {}).some((count) => Number(count) > 0)
    ))?.date ?? "";
  });
  if (activeDate) {
    await clickControl(timeline.getByRole("listitem", { name: new RegExp(`^${activeDate},`) }));
  }
  const activeModule = timeline.locator('.timeline-modules button[data-module-id="seed-memory"]:not(:disabled)');
  await activeModule.waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined);
  if (!activeDate || !await activeModule.count()) throw new Error("activity projection has no selectable living-unit evidence day");
  await clickControl(activeModule);
  await page.locator(".recent-activity").waitFor({ state: "visible", timeout: 10000 });

  await prepare(page);
  const closureSignal = page.getByRole("button", { name: /必要閉環失敗/ }).first();
  let closureTreatmentVisible = false;
  if (await closureSignal.count()) {
    await clickControl(closureSignal);
    const closureInspector = page.getByRole("dialog", { name: "健康異常詳情" });
    await closureInspector.waitFor({ state: "visible", timeout: 10000 });
    closureTreatmentVisible = await closureInspector.getByRole("button", { name: "改善後續回合的閉環", exact: true }).isVisible().catch(() => false);
    if (!closureTreatmentVisible) failures.push("required lifecycle summary still has no canonical treatment route");
    if (!await closureInspector.getByText("不會補造歷史證據", { exact: false }).count()) failures.push("closure treatment did not explain its truthful historical boundary");
    if (!await closureInspector.getByText("可立即開始診斷與修正", { exact: true }).count()) failures.push("actionable closure issue still reports an unavailable handling state");
    if (await closureInspector.getByText("Use reconciliation", { exact: false }).count()) failures.push("closure inspector leaked untranslated engineering instructions");
    await clickControl(closureInspector.getByRole("button", { name: "關閉資訊", exact: true }));
  }
  let actionableIssueSurfaces = 0;
  if (await closureSignal.count()) {
    await clickControl(closureSignal);
    const issueInspector = page.getByRole("dialog", { name: "健康異常詳情" });
    await issueInspector.waitFor({ state: "visible", timeout: 10000 });
    const issuePosition = await issueInspector.locator(".issue-inspector-controls span").innerText();
    const issueTotal = Number(issuePosition.split("/")[1] || 0);
    for (let index = 0; index < issueTotal; index += 1) {
      const action = issueInspector.locator(".issue-treatment-command");
      if (await action.isVisible().catch(() => false)) actionableIssueSurfaces += 1;
      else failures.push(`issue ${index + 1}/${issueTotal} has no treatment or evidence recheck measure`);
      if (index < issueTotal - 1) await clickControl(issueInspector.getByRole("button", { name: "下一項提醒", exact: true }));
    }
    await clickControl(issueInspector.getByRole("button", { name: "關閉資訊", exact: true }));
  }
  await clickControl(page.getByRole("button", { name: "Seed 大腦", exact: true }));
  const brainPanel = page.locator(".detail-panel");
  await brainPanel.getByRole("heading", { name: "Seed 大腦", exact: true }).waitFor();
  await clickControl(brainPanel.getByRole("button", { name: "診斷並治療這項問題", exact: true }).first());
  const remediationDialog = page.getByRole("dialog", { name: "診斷與修正" });
  await remediationDialog.waitFor({ state: "visible", timeout: 10000 });
  if (!await remediationDialog.getByRole("button", { name: /在這裡治療/ }).count()) {
    failures.push("embedded treatment mode still uses technical interface wording");
  }
  const modelSelect = remediationDialog.getByLabel("Codex 模型");
  const effortSelect = remediationDialog.getByLabel("推理強度");
  await modelSelect.locator("option").nth(1).waitFor({ state: "attached", timeout: 10000 }).catch(() => undefined);
  await effortSelect.locator("option").nth(1).waitFor({ state: "attached", timeout: 10000 }).catch(() => undefined);
  const modelOptions = await modelSelect.locator("option").count();
  const effortOptions = await effortSelect.locator("option").count();
  if (modelOptions < 2) failures.push("living-unit treatment did not expose selectable Codex models");
  if (effortOptions < 2) failures.push("living-unit treatment did not expose selectable reasoning efforts");
  if (!await remediationDialog.getByRole("button", { name: "開始診斷", exact: true }).count()) {
    failures.push("living-unit treatment did not use the canonical diagnosis flow");
  }
  await clickControl(remediationDialog.getByRole("button", { name: "關閉資訊", exact: true }));

  await prepare(page);
  await clickControl(page.getByRole("button", { name: "Seed 記憶", exact: true }));
  await clickControl(page.locator(".detail-panel").getByRole("button", { name: "進入根系記憶", exact: true }));
  await clickControl(page.getByRole("button", { name: "新增記憶提案", exact: true }));
  await page.getByRole("heading", { name: "提出新的 Seed 記憶", exact: true }).waitFor();
  await clickControl(page.getByRole("button", { name: "關閉", exact: true }));
  return { days, before, previous, replayed, latestGrowth, earliestGrowth, restoredGrowth, closureTreatmentVisible, actionableIssueSurfaces, modelOptions, effortOptions, failures };
}

async function verifyLifeStream(page) {
  const failures = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { lifeStream: "open" });
  const panel = page.locator(".life-stream-panel");
  await panel.waitFor({ state: "visible", timeout: 15000 });
  await clickControl(panel.getByRole("button", { name: "收合生命歷程", exact: true }));
  const desktopFura = page.locator(".fura-companion");
  await desktopFura.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(260);
  const desktopFuraBounds = await desktopFura.boundingBox();
  if ((await panel.count()) !== 0) failures.push("closed Fura notebook remained in the layout");
  if (!desktopFuraBounds || desktopFuraBounds.x + desktopFuraBounds.width > 1440) {
    failures.push("desktop Fura notebook control escapes the viewport");
  }
  await clickControl(desktopFura.getByRole("button", { name: "打開芙拉的記事本", exact: true }));
  await panel.waitFor({ state: "visible", timeout: 10000 });
  const eventCount = await panel.locator(".life-event").count();
  const privacyVisible = await panel.getByText("不保存原始 prompt", { exact: false }).isVisible();
  const retentionCopy = await panel.locator(".life-stream-footer span:not(.life-coverage-note)").innerText();
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
      containsRawToolInput: serialized.includes("tool_input") || serialized.includes("tool_response"),
    };
  });
  if (!eventCount) failures.push("life history contains no visible activity events");
  if (!privacyVisible) failures.push("life history privacy boundary is not visible");
  if (!retentionCopy.includes("60 天")) failures.push(`life history retention copy was ${retentionCopy}`);
  if (!apiContract.ok || !apiContract.total) failures.push("life event SQLite projection is empty or unavailable");
  if (apiContract.retentionDays !== 60) failures.push(`life event retention was ${apiContract.retentionDays}`);
  if (apiContract.containsRawToolInput) failures.push("life event API leaked raw tool input or response");

  // A live Core may currently have only blocked/running turns. Every turn story
  // must expose the same evidence sections, so inspect the first real turn
  // instead of coupling the UI contract to one translated status word.
  const inspectableTurn = panel.locator('.life-event[data-kind="turn_story"]').first();
  await clickControl(inspectableTurn.locator(".life-event-main"));
  await page.waitForTimeout(350);
  const eventDetails = inspectableTurn.locator(".life-event-details");
  const eventDetailsVisible = await eventDetails.isVisible().catch(() => false);
  const learningStatus = inspectableTurn.locator(".life-learning-status");
  const learningStatusVisible = await learningStatus.isVisible().catch(() => false);
  const learningStatusText = learningStatusVisible ? await learningStatus.innerText() : "";
  const expandedPanelBounds = await panel.boundingBox();
  const expandedVisibleEvents = await panel.locator('.life-event:visible').count();
  if (!eventDetailsVisible) failures.push("clicking a life event did not reveal its turn details");
  const storySections = eventDetailsVisible
    ? await eventDetails.locator("[data-section]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-section")))
    : [];
  if (eventDetailsVisible && !["outcome", "intervention", "verification"].every((section) => storySections.includes(section))) {
    failures.push("life turn story does not separate outcome, Canopy intervention, verification, and learning evidence");
  }
  if (!learningStatusVisible || !learningStatusText.includes("本回合學習判定")) {
    failures.push("life event details do not distinguish learning from ordinary completion");
  }
  if (!expandedPanelBounds || expandedPanelBounds.width < 420 || expandedPanelBounds.height < 650) {
    failures.push(`expanded Fura notebook is still too small for one event: ${JSON.stringify(expandedPanelBounds)}`);
  }
  if (expandedVisibleEvents !== 1) failures.push(`expanded Fura notebook retained ${expandedVisibleEvents} competing event rows`);
  const detail = page.locator(".detail-panel");
  await clickControl(panel.getByRole("button", { name: "收合生命歷程", exact: true }));
  await desktopFura.waitFor({ state: "visible", timeout: 10000 });
  await clickControl(page.getByRole("button", { name: "總覽", exact: true }));
  await page.waitForTimeout(1800);
  await clickControl(page.getByRole("button", { name: "Seed 大腦", exact: true }).first());
  await page.waitForTimeout(350);
  await detail.waitFor({ state: "visible", timeout: 10000 });
  const detailBounds = await detail.boundingBox();
  const desktopFuraWithDetailBounds = await desktopFura.boundingBox();
  const desktopFuraBubbleWithDetailBounds = await desktopFura.locator(".fura-guidance").boundingBox().catch(() => null);
  const overlaps = (left, right) => Boolean(
    left && right
    && left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
  if (
    !detailBounds
    || !desktopFuraWithDetailBounds
    || overlaps(desktopFuraWithDetailBounds, detailBounds)
    || overlaps(desktopFuraBubbleWithDetailBounds, detailBounds)
  ) {
    failures.push("desktop Fura companion overlaps selected-unit details");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { background: "simple", lifeStream: "open" });
  const narrowPanel = page.locator(".life-stream-panel");
  const narrowBounds = await narrowPanel.boundingBox();
  if (!narrowBounds || narrowBounds.x < 0 || narrowBounds.x + narrowBounds.width > 390 || narrowBounds.y + narrowBounds.height > 844) {
    failures.push("narrow life history escapes the viewport");
  }
  await clickControl(narrowPanel.getByRole("button", { name: "收合生命歷程", exact: true }));
  const narrowFura = page.locator(".fura-companion");
  await narrowFura.waitFor({ state: "visible", timeout: 10000 });
  const narrowFuraBounds = await narrowFura.boundingBox();
  if (!narrowFuraBounds || narrowFuraBounds.x < 0 || narrowFuraBounds.x + narrowFuraBounds.width > 390) {
    failures.push("narrow Fura notebook control escapes the viewport");
  }
  if ((await narrowPanel.count()) !== 0) failures.push("narrow notebook did not fully collapse back into Fura");
  // This stage verifies that collapsing the notebook returns interaction to the
  // scene. Body raycasting across all modes/viewports is covered separately by
  // verifyPickingAndNavigation, so use the projected scene label here to avoid
  // coupling this assertion to a second camera-coordinate calculation.
  await page.getByRole("button", { name: "Seed 大腦", exact: true }).click();
  await page.waitForTimeout(350);
  const narrowSelection = await page.locator(".detail-panel h2").innerText().catch(() => "");
  if (narrowSelection !== "Seed 大腦") failures.push(`collapsed narrow life history prevented 3D selection: ${narrowSelection || "nothing"}`);
  return { desktopFuraBounds, desktopFuraWithDetailBounds, desktopFuraBubbleWithDetailBounds, eventCount, retentionCopy, apiContract, eventDetailsVisible, learningStatusVisible, learningStatusText, expandedPanelBounds, expandedVisibleEvents, narrowFuraBounds, narrowSelection, failures };
}

async function verifyFuraCompanion(page) {
  const failures = [];
  await page.goto("about:blank");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.evaluate(() => localStorage.removeItem("canopy.fura.position.v1"));
  const intersects = (left, right) => Boolean(
    left && right
    && left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
  const rectangleGap = (left, right) => {
    if (!left || !right) return Number.POSITIVE_INFINITY;
    const horizontal = Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), 0);
    const vertical = Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height), 0);
    return Math.hypot(horizontal, vertical);
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await prepare(page, { background: "simple", effects: "on", enabledEffects: ["fura"] });
  const companion = page.locator(".fura-companion");
  await companion.waitFor({ state: "visible", timeout: 15000 });
  const restartFuraMotion = async () => {
    // Keep the synthetic pointer away from Fura's roaming corridor. Hovering
    // her intentionally freezes motion so a real operator can click or drag.
    await page.mouse.move(2, 2);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    await companion.waitFor({ state: "visible", timeout: 15000 });
    // The guidance response restarts Fura's first notebook-to-walk sequence.
    // Begin sampling from that contract-backed state instead of relying on an
    // arbitrary scene-settle delay that can miss the outward walk.
    await companion.locator(".fura-guidance").waitFor({ state: "visible", timeout: 10000 });
  };
  await restartFuraMotion();
  // Initial layout collision resolution can restart the first idle sequence.
  // Begin the gait assertions only after an actual walking step starts instead
  // of assuming a fixed wall-clock offset from page load.
  await page.waitForFunction(() => document.querySelector(".fura-companion")?.getAttribute("data-roaming") === "true", null, { timeout: 20000 });
  const collapsedBubble = companion.locator(".fura-guidance");
  const heartbeatMetrics = await companion.locator(".fura-heartbeat").evaluate((element) => {
    const heart = element.getBoundingClientRect();
    const character = element.parentElement?.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      xRatio: character ? (heart.x + heart.width / 2 - character.x) / character.width : 0,
      yRatio: character ? (heart.y + heart.height / 2 - character.y) / character.height : 0,
      animationName: style.animationName,
      mixBlendMode: style.mixBlendMode,
    };
  });
  if (heartbeatMetrics.xRatio < 0.39 || heartbeatMetrics.xRatio > 0.57 || heartbeatMetrics.yRatio < 0.63 || heartbeatMetrics.yRatio > 0.78) {
    failures.push(`Fura heartbeat glow is not aligned with her chest heart: ${JSON.stringify(heartbeatMetrics)}`);
  }
  if (!heartbeatMetrics.animationName.includes("fura-heartbeat") || heartbeatMetrics.mixBlendMode !== "screen") {
    failures.push(`Fura chest heart does not use the intended lightweight glow: ${JSON.stringify(heartbeatMetrics)}`);
  }
  const collapsedBubbleBounds = await collapsedBubble.boundingBox();
  const collapsedBubbleText = (await collapsedBubble.innerText()).trim();
  if (await companion.getAttribute("data-guidance-expanded") !== "false") failures.push("narrow Fura guidance did not start collapsed");
  if (!collapsedBubbleBounds || collapsedBubbleBounds.width > 48 || collapsedBubbleBounds.height > 48) {
    failures.push(`collapsed Fura guidance still occupies a row: ${JSON.stringify(collapsedBubbleBounds)}`);
  }
  if (collapsedBubbleText !== "…") failures.push(`collapsed Fura guidance showed ${JSON.stringify(collapsedBubbleText)} instead of an ellipsis`);
  const guidanceTail = companion.locator(".fura-guidance-tail");
  const guidanceTailBounds = await guidanceTail.boundingBox().catch(() => null);
  const guidanceTailSide = await guidanceTail.getAttribute("data-side").catch(() => null);
  const bubblePlacement = await companion.getAttribute("data-bubble-placement");
  if (!guidanceTailBounds || !["left", "right", "above", "below"].includes(guidanceTailSide ?? "")) {
    failures.push(`Fura guidance is missing its manga speech-bubble tail: ${guidanceTailSide ?? "none"}`);
  }
  if (guidanceTailSide !== bubblePlacement) failures.push(`Fura guidance tail points ${guidanceTailSide} while its bubble is placed ${bubblePlacement}`);
  const poses = [];
  const movementSamples = [];
  const bubbleMovementSamples = [];
  const bubbleGaps = [];
  const bubbleOffsets = [];
  const spriteAnimations = [];
  const storedBeforeRoam = await page.evaluate(() => localStorage.getItem("canopy.fura.position.v1"));
  for (let index = 0; index < 32; index += 1) {
    poses.push(await companion.getAttribute("data-pose"));
    const bounds = await companion.locator(".fura-character-button").boundingBox();
    const roamBounds = await companion.locator(".fura-roam-layer").boundingBox();
    const movingBubbleBounds = await collapsedBubble.boundingBox();
    if (bounds) movementSamples.push({ x: bounds.x, y: bounds.y });
    if (movingBubbleBounds) bubbleMovementSamples.push({ x: movingBubbleBounds.x, y: movingBubbleBounds.y });
    if (bounds && movingBubbleBounds) {
      bubbleGaps.push(rectangleGap(bounds, movingBubbleBounds));
    }
    // Compare the bubble to Fura's shared roaming layer. Her character button
    // intentionally bobs, stretches, and sits inside that layer, which should
    // not be mistaken for the attached bubble drifting away.
    if (roamBounds && movingBubbleBounds) {
      bubbleOffsets.push({ x: movingBubbleBounds.x - roamBounds.x, y: movingBubbleBounds.y - roamBounds.y });
    }
    spriteAnimations.push(await companion.locator(".fura-sprite").evaluate((element) => getComputedStyle(element).animationName));
    await page.waitForTimeout(250);
  }
  const displacement = movementSamples.reduce((maximum, sample) => (
    Math.max(maximum, ...movementSamples.map((candidate) => Math.hypot(candidate.x - sample.x, candidate.y - sample.y)))
  ), 0);
  const distinctPositions = new Set(movementSamples.map((sample) => `${Math.round(sample.x / 3)}:${Math.round(sample.y / 3)}`)).size;
  const largestSampleStep = movementSamples.slice(1).reduce((maximum, sample, index) => (
    Math.max(maximum, Math.hypot(sample.x - movementSamples[index].x, sample.y - movementSamples[index].y))
  ), 0);
  const bubbleDisplacement = bubbleMovementSamples.reduce((maximum, sample) => (
    Math.max(maximum, ...bubbleMovementSamples.map((candidate) => Math.hypot(candidate.x - sample.x, candidate.y - sample.y)))
  ), 0);
  const maximumBubbleGap = Math.max(0, ...bubbleGaps);
  const bubbleOffsetDrift = bubbleOffsets.reduce((maximum, sample) => (
    Math.max(maximum, ...bubbleOffsets.map((candidate) => Math.hypot(candidate.x - sample.x, candidate.y - sample.y)))
  ), 0);
  const storedAfterRoam = await page.evaluate(() => localStorage.getItem("canopy.fura.position.v1"));
  if (!poses.includes("walk-left") || !poses.includes("walk-right")) {
    failures.push(`Fura did not visibly walk during the initial motion window: ${[...new Set(poses)].join(", ")}`);
  }
  if (displacement < 24 || distinctPositions < 5) {
    failures.push(`Fura motion was not spatially continuous (${displacement.toFixed(1)}px across ${distinctPositions} positions)`);
  }
  if (largestSampleStep > 42) failures.push(`Fura movement jumped ${largestSampleStep.toFixed(1)}px between samples`);
  if (bubbleMovementSamples.length !== movementSamples.length || bubbleDisplacement < 20) {
    failures.push(`Fura's collapsed speech bubble did not travel with her (${bubbleDisplacement.toFixed(1)}px)`);
  }
  if (maximumBubbleGap > 4 || bubbleOffsetDrift > 4) {
    failures.push(`Fura's collapsed speech bubble drifted away (${maximumBubbleGap.toFixed(1)}px gap, ${bubbleOffsetDrift.toFixed(1)}px relative drift)`);
  }
  if (!spriteAnimations.some((name) => name.includes("fura-walk"))) failures.push("Fura walked without a multi-frame gait animation");
  if (storedAfterRoam !== storedBeforeRoam) failures.push("automatic Fura motion overwrote the operator's parked position");
  if (await companion.getAttribute("data-motion") !== "active") failures.push("Fura motion was not active when only her effect was enabled");
  if (await companion.locator(".fura-drag-hint").count()) failures.push("Fura still rendered a visible drag symbol");

  await clickControl(collapsedBubble.getByRole("button", { name: "展開芙拉的訊息", exact: true }));
  await page.waitForTimeout(220);
  const expandedBubbleBounds = await collapsedBubble.boundingBox();
  if (await companion.getAttribute("data-guidance-expanded") !== "true") failures.push("Fura guidance did not expand from the speech bubble");
  if (!expandedBubbleBounds || expandedBubbleBounds.width < 160 || expandedBubbleBounds.height <= 48) {
    failures.push(`expanded Fura guidance did not become a readable manga bubble: ${JSON.stringify(expandedBubbleBounds)}`);
  }
  if (!(await guidanceTail.boundingBox().catch(() => null))) failures.push("expanded Fura guidance lost its speech-bubble tail");
  await clickControl(collapsedBubble.getByRole("button", { name: "收合芙拉的訊息", exact: true }));
  await page.waitForTimeout(180);

  // Start a fresh deterministic first sequence before testing interruption;
  // the sampling window above legitimately finishes that first walk.
  await restartFuraMotion();
  await page.waitForFunction(() => document.querySelector(".fura-companion")?.getAttribute("data-roaming") === "true", null, { timeout: 12000 });
  const movingBounds = await companion.locator(".fura-character-button").boundingBox();
  if (movingBounds) {
    await page.mouse.move(movingBounds.x + movingBounds.width / 2, movingBounds.y + movingBounds.height / 2);
    await page.waitForTimeout(180);
  }
  const hoverStoppedAt = await companion.locator(".fura-character-button").boundingBox();
  await page.waitForTimeout(650);
  const hoverStoppedLater = await companion.locator(".fura-character-button").boundingBox();
  if (!hoverStoppedAt || !hoverStoppedLater || Math.hypot(hoverStoppedLater.x - hoverStoppedAt.x, hoverStoppedLater.y - hoverStoppedAt.y) > 2) {
    failures.push("Fura did not stop smoothly when the operator hovered to interact");
  }
  await page.mouse.move(4, 4);
  await page.waitForTimeout(180);

  const beforeDrag = await companion.locator(".fura-character-button").boundingBox();
  if (beforeDrag) {
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 - 80, beforeDrag.y + beforeDrag.height / 2 - 72, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
  const afterDrag = await companion.locator(".fura-character-button").boundingBox();
  const storedPosition = await page.evaluate(() => localStorage.getItem("canopy.fura.position.v1"));
  if (!beforeDrag || !afterDrag || Math.hypot(afterDrag.x - beforeDrag.x, afterDrag.y - beforeDrag.y) < 35) {
    failures.push("dragging Fura did not move her character");
  }
  if ((await page.locator(".life-stream-panel").count()) !== 0) failures.push("dragging Fura accidentally opened her notebook");
  if (!storedPosition) failures.push("Fura position was not saved after drop");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await companion.waitFor({ state: "visible", timeout: 15000 });
  const afterReload = await companion.boundingBox();
  if (!afterDrag || !afterReload || Math.hypot(afterReload.x - afterDrag.x, afterReload.y - afterDrag.y) > 4) {
    failures.push("Fura did not restore her saved position after reload");
  }

  const characterBounds = await companion.locator(".fura-character-button").boundingBox();
  const bubbleBounds = await companion.locator(".fura-guidance").boundingBox().catch(() => null);
  const cameraBounds = await page.locator(".camera-pan-controls").boundingBox();
  const hudBounds = await page.locator(".bottom-hud").boundingBox();
  if (!characterBounds || characterBounds.width < 44 || characterBounds.height < 44) failures.push("Fura character control is smaller than 44px");
  if (intersects(characterBounds, cameraBounds) || intersects(characterBounds, hudBounds)) failures.push("narrow Fura character overlaps camera controls or bottom HUD");
  if (intersects(bubbleBounds, cameraBounds) || intersects(bubbleBounds, hudBounds)) failures.push("narrow Fura guidance overlaps camera controls or bottom HUD");

  const guidanceActions = companion.locator(".fura-guidance-actions button:visible");
  for (let index = 0; index < await guidanceActions.count(); index += 1) {
    const bounds = await guidanceActions.nth(index).boundingBox();
    if (!bounds || bounds.width < 44 || bounds.height < 44) failures.push("a Fura guidance action is smaller than 44px");
  }

  await clickControl(companion.getByRole("button", { name: "打開芙拉的記事本", exact: true }));
  const notebook = page.locator(".life-stream-panel");
  await notebook.waitFor({ state: "visible", timeout: 10000 });
  // Bounding boxes are temporarily scaled by the 220ms notebook-open
  // animation. Measure the settled touch targets, not an in-between frame.
  await page.waitForTimeout(300);
  const notebookTargetMetrics = await notebook
    .locator(".life-heading-actions .icon-button, .life-filters button, .life-stream-footer button")
    .evaluateAll((elements) => elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || bounds.width <= 0 || bounds.height <= 0) return [];
      return [{ width: bounds.width, height: bounds.height }];
    }));
  for (const bounds of notebookTargetMetrics) {
    // Chromium can report an authored 44px target as 43.999... after device
    // scaling. Round CSS pixels so a subpixel float does not become a false
    // accessibility failure; a genuinely smaller target still fails.
    if (Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44) failures.push("a Fura notebook action is smaller than 44px");
  }
  await clickControl(notebook.getByRole("button", { name: "收合生命歷程", exact: true }));

  await clickControl(page.getByRole("button", { name: "歷程", exact: true }));
  await page.locator(".activity-timeline").waitFor({ state: "visible", timeout: 10000 });
  if ((await page.locator(".fura-companion").count()) !== 0) failures.push("Fura remained visible over the narrow activity timeline");

  await prepare(page, { background: "simple", effects: "off" });
  const pausedByMaster = await page.locator(".fura-companion").getAttribute("data-motion");
  if (pausedByMaster !== "paused") failures.push("Fura did not pause with the visual-effects master off");

  await prepare(page, { background: "simple", effects: "on", enabledEffects: ["motion"] });
  const pausedIndividually = await page.locator(".fura-companion").getAttribute("data-motion");
  if (pausedIndividually !== "paused") failures.push("Fura did not pause when her individual effect was off");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepare(page, { background: "simple", effects: "on", enabledEffects: ["fura"] });
  const pausedForReducedMotion = await page.locator(".fura-companion").getAttribute("data-motion");
  if (pausedForReducedMotion !== "paused") failures.push("Fura ignored prefers-reduced-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  return {
    poses: [...new Set(poses)],
    displacement,
    distinctPositions,
    largestSampleStep,
    bubbleDisplacement,
    maximumBubbleGap,
    bubbleOffsetDrift,
    spriteAnimations: [...new Set(spriteAnimations)],
    storedBeforeRoam,
    storedAfterRoam,
    hoverStoppedAt,
    hoverStoppedLater,
    beforeDrag,
    afterDrag,
    afterReload,
    storedPosition,
    characterBounds,
    bubbleBounds,
    collapsedBubbleBounds,
    collapsedBubbleText,
    expandedBubbleBounds,
    guidanceTailBounds,
    guidanceTailSide,
    heartbeatMetrics,
    cameraBounds,
    hudBounds,
    notebookTargetMetrics,
    pausedByMaster,
    pausedIndividually,
    pausedForReducedMotion,
    failures,
  };
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
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await installWebglCounter(page);
  await installUiAudioProbe(page);
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
  const cameraPan = await runStage("camera-pan", () => verifyCameraPanControls(page));
  const picking = await runStage("picking-navigation", () => verifyPickingAndNavigation(page));
  const activity = await runStage("activity", () => verifyActivityAndTreatments(page));
  const lifeStream = await runStage("life-stream", () => verifyLifeStream(page));
  const fura = await runStage("fura", () => verifyFuraCompanion(page));
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
    ...cameraPan.failures.map((failure) => `camera-pan: ${failure}`),
    ...picking.failures.map((failure) => `picking-navigation: ${failure}`),
    ...activity.failures.map((failure) => `activity: ${failure}`),
    ...lifeStream.failures.map((failure) => `life-stream: ${failure}`),
    ...fura.failures.map((failure) => `fura: ${failure}`),
    ...runtimeErrors,
  ];
  console.log(JSON.stringify({ status: failures.length ? "FAIL" : "PASS", renderBudget, zoom, controls, musicLayout, cameraPan, picking, activity, lifeStream, fura, results, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
