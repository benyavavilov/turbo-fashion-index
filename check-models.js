/**
 * List Gemini models available for your API key.
 *
 * Note: @google/generative-ai does not ship a listModels() helper on
 * GoogleGenerativeAI. This script uses the same ListModels REST endpoint
 * (GET /v1beta/models) that newer Google Gen AI SDKs call internally.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

const apiKey =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error(
    "Missing API key. Set GOOGLE_GENERATIVE_AI_API_KEY in .env.local"
  );
  process.exit(1);
}

// Initialize SDK client (same key your app uses via @ai-sdk/google).
const genAI = new GoogleGenerativeAI(apiKey);
void genAI;

/** Equivalent to listModels() — paginates the Generative Language API. */
async function listModels() {
  const names = [];
  let pageToken;

  do {
    const url = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models"
    );
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url);
    const body = await res.text();

    if (!res.ok) {
      throw new Error(`listModels failed (${res.status}): ${body}`);
    }

    const data = JSON.parse(body);
    for (const model of data.models ?? []) {
      if (model.name) names.push(model.name);
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return names;
}

listModels()
  .then((names) => {
    const sorted = [...names].sort();
    console.log(`Found ${sorted.length} available models:\n`);
    for (const name of sorted) {
      console.log(name);
    }
  })
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
