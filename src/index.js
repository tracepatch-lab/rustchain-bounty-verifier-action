const fs = require("node:fs");

const api = process.env.GITHUB_API_URL || "https://api.github.com";
const repoFull = process.env.GITHUB_REPOSITORY || "";
const eventPath = process.env.GITHUB_EVENT_PATH || "";

function input(name, fallback = "") {
  const key = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  return process.env[key] || fallback;
}

const token = input("github-token", process.env.GITHUB_TOKEN || "");
const nodeUrl = input("rustchain-node-url", "https://rustchain.org").replace(/\/+$/, "");
const targetOwner = input("target-owner", "Scottcjn");
const dryRun = /^true$/i.test(input("dry-run", "true"));
const maxStarPages = Number(input("max-star-pages", "10")) || 10;

function readEvent() {
  if (!eventPath || !fs.existsSync(eventPath)) {
    throw new Error("GITHUB_EVENT_PATH is not set or does not exist");
  }
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

async function gh(path, options = {}) {
  if (!token) throw new Error("github-token is required");
  const res = await fetch(`${api}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`GitHub API ${res.status} for ${path}: ${detail}`);
  }
  return { status: res.status, body, headers: res.headers };
}

function parseClaim(text) {
  const wallets = [...text.matchAll(/\bRTC[A-Za-z0-9]{20,80}\b/g)].map((m) => m[0]);
  const urls = [...text.matchAll(/https?:\/\/[^\s<>)"']+/g)].map((m) =>
    m[0].replace(/[.,;:]+$/, "")
  );
  const githubUsers = [...text.matchAll(/github(?:\.com\/|:\s*@?)([A-Za-z0-9-]+)/gi)]
    .map((m) => m[1])
    .filter((u) => !["github", "issues", "pull", "blob"].includes(u.toLowerCase()));
  const claimRefs = [...text.matchAll(/#(\d{1,7})/g)].map((m) => Number(m[1]));
  return {
    wallets: [...new Set(wallets)],
    urls: [...new Set(urls)],
    githubUsers: [...new Set(githubUsers)],
    claimRefs: [...new Set(claimRefs)],
  };
}

async function followsTarget(username) {
  try {
    const res = await fetch(`${api}/users/${encodeURIComponent(username)}/following/${encodeURIComponent(targetOwner)}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

async function countTargetStars(username) {
  let count = 0;
  let scannedPages = 0;
  const matches = [];
  for (let page = 1; page <= maxStarPages; page++) {
    scannedPages = page;
    const { body } = await gh(`/users/${encodeURIComponent(username)}/starred?per_page=100&page=${page}`);
    if (!Array.isArray(body) || body.length === 0) break;
    for (const repo of body) {
      if (repo?.owner?.login?.toLowerCase() === targetOwner.toLowerCase()) {
        count += 1;
        matches.push(repo.full_name);
      }
    }
    if (body.length < 100) break;
  }
  return { count, matches, scannedPages };
}

async function checkWallet(wallet) {
  const url = `${nodeUrl}/wallet/balance?miner_id=${encodeURIComponent(wallet)}`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return {
      wallet,
      ok: res.ok,
      status: res.status,
      amount_rtc: body?.amount_rtc ?? body?.balance_rtc ?? null,
      body,
    };
  } catch (err) {
    return { wallet, ok: false, error: String(err.message || err) };
  }
}

async function checkUrl(url) {
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    let body = "";
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { method: "GET", redirect: "follow" });
      body = await res.clone().text().catch(() => "");
    }
    const contentType = res.headers.get("content-type") || "";
    let wordCount = null;
    if (res.ok && /text|html|markdown|json/i.test(contentType)) {
      if (!body) {
        const getRes = await fetch(url, { method: "GET", redirect: "follow" });
        body = await getRes.text().catch(() => "");
      }
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
      wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    }
    return { url, ok: res.ok, status: res.status, contentType, wordCount };
  } catch (err) {
    return { url, ok: false, error: String(err.message || err) };
  }
}

async function findPreviousPaidMentions(owner, repo, username) {
  const q = encodeURIComponent(`repo:${owner}/${repo} ${username} PAID OR paid OR payout`);
  try {
    const { body } = await gh(`/search/issues?q=${q}&per_page=10`);
    return (body.items || []).map((item) => ({ title: item.title, url: item.html_url, state: item.state }));
  } catch (err) {
    return [{ error: String(err.message || err) }];
  }
}

function tableRow(label, value, ok) {
  const mark = ok === true ? "[ok]" : ok === false ? "[warn]" : "[info]";
  return `| ${label} | ${mark} ${value} |`;
}

function renderReport({ actor, parsed, follow, stars, wallets, urls, paidMentions }) {
  const lines = [];
  lines.push(`## Automated Verification for @${actor}`);
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  lines.push(tableRow(`Follows @${targetOwner}`, follow ? "Yes" : "No", follow));
  lines.push(tableRow(`${targetOwner} repos starred`, `${stars.count} found across ${stars.scannedPages} scanned page(s)`, stars.count > 0));
  lines.push(tableRow("RTC wallets found", parsed.wallets.length ? parsed.wallets.map((w) => `\`${w}\``).join(", ") : "None", parsed.wallets.length > 0));
  for (const wallet of wallets) {
    const amount = wallet.amount_rtc === null || wallet.amount_rtc === undefined ? "unknown" : `${wallet.amount_rtc} RTC`;
    lines.push(tableRow(`Wallet ${wallet.wallet}`, wallet.ok ? `reachable, balance ${amount}` : `not verified (${wallet.status || wallet.error})`, wallet.ok));
  }
  lines.push(tableRow("Claim URLs found", parsed.urls.length ? String(parsed.urls.length) : "None", parsed.urls.length > 0));
  for (const url of urls.slice(0, 10)) {
    const words = url.wordCount === null ? "" : `, ${url.wordCount} words`;
    lines.push(tableRow(`URL ${url.url}`, url.ok ? `live (${url.status}${words})` : `not live (${url.status || url.error})`, url.ok));
  }
  lines.push(tableRow("Previous paid mentions", paidMentions.length ? `${paidMentions.length} possible match(es)` : "None found in quick search", paidMentions.length === 0));
  lines.push("");
  lines.push("Parsed claim metadata:");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(parsed, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("_Bot only verifies evidence; a human maintainer still approves payout._");
  return lines.join("\n");
}

async function main() {
  const event = readEvent();
  const comment = event.comment;
  const issue = event.issue;
  if (!comment || !issue) {
    console.log("No issue_comment payload found; nothing to verify.");
    return;
  }
  const actor = comment.user?.login || event.sender?.login || "unknown";
  const parsed = parseClaim(comment.body || "");
  const follow = await followsTarget(actor);
  const stars = await countTargetStars(actor);
  const wallets = await Promise.all(parsed.wallets.map(checkWallet));
  const urls = await Promise.all(parsed.urls.map(checkUrl));
  const [owner, repo] = repoFull.split("/");
  const paidMentions = owner && repo ? await findPreviousPaidMentions(owner, repo, actor) : [];
  const report = renderReport({ actor, parsed, follow, stars, wallets, urls, paidMentions });
  console.log(report);
  if (!dryRun && owner && repo) {
    await gh(`/repos/${owner}/${repo}/issues/${issue.number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: report }),
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
