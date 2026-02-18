(async () => {
  // =======================
  // Config (edit if needed)
  // =======================
  const CFG = {
    datasetStart: 1,
    datasetEnd: 200,              // set high; it stops after consecutive missing datasets
    pageStart: 0,                 // DOJ uses page=0 for at least some listings
    stopAfterMissingDatasets: 3,  // stop after N datasets that look missing/empty
    maxPagesPerDataset: 300,      // safety cap
    delayBetweenDownloadsMs: 1800,
    delayBetweenPagesMs: 1200,
    delayBetweenDatasetsMs: 2000,
    // If you want fewer downloads, set a limit:
    maxTotalDownloads: Infinity
  };

  // =======================
  // Safety checks
  // =======================
  if (!location.hostname.endsWith("justice.gov")) {
    alert("Run this on a justice.gov dataset page tab.");
    return;
  }

  // =======================
  // Overlay UI
  // =======================
  const prev = document.getElementById("__doj_dl_overlay__");
  if (prev) prev.remove();

  const overlay = document.createElement("div");
  overlay.id = "__doj_dl_overlay__";
  overlay.style.cssText = `
    position:fixed; z-index:2147483647; top:10px; right:10px; width:440px; max-width:calc(100vw - 20px);
    background:#111; color:#fff; border-radius:14px; box-shadow:0 12px 32px rgba(0,0,0,.35);
    font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; overflow:hidden;
  `;
  overlay.innerHTML = `
    <div style="padding:12px; display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:1px solid rgba(255,255,255,.12)">
      <div style="font-weight:700">DOJ Dataset PDF Downloader</div>
      <div style="display:flex; gap:6px">
        <button id="__dl_pause__" style="cursor:pointer; border:0; background:#2a2a2a; color:#fff; padding:6px 10px; border-radius:10px">Pause</button>
        <button id="__dl_stop__" style="cursor:pointer; border:0; background:#5a1a1a; color:#fff; padding:6px 10px; border-radius:10px">Stop</button>
        <button id="__dl_close__" style="cursor:pointer; border:0; background:#2a2a2a; color:#fff; padding:6px 10px; border-radius:10px">×</button>
      </div>
    </div>
    <div style="padding:12px">
      <div id="__dl_status__" style="white-space:pre-wrap; color:#ddd"></div>
      <div style="margin-top:10px; opacity:.8; font-size:11px">Log</div>
      <div id="__dl_log__" style="margin-top:6px; height:220px; overflow:auto; background:#0b0b0b; border:1px solid rgba(255,255,255,.12);
        border-radius:12px; padding:8px; white-space:pre-wrap"></div>
    </div>
  `;
  document.documentElement.appendChild(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const statusEl = $("#__dl_status__");
  const logEl = $("#__dl_log__");
  const btnPause = $("#__dl_pause__");
  const btnStop = $("#__dl_stop__");
  const btnClose = $("#__dl_close__");

  const now = () => new Date().toLocaleString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStatus(obj) {
    statusEl.textContent = Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join("\n");
  }
  function log(msg, isErr = false) {
    const line = `[${isErr ? "ERROR" : "INFO "}] ${now()}  ${msg}\n`;
    logEl.textContent += line;
    logEl.scrollTop = logEl.scrollHeight;
    (isErr ? console.error : console.log)(line);
  }

  let paused = false;
  let stopped = false;

  btnPause.onclick = () => {
    paused = !paused;
    btnPause.textContent = paused ? "Resume" : "Pause";
    log(paused ? "Paused." : "Resumed.");
  };
  btnStop.onclick = () => {
    stopped = true;
    log("Stop requested by user.");
  };
  btnClose.onclick = () => overlay.remove();

  async function waitIfPaused() {
    while (paused && !stopped) await sleep(300);
  }

  function datasetPageUrl(n, p) {
    const u = new URL(`https://www.justice.gov/epstein/doj-disclosures/data-set-${n}-files`);
    u.searchParams.set("page", String(p));
    return u.toString();
  }

  function extractPdfLinks(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll("a[href]"))
      .map(a => a.getAttribute("href"))
      .filter(Boolean);

    const pdfs = links
      .filter(h => /\.pdf(\?|#|$)/i.test(h))
      .map(h => {
        try { return new URL(h, baseUrl).toString(); } catch { return null; }
      })
      .filter(Boolean);

    // de-dupe
    return Array.from(new Set(pdfs));
  }

  function detectNext(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelector('a[rel="next"]')) return true;
    const a = Array.from(doc.querySelectorAll("a")).find(x => (x.textContent || "").trim().toLowerCase() === "next");
    if (a) return true;
    if (doc.querySelector(".pager-next a, li.pager__item--next a")) return true;
    return false;
  }

  function looksMissingOrEmpty(html) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
    const notFoundish = text.includes("page not found") || text.includes("404") || text.includes("not found");
    const ageGate = text.includes("are you 18 years of age or older");
    return { notFoundish, ageGate };
  }

  async function fetchPage(url) {
    // Same-origin fetch because you run this on justice.gov.
    // Using credentials so the age-verify session cookie is included.
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    const html = await res.text();
    return { res, html, finalUrl: res.url };
  }

  function clickDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.target = "_self";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  let totalDownloads = 0;
  let missingDatasets = 0;

  log("Started. Make sure you clicked the age gate 'Yes' first if prompted.");
  log("Config: " + JSON.stringify(CFG));

  for (let ds = CFG.datasetStart; ds <= CFG.datasetEnd; ds++) {
    if (stopped) break;
    await waitIfPaused();

    let page = CFG.pageStart;
    let pagesVisited = 0;
    let datasetHadAny = false;

    log(`Dataset ${ds}: starting at page=${page}`);

    while (!stopped) {
      await waitIfPaused();
      pagesVisited++;
      if (pagesVisited > CFG.maxPagesPerDataset) {
        log(`Dataset ${ds}: safety stop (maxPagesPerDataset=${CFG.maxPagesPerDataset}).`, true);
        break;
      }

      const url = datasetPageUrl(ds, page);
      setStatus({ phase: "Fetching page", dataset: ds, page, url, totalDownloads });

      let fetched;
      try {
        fetched = await fetchPage(url);
      } catch (e) {
        log(`Dataset ${ds} page ${page}: fetch error: ${e?.message || e}`, true);
        break;
      }

      const { html, finalUrl } = fetched;
      const { notFoundish, ageGate } = looksMissingOrEmpty(html);

      if (ageGate) {
        log(`Dataset ${ds} page ${page}: age gate detected. Click "Yes" in the page UI once, then rerun script.`, true);
        setStatus({ phase: "Blocked by age gate", dataset: ds, page, url: finalUrl, totalDownloads });
        return;
      }

      const pdfs = extractPdfLinks(html, finalUrl);
      const hasNext = detectNext(html);

      setStatus({
        phase: "Scanning",
        dataset: ds,
        page,
        pdfLinksFound: pdfs.length,
        nextPage: hasNext ? "yes" : "no",
        url: finalUrl,
        totalDownloads
      });

      if (pdfs.length === 0 && !hasNext && notFoundish) {
        log(`Dataset ${ds} looks missing (404-ish) at page ${page}. Ending dataset.`, true);
        break;
      }

      if (pdfs.length === 0 && !hasNext) {
        log(`Dataset ${ds} page ${page}: no PDFs and no Next. Dataset done.`);
        break;
      }

      if (pdfs.length > 0) {
        datasetHadAny = true;
        log(`Dataset ${ds} page ${page}: found ${pdfs.length} PDFs.`);

        for (let i = 0; i < pdfs.length; i++) {
          if (stopped) break;
          await waitIfPaused();

          if (totalDownloads >= CFG.maxTotalDownloads) {
            log(`Reached maxTotalDownloads=${CFG.maxTotalDownloads}. Stopping.`);
            stopped = true;
            break;
          }

          const fileUrl = pdfs[i];
          setStatus({
            phase: "Downloading (clicking link)",
            dataset: ds,
            page,
            file: `${i + 1} / ${pdfs.length}`,
            url: fileUrl,
            totalDownloads
          });

          try {
            clickDownload(fileUrl);
            totalDownloads++;
            log(`Clicked download: ${fileUrl}`);
          } catch (e) {
            log(`Download click failed: ${fileUrl} :: ${e?.message || e}`, true);
          }

          await sleep(CFG.delayBetweenDownloadsMs);
        }
      }

      if (stopped) break;

      if (hasNext) {
        page++;
        log(`Dataset ${ds}: moving to page ${page}`);
        await sleep(CFG.delayBetweenPagesMs);
        continue;
      } else {
        log(`Dataset ${ds}: no Next detected. Dataset done.`);
        break;
      }
    }

    if (!datasetHadAny) {
      missingDatasets++;
      log(`Dataset ${ds}: no PDFs seen (empty/missing?). consecutiveMissing=${missingDatasets}`, true);
      if (missingDatasets >= CFG.stopAfterMissingDatasets) {
        log(`Stopping after ${missingDatasets} consecutive missing datasets.`);
        break;
      }
    } else {
      missingDatasets = 0;
    }

    if (stopped) break;
    log(`Dataset ${ds}: waiting before next dataset...`);
    await sleep(CFG.delayBetweenDatasetsMs);
  }

  setStatus({ phase: stopped ? "Stopped" : "Finished", totalDownloads, time: now() });
  log(stopped ? "Stopped." : "Finished all datasets.");
})();
