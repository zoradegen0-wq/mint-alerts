const { ethers } = require("ethers");
const https = require("https");

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ETH_WSS_URL      = process.env.ETH_WSS_URL;

const FAST_MINTS  = 20;
const FAST_WINDOW = 60 * 1000;
const SLOW_MINTS  = 10;
const SLOW_WINDOW = 5 * 60 * 1000;

const ERC721_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const mintBuffer      = new Map();
const skipTimers      = new Map();
const postedContracts = new Set();
const metaCache       = new Map(); // cache nama kontrak biar gak request ulang
let gasCacheValue     = "?";
let gasCacheTime      = 0;
const GAS_CACHE_MS    = 15000; // cache gas 15 detik

let provider;

function createProvider() {
  provider = new ethers.WebSocketProvider(ETH_WSS_URL);
  provider.on({ topics: [ERC721_TRANSFER_TOPIC] }, handleLog);
  provider.on("error", (err) => {
    console.error("Provider error:", err.message);
    reconnect();
  });
  provider.websocket.on("close", () => {
    console.log("WebSocket putus, reconnecting...");
    reconnect();
  });
  console.log("WebSocket connected.");
}

let reconnectTimer = null;
function reconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try { provider.destroy(); } catch {}
    createProvider();
  }, 5000);
}

async function getContractMeta(address) {
  if (metaCache.has(address)) return metaCache.get(address);
  try {
    const abi = ["function name() view returns (string)", "function symbol() view returns (string)"];
    const c = new ethers.Contract(address, abi, provider);
    const [name, symbol] = await Promise.all([c.name(), c.symbol()]);
    const meta = { name, symbol };
    metaCache.set(address, meta);
    return meta;
  } catch {
    const meta = { name: address.slice(0,6)+"..."+address.slice(-4), symbol: "???" };
    metaCache.set(address, meta);
    return meta;
  }
}

async function getGasPrice() {
  const now = Date.now();
  if (now - gasCacheTime < GAS_CACHE_MS) return gasCacheValue;
  try {
    const fee = await provider.getFeeData();
    gasCacheValue = parseFloat(ethers.formatUnits(fee.gasPrice || 0n, "gwei")).toFixed(2);
    gasCacheTime = now;
    return gasCacheValue;
  } catch { return gasCacheValue; }
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: false });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) console.log("Pesan terkirim ke Telegram!");
          else console.error("Gagal kirim:", parsed.description);
        } catch {}
        resolve();
      });
    });
    req.on("error", err => { console.error("Telegram error:", err.message); resolve(); });
    req.write(body); req.end();
  });
}

async function postContract(contract, data) {
  const [meta, gasGwei] = await Promise.all([getContractMeta(contract), getGasPrice()]);
  const osLink = "https://opensea.io/assets/ethereum/" + contract + "/" + (data.tokenIds[0] ?? 0);
  const text = [
    "🔥 <b>New Mint</b>", "",
    `<b>${meta.name} (${meta.symbol})</b>`,
    `👤 ${data.minters.size} minter${data.minters.size > 1 ? "s" : ""}`,
    `🔄 ${data.mints} mints`,
    `⛽ Gas: ${gasGwei} Gwei`, "",
    osLink, "",
    `<i>(Sent: ${new Date().toISOString()})</i>`
  ].join("\n");
  console.log("[POST]", meta.name, "|", data.mints, "mints");
  await sendTelegram(text);
}

function tryPost(contract) {
  if (postedContracts.has(contract)) return;
  const buf = mintBuffer.get(contract);
  if (!buf) return;
  postedContracts.add(contract);
  mintBuffer.delete(contract);
  if (skipTimers.has(contract)) { clearTimeout(skipTimers.get(contract)); skipTimers.delete(contract); }
  postContract(contract, buf);
}

async function handleLog(log) {
  try {
    if (!log.topics || log.topics.length < 4) return;
    if (log.topics[0] !== ERC721_TRANSFER_TOPIC) return;
    const from = ethers.getAddress("0x" + log.topics[1].slice(26));
    if (from !== ethers.getAddress(ZERO_ADDRESS)) return;

    const contract = log.address.toLowerCase();
    if (postedContracts.has(contract)) return;

    const to      = ethers.getAddress("0x" + log.topics[2].slice(26));
    const tokenId = BigInt(log.topics[3]).toString();

    if (!mintBuffer.has(contract)) {
      mintBuffer.set(contract, { minters: new Set(), mints: 0, tokenIds: [], firstSeen: Date.now() });
      skipTimers.set(contract, setTimeout(() => {
        const buf = mintBuffer.get(contract);
        if (!buf || postedContracts.has(contract)) return;
        if (buf.mints < SLOW_MINTS) {
          console.log("[SKIP]", contract, "| only", buf.mints, "mints in 5 min");
          mintBuffer.delete(contract);
          skipTimers.delete(contract);
        } else {
          tryPost(contract);
        }
      }, SLOW_WINDOW));
    }

    const buf = mintBuffer.get(contract);
    if (!buf) return;
    buf.minters.add(to); buf.mints++; buf.tokenIds.push(tokenId);

    const elapsed = Date.now() - buf.firstSeen;
    if (elapsed <= FAST_WINDOW && buf.mints >= FAST_MINTS) {
      console.log("[FAST] 20 mints dalam 1 menit →", contract);
      tryPost(contract);
    }
  } catch {}
}

async function main() {
  console.log("NFT Mint Bot aktif | 20 mint/1min → post | <10 mint/5min → skip | blacklist permanen");
  createProvider();
  process.on("SIGINT", () => { try { provider.destroy(); } catch {} process.exit(0); });
}
main();
