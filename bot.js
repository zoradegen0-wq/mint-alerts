const { ethers } = require("ethers");
const { TwitterApi } = require("twitter-api-v2");

const twitterClient = new TwitterApi({
  appKey:       process.env.X_API_KEY,
  appSecret:    process.env.X_API_KEY_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});
const twitter = twitterClient.readWrite;

const provider = new ethers.WebSocketProvider(process.env.ETH_WSS_URL);
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

async function postTweet(text) {
  try {
    const tweet = await twitter.v2.tweet(text);
    console.log("Tweet posted: https://x.com/i/web/status/" + tweet.data.id);
  } catch (err) { console.error("Gagal tweet:", err.message); }
}

async function flushContract(contractAddress) {
  const data = mintBuffer.get(contractAddress);
  if (!data || data.mints === 0) {
    mintBuffer.delete(contractAddress);
    windowTimers.delete(contractAddress);
    return;
  }
  mintBuffer.delete(contractAddress);
  windowTimers.delete(contractAddress);
  const [meta, gasGwei] = await Promise.all([getContractMeta(contractAddress), getGasPrice()]);
  const firstTokenId = data.tokenIds[0] ?? 0;
  const osLink = "https://opensea.io/assets/ethereum/" + contractAddress + "/" + firstTokenId;
  const timestamp = new Date().toISOString();
  const text = [
    "🔥 New Mint", "",
    meta.name + " (" + meta.symbol + ")",
    "👤 " + data.minters.size + " minter" + (data.minters.size > 1 ? "s" : ""),
    "🔄 " + data.mints + " mint" + (data.mints > 1 ? "s" : ""),
    "⛽ Gas: " + gasGwei + " Gwei", "",
    osLink, "",
    "(Sent: " + timestamp + ")"
  ].join("\n");
  console.log("[MINT]", meta.name, "|", data.minters.size, "minters |", data.mints, "mints");
  await postTweet(text);
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
  console.log("NFT Mint Bot aktif...");
  provider.on({ topics: [ERC721_TRANSFER_TOPIC] }, handleLog);
  provider.on("error", (err) => console.error("Provider error:", err.message));
  process.on("SIGINT", () => { provider.destroy(); process.exit(0); });
}
main();
