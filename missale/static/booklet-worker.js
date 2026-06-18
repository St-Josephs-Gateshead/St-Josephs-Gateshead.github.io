/**
 * Cloudflare Worker — booklet build proxy
 *
 * Env secrets (set in Cloudflare dashboard):
 *   GITHUB_PAT  — fine-grained PAT with actions:write + contents:read on this repo
 *
 * Routes:
 *   POST /booklet/build   { mass_type, path_name, propers_json (base64), document?, layout? }
 *                         → { run_id, artifact_name }  (after dispatch + run found)
 *   GET  /booklet/status/:run_id   → { status: "queued"|"in_progress"|"completed"|"failed" }
 *   GET  /booklet/download/:run_id → PDF blob (proxied from GitHub artifact)
 *   GET  /gabc/:id        → { gabc: [...] }  GABC blocks for a GregoBase chant (CORS proxy)
 */

const REPO_OWNER = "St-Josephs-Gateshead";
const REPO_NAME  = "St-Josephs-Gateshead.github.io";
const WORKFLOW_FILE = "build-booklet.yml";
const BRANCH = "main";

const GH = (path) =>
  `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}${path}`;

const ghHeaders = (pat) => ({
  "Authorization": `Bearer ${pat}`,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "StJosephsMissale/1.0",
});

async function dispatch(pat, inputs, createdAfter) {
  const resp = await fetch(
    GH(`/actions/workflows/${WORKFLOW_FILE}/dispatches`),
    {
      method: "POST",
      headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: BRANCH, inputs }),
    }
  );
  if (resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`Dispatch failed ${resp.status}: ${text}`);
  }
}

async function findRunId(pat, requestId, createdAfter) {
  // Poll up to 30 s for the run created after dispatch
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const resp = await fetch(
      GH(`/actions/runs?event=workflow_dispatch&branch=${BRANCH}&per_page=10`),
      { headers: ghHeaders(pat) }
    );
    if (!resp.ok) continue;
    const { workflow_runs } = await resp.json();
    for (const run of workflow_runs) {
      const runTime = new Date(run.created_at).getTime();
      if (runTime >= createdAfter &&
          run.name === "Build Mass Booklet PDF") {
        return run.id;
      }
    }
  }
  return null;
}

async function getRunStatus(pat, runId) {
  const resp = await fetch(GH(`/actions/runs/${runId}`), { headers: ghHeaders(pat) });
  if (!resp.ok) return "unknown";
  const run = await resp.json();
  if (run.status === "completed") {
    return run.conclusion === "success" ? "completed" : "failed";
  }
  return run.status; // "queued" | "in_progress"
}

async function getArtifact(pat, runId) {
  const resp = await fetch(GH(`/actions/runs/${runId}/artifacts`), { headers: ghHeaders(pat) });
  if (!resp.ok) return null;
  const { artifacts } = await resp.json();
  return artifacts.find(a => a.name.startsWith("export-")) || null;
}

async function downloadArtifact(pat, artifactId) {
  // GitHub redirects artifact download — follow the redirect
  const resp = await fetch(
    GH(`/actions/artifacts/${artifactId}/zip`),
    { headers: ghHeaders(pat), redirect: "follow" }
  );
  if (!resp.ok) return null;
  return resp;
}

// --- KV store for run_id lookup (Cloudflare KV binding named RUNS) ---

async function handleBuild(request, env) {
  const body = await request.json();
  const { mass_type, path_name, propers_json, document = 'missalette', layout = 'regular' } = body;

  if (!mass_type || !path_name || !propers_json) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  const createdAfter = Date.now() - 3000; // 3 s leeway for clock skew
  const inputs = { mass_type, path_name, propers_json, document, layout };

  await dispatch(env.GITHUB_PAT, inputs, createdAfter);

  const runId = await findRunId(env.GITHUB_PAT, null, createdAfter);
  if (!runId) {
    return new Response(JSON.stringify({ error: "Could not find dispatched run after 30s" }), {
      status: 503, headers: { "Content-Type": "application/json" }
    });
  }

  // Cache run_id keyed by mass_type + path_name for convenience (24 h TTL)
  if (env.RUNS) {
    await env.RUNS.put(`${mass_type}/${path_name}`, String(runId), { expirationTtl: 86400 });
  }

  const artifactName = `export-${mass_type}-${path_name}`;
  return new Response(JSON.stringify({ run_id: runId, artifact_name: artifactName }), {
    status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function handleStatus(runId, env) {
  const status = await getRunStatus(env.GITHUB_PAT, runId);
  return new Response(JSON.stringify({ status }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function handleDownload(runId, env) {
  const artifact = await getArtifact(env.GITHUB_PAT, runId);
  if (!artifact) {
    return new Response(JSON.stringify({ error: "Artifact not found" }), {
      status: 404, headers: { "Content-Type": "application/json" }
    });
  }

  // Artifacts are ZIP files; we stream the zip, browser handles it
  const resp = await downloadArtifact(env.GITHUB_PAT, artifact.id);
  if (!resp) {
    return new Response(JSON.stringify({ error: "Download failed" }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(resp.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${artifact.name}.zip"`,
      "Access-Control-Allow-Origin": "*",
    }
  });
}

// --- GABC proxy (gregobase.selapa.net does not send CORS headers) ---

function _cleanGabc(gabc) {
  gabc = gabc.replace(/\[[^\]]*\]/g, "");
  gabc = gabc.replace(/<sp>'?(?:ae|æ)<\/sp>/gi, "ǽ");
  gabc = gabc.replace(/<sp>'?(?:oe|œ)<\/sp>/gi, "œ");
  gabc = gabc.replace(/\*(?!\()/g, "*()");
  return gabc.trim();
}

function _parseGabcFile(text) {
  if (!text.includes("%%")) {
    const cleaned = _cleanGabc(text.trim());
    return cleaned ? [cleaned] : [];
  }
  const body = text.split("%%").slice(1).join("%%");
  return body.split(/[A-Z]+%%/).map(b => _cleanGabc(b.trim())).filter(Boolean);
}

async function handleGabc(chantId) {
  const BASE = `https://gregobase.selapa.net/download.php?id=${chantId}&format=gabc&elem=`;
  const blocks = [];
  const seen = new Set();
  for (let elem = 1; elem <= 99; elem++) {
    let text;
    try {
      const r = await fetch(BASE + elem);
      text = await r.text();
    } catch (_) { break; }
    if (!text || text.trim() === "Wrong id" || text.trim() === "") break;
    const parsed = _parseGabcFile(text);
    if (!parsed.length) break;
    const key = parsed.join("|");
    if (seen.has(key)) break;
    seen.add(key);
    blocks.push(...parsed);
  }
  if (!blocks.length) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
  return new Response(JSON.stringify({ gabc: blocks }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    if (request.method === "POST" && path === "/booklet/build") {
      return handleBuild(request, env);
    }

    const statusMatch = path.match(/^\/booklet\/status\/(\d+)$/);
    if (statusMatch && request.method === "GET") {
      return handleStatus(statusMatch[1], env);
    }

    const downloadMatch = path.match(/^\/booklet\/download\/(\d+)$/);
    if (downloadMatch && request.method === "GET") {
      return handleDownload(downloadMatch[1], env);
    }

    const gabcMatch = path.match(/^\/gabc\/(\d+)$/);
    if (gabcMatch && request.method === "GET") {
      return handleGabc(gabcMatch[1]);
    }

    return new Response("Not found", { status: 404 });
  }
};
