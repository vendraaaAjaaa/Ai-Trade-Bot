const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const envFile = fs.readFileSync('.env', 'utf-8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
});

const apiKey = env.BINANCE_API_KEY;
const apiSecret = env.BINANCE_API_SECRET;
const isTestnet = env.BINANCE_TESTNET === 'true';
const baseUrl = isTestnet ? env.BINANCE_TESTNET_FUTURES_URL : env.BINANCE_FUTURES_BASE_URL;

console.log(`Checking connection to ${isTestnet ? 'Testnet' : 'Mainnet'}...`);

const timestamp = Date.now();
const query = `timestamp=${timestamp}`;
const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');

const fullUrl = `${baseUrl}/fapi/v2/account?${query}&signature=${signature}`;

const options = {
  headers: {
    'X-MBX-APIKEY': apiKey
  }
};

https.get(fullUrl, options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log("✅ SUCCESS! Successfully connected to Binance API.");
        console.log("✅ Available Balance:", parsed.availableBalance, "USDT");
        console.log("✅ Can Trade:", parsed.canTrade);
      } else {
        console.error("❌ FAILED to connect to Binance API:");
        console.error(parsed);
      }
    } catch (e) {
      console.error("Error parsing response:", e);
    }
  });
}).on('error', (err) => {
  console.error("❌ Network error:", err.message);
});
