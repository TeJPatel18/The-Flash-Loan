const { ethers } = require("ethers");
require("dotenv").config();

// ============ TOKEN ADDRESSES (Polygon Mainnet) ============
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  QUICK: "0xB5C064F955D8e7F38fE0460C556a72987494eE17",
  LINK: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
  AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  CRV: "0x172370d5Cd63279eFa6d502DAB29171933a610AF"
};

// ============ DEX ADDRESSES ============
const DEXES = {
  QuickSwap: {
    factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"
  },
  SushiSwap: {
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"
  }
};

// ============ 18 TRIANGULAR PATHS ============
const PATHS = [
  // USDC base
  { start: TOKENS.USDC, mid1: TOKENS.WETH, mid2: TOKENS.DAI, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.WMATIC, mid2: TOKENS.WETH, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.WBTC, mid2: TOKENS.WETH, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.WETH, mid2: TOKENS.WBTC, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.QUICK, mid2: TOKENS.WMATIC, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.AAVE, mid2: TOKENS.WETH, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.LINK, mid2: TOKENS.WETH, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.USDT, mid2: TOKENS.DAI, end: TOKENS.USDC, decimals: 6 },
  { start: TOKENS.USDC, mid1: TOKENS.CRV, mid2: TOKENS.WETH, end: TOKENS.USDC, decimals: 6 },
  // DAI base
  { start: TOKENS.DAI, mid1: TOKENS.WETH, mid2: TOKENS.USDC, end: TOKENS.DAI, decimals: 18 },
  { start: TOKENS.DAI, mid1: TOKENS.WMATIC, mid2: TOKENS.USDC, end: TOKENS.DAI, decimals: 18 },
  { start: TOKENS.DAI, mid1: TOKENS.WBTC, mid2: TOKENS.WETH, end: TOKENS.DAI, decimals: 18 },
  { start: TOKENS.DAI, mid1: TOKENS.USDT, mid2: TOKENS.USDC, end: TOKENS.DAI, decimals: 18 },
  // WETH base
  { start: TOKENS.WETH, mid1: TOKENS.WBTC, mid2: TOKENS.USDC, end: TOKENS.WETH, decimals: 18 },
  { start: TOKENS.WETH, mid1: TOKENS.WMATIC, mid2: TOKENS.USDC, end: TOKENS.WETH, decimals: 18 },
  { start: TOKENS.WETH, mid1: TOKENS.AAVE, mid2: TOKENS.USDC, end: TOKENS.WETH, decimals: 18 },
  { start: TOKENS.WETH, mid1: TOKENS.LINK, mid2: TOKENS.USDC, end: TOKENS.WETH, decimals: 18 },
  // WMATIC base
  { start: TOKENS.WMATIC, mid1: TOKENS.WETH, mid2: TOKENS.USDC, end: TOKENS.WMATIC, decimals: 18 },
];

// ============ ABIs ============
const FLASH_LOAN_ABI = [
  "function initiateFlashLoan(address _token, uint256 _amount, uint256 _slippageBps) external",
  "function getAssetRiskConfig(address asset) external view returns (uint256 maxLoanAmount, uint256 ltvRatio, uint256 riskScore, bool isActive)",
  "function circuitBreakerActive() public view returns (bool)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

// ============ BOT ============
class ArbitrageBot {
  constructor(rpcUrl, privateKey, flashLoanAddress) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);

    this.flashLoanContract = new ethers.Contract(flashLoanAddress, FLASH_LOAN_ABI, this.wallet);

    this.routers = {
      QuickSwap: new ethers.Contract(DEXES.QuickSwap.router, ROUTER_ABI, this.provider),
      SushiSwap: new ethers.Contract(DEXES.SushiSwap.router, ROUTER_ABI, this.provider)
    };

    this.gasPrice = 0n;
    this.lastBlock = 0;
    this.totalProfit = 0n;
    this.txCount = 0;
    this.errorCount = 0;
    this.scanCount = 0;

    this.updateGasPrice();
    setInterval(() => this.updateGasPrice(), 30000);
  }

  async updateGasPrice() {
    try {
      const feeData = await this.provider.getFeeData();
      this.gasPrice = feeData.gasPrice || 0n;
      console.log(`⛽ Gas: ${ethers.formatUnits(this.gasPrice, "gwei")} Gwei`);
    } catch (e) {
      console.error("Gas update error:", e.message);
    }
  }

  async getPrice(router, tokenIn, tokenOut, amountIn) {
    try {
      const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
      return amounts[1];
    } catch {
      return 0n;
    }
  }

  async findArbitrageOpportunities() {
    const opportunities = [];

    for (const path of PATHS) {
      const testAmount = ethers.parseUnits("1000", path.decimals);

      for (const [dexName, router] of Object.entries(this.routers)) {
        try {
          const hop1 = await this.getPrice(router, path.start, path.mid1, testAmount);
          if (hop1 === 0n) continue;

          const hop2 = await this.getPrice(router, path.mid1, path.mid2, hop1);
          if (hop2 === 0n) continue;

          const hop3 = await this.getPrice(router, path.mid2, path.end, hop2);
          if (hop3 === 0n) continue;

          this.scanCount++;

          const flashFee = (testAmount * 30n) / 10000n;
          const repayAmount = testAmount + flashFee;
          const gasCost = this.gasPrice * 600000n;

          if (hop3 > repayAmount) {
            const grossProfit = hop3 - repayAmount;
            const protocolFee = (grossProfit * 100n) / 10000n;
            const netProfit = grossProfit - protocolFee;

            if (netProfit > gasCost) {
              const pathStr = `${this.sym(path.start)}→${this.sym(path.mid1)}→${this.sym(path.mid2)}→${this.sym(path.end)}`;
              console.log(`💰 [${dexName}] ${pathStr} | Profit: ${ethers.formatUnits(netProfit, path.decimals)}`);

              opportunities.push({
                dex: dexName, pathStr, netProfit,
                rawProfit: netProfit,
                token: path.start,
                amount: testAmount,
                decimals: path.decimals
              });
            }
          }
        } catch { /* skip */ }
      }
    }

    return opportunities;
  }

  async executeArbitrage(opp) {
    try {
      console.log(`\n🚀 Executing: [${opp.dex}] ${opp.pathStr}`);
      console.log(`   Profit: ${ethers.formatUnits(opp.netProfit, opp.decimals)}`);

      const cbActive = await this.flashLoanContract.circuitBreakerActive();
      if (cbActive) { console.log("⚠️  Circuit breaker active"); return; }

      const config = await this.flashLoanContract.getAssetRiskConfig(opp.token);
      if (!config.isActive) { console.log("⚠️  Token not active"); return; }

      const slippageBps = 50n;

      const gasEstimate = await this.flashLoanContract.initiateFlashLoan.estimateGas(
        opp.token, opp.amount, slippageBps
      );

      const tx = await this.flashLoanContract.initiateFlashLoan(
        opp.token, opp.amount, slippageBps,
        {
          gasLimit: (gasEstimate * 120n) / 100n,
          gasPrice: this.gasPrice
        }
      );

      console.log(`   Tx: ${tx.hash}`);

      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 60000))
      ]);

      console.log(`✅ Confirmed: ${receipt.hash} | Gas: ${receipt.gasUsed}`);
      this.txCount++;
      this.totalProfit += opp.rawProfit;
      console.log(`📊 Txs: ${this.txCount} | Est. profit: ${ethers.formatUnits(this.totalProfit, opp.decimals)}`);

    } catch (e) {
      this.errorCount++;
      console.error(`❌ Failed: ${e.message}`);
    }
  }

  async monitorOpportunities() {
    console.log("👀 Arbitrage bot started");
    console.log(`   Wallet  : ${this.wallet.address}`);
    console.log(`   Contract: ${await this.flashLoanContract.getAddress()}`);
    console.log(`   Paths   : ${PATHS.length} triangular paths × 2 DEXes = ${PATHS.length * 2} combos/block`);
    console.log(`   Tokens  : USDC, DAI, WETH, WMATIC, WBTC, QUICK, LINK, AAVE, USDT, CRV\n`);

    this.provider.on("block", async (blockNumber) => {
      if (blockNumber <= this.lastBlock) return;
      this.lastBlock = blockNumber;
      console.log(`📦 Block ${blockNumber} | Total scans: ${this.scanCount}`);

      try {
        const opportunities = await this.findArbitrageOpportunities();

        if (opportunities.length === 0) {
          console.log("   No profitable opportunities");
          return;
        }

        console.log(`   Found ${opportunities.length} opportunity/ies!`);
        opportunities.sort((a, b) => b.rawProfit > a.rawProfit ? 1 : -1);
        await this.executeArbitrage(opportunities[0]);

      } catch (e) {
        console.error(`Block error: ${e.message}`);
      }
    });
  }

  sym(address) {
    for (const [s, a] of Object.entries(TOKENS)) {
      if (a.toLowerCase() === address.toLowerCase()) return s;
    }
    return address.slice(0, 6);
  }

  stop() {
    this.provider.removeAllListeners("block");
    console.log(`\n🛑 Stopped | Txs: ${this.txCount} | Errors: ${this.errorCount}`);
  }
}

// ============ MAIN ============
async function main() {
  const { POLYGON_RPC_URL, PRIVATE_KEY, FLASH_LOAN_ADDRESS } = process.env;

  if (!PRIVATE_KEY || !FLASH_LOAN_ADDRESS) {
    console.error("❌ Missing PRIVATE_KEY or FLASH_LOAN_ADDRESS in .env");
    process.exit(1);
  }

  const bot = new ArbitrageBot(
    POLYGON_RPC_URL || "https://polygon-rpc.com/",
    PRIVATE_KEY,
    FLASH_LOAN_ADDRESS
  );

  process.on("SIGINT", () => { bot.stop(); process.exit(0); });
  await bot.monitorOpportunities();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { ArbitrageBot };
