const { ethers } = require("ethers");
const https = require("https");

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ETH_WSS_URL      = process.env.ETH_WSS_URL;

const provider = new ethers.WebSocketProvider(ETH_WSS_URL);
const ERC721_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WINDOW_SECONDS = 30;
const mintBuffer = new Map();
const windowTimers = new Map();

async function getContractMeta(address) {
  try {
    const abi = ["function name() view returns (string)", "function symbol() view returns (string)"];
    const contract = new ethers.Contract(address, abi, provider);
    const [name, symbol] = await Promise.all([contract.name(), contract.symbol()]);
    return { name, symbol };
  } catch {
    return { name: address.slice(0,6)+"..."+address.slice(-4), symbol: "???" };
  }
}

async function getGasPrice() {
  try {
    const fee = await provider.getFeeData();
    return parseFloat(ethers.formatUnits(fee.gasPrice || 0n, "gwei")).toFixed(2);
  } catch { return "?"; }
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
        const parsed = JSON.parse(data);
        if (parsed.ok) console.log("Pesan terkirim ke Telegram!");
        else console.error("Gagal kirim:", parsed.description);
        resolve();
      });
    });
    req.on("error", (err) => { console.error("Telegram error:", err.message); resolve(); });
    req.write(body);
    req.end();
  });
}

async function flushContract(contractAddress) {
  const data = mintBuffer.get(contractAddress);
  if (!data || data.mints === 0) { mintBuffer.delete(contractAddress); windowTimers.delete(contractAddress); return; }
  mintBuffer.delete(contractAddress);
  windowTimers.delete(contractAddress);

  const [meta, gasGwei] = await Promise.all([getContractMeta(contractAddress), getGasPrice()]);
  const firstTokenId = data.tokenIds[0] ?? 0;
  const osLink = "https://opensea.io/assets/ethereum/" + contractAddress + "/" + firstTokenId;
  const timestamp = new Date().toISOString();

  const text = [
    "🔥 <b>New Mint</b>", "",
    `<b>${meta.name} (${meta.symbol})</b>`,
    `👤 ${data.minters.size} minter${data.minters.size > 1 ? "s" : ""}`,
    `🔄 ${data.mints} mint${data.mints > 1 ? "s" : ""}`,
    `⛽ Gas: ${gasGwei} Gwei`, "",
    osLink, "",
    `<i>(Sent: ${timestamp})</i>`
  ].join("\n");

  console.log("[MINT]", meta.name, "|", data.minters.size, "minters |", data.mints, "mints");
  await sendTelegram(text);
}

async function handleLog(log) {
  try {
    if (!log.topics || log.topics.length < 4) return;
    if (log.topics[0] !== ERC721_TRANSFER_TOPIC) return;
    const from = ethers.getAddress("0x" + log.topics[1].slice(26));
    if (from !== ethers.getAddress(ZERO_ADDRESS)) return;
    const to = ethers.getAddress("0x" + log.topics[2].slice(26));
    const tokenId = BigInt(log.topics[3]).toString();
    const contract = log.address.toLowerCase();
    if (!mintBuffer.has(contract)) mintBuffer.set(contract, { minters: new Set(), mints: 0, tokenIds: [] });
    const buf = mintBuffer.get(contract);
    buf.minters.add(to); buf.mints++; buf.tokenIds.push(tokenId);
    if (windowTimers.has(contract)) clearTimeout(windowTimers.get(contract));
    windowTimers.set(contract, setTimeout(() => flushContract(contract), WINDOW_SECONDS * 1000));
  } catch {}
}

async function main() {
  console.log("NFT Mint Bot (Telegram) aktif...");
  provider.on({ topics: [ERC721_TRANSFER_TOPIC] }, handleLog);
  provider.on("error", (err) => console.error("Provider error:", err.message));
  process.on("SIGINT", () => { provider.destroy(); process.exit(0); });
}
main();
