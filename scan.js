const https = require("https");
const fs = require("fs");

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

function post(hostname, path, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(
      {
        hostname, path, method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function callClaude(prompt) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  };
  const res = await post(
    "api.anthropic.com",
    "/v1/messages",
    body,
    { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }
  );
  if (res.status !== 200) throw new Error(`Claude API error: ${res.status} ${res.body}`);
  const data = JSON.parse(res.body);
  return (data.content || []).map(b => b.text || "").join("").trim();
}

function extractJson(text, type = "array") {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const s = type === "array" ? clean.indexOf("[") : clean.indexOf("{");
    const e = type === "array" ? clean.lastIndexOf("]") : clean.lastIndexOf("}");
    if (s === -1 || e === -1) return type === "array" ? [] : {};
    return JSON.parse(clean.slice(s, e + 1));
  } catch { return type === "array" ? [] : {}; }
}

async function scanItem(item) {
  const storeList = item.stores.includes("all")
    ? "Target, Walmart, GameStop, Amazon, TCGPlayer, PokemonCenter, Facebook Marketplace, eBay, Craigslist, OfferUp"
    : item.stores.join(", ");

  const priceClause = item.maxPrice ? ` under $${item.maxPrice}` : "";

  const prompt = `Search the web RIGHT NOW for "${item.name}" available for sale${priceClause}.

Search these sources: ${storeList}, Reddit (r/pokemontrades, r/hardwareswap, r/classifieds), Facebook Marketplace, and any other relevant sites.

Keywords to search: ${item.keywords.join(", ")}

Also search: "${item.keywords[0]} in stock 2025", "${item.keywords[0]} for sale", "${item.keywords[0]} reddit"

For each result found, check:
- Is it actually available/in stock right now?
${item.maxPrice ? `- Is the price at or under $${item.maxPrice}?` : ""}
- Is it a real listing (not sold out, not expired)?

Return ONLY a JSON array (no markdown, no explanation):
[{
  "source": "Target",
  "title": "listing title",
  "price": "$XX.XX or null",
  "url": "direct url",
  "inStock": true,
  "detail": "brief detail max 60 chars"
}]

Return [] if nothing found. Only include results where inStock is true${item.maxPrice ? ` and price is under $${item.maxPrice}` : ""}.`;

  try {
    const text = await callClaude(prompt);
    const results = extractJson(text, "array");
    return Array.isArray(results) ? results.filter(r => r.inStock === true) : [];
  } catch (e) {
    console.error(`  Scan failed for "${item.name}":`, e.message);
    return [];
  }
}

async function sendEmail(subject, message) {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    template_params: {
      to_email: process.env.TO_EMAIL,
      subject,
      message,
    },
  };
  const res = await post("api.emailjs.com", "/api/v1.0/email/send", payload);
  return res.status === 200;
}

async function main() {
  console.log(`\n🔍 Hot Item Scanner — ${new Date().toISOString()}`);
  console.log(`Scanning ${config.searches.length} item(s)...\n`);

  const allFinds = [];

  for (const item of config.searches) {
    console.log(`Scanning: ${item.name}${item.maxPrice ? ` (under $${item.maxPrice})` : ""}...`);
    const results = await scanItem(item);

    if (results.length > 0) {
      console.log(`  ✅ Found ${results.length} result(s)!`);
      results.forEach(r => console.log(`     ${r.source}: ${r.title} — ${r.price || "no price"}`));
      allFinds.push({ item, results });
    } else {
      console.log(`  ✗ Nothing found`);
    }

    // Small delay between items to avoid rate limiting
    if (config.searches.indexOf(item) < config.searches.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (allFinds.length === 0) {
    console.log("\n✗ No items found this run.");
    return;
  }

  // Build email
  console.log(`\n🚨 Found ${allFinds.length} item group(s) — sending email...`);

  const emailLines = allFinds.map(({ item, results }) => {
    const lines = results.map(r =>
      `  • ${r.source}${r.price ? ` — ${r.price}` : ""}\n    ${r.title}\n    ${r.url}`
    ).join("\n");
    return `━━━━━━━━━━━━━━━━━━━━\n🎯 ${item.name}\n━━━━━━━━━━━━━━━━━━━━\n${lines}`;
  }).join("\n\n");

  const message = `🚨 HOT ITEM SCANNER ALERT\n${new Date().toLocaleString(
