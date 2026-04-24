const { ethers } = require("ethers");
require("dotenv").config();

// ============ AAVE V3 POLYGON ============
const AAVE_POOL          = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AAVE_DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";

const GRAPH_API_KEY = process.env.GRAPH_API_KEY || "";
const SUBGRAPH_URL  = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/FBVyahKnFFc1b6E7CpRHK59whHta3AkLCAgqfpReXAvK`;

// ============ TOKENS ============
const TOKENS = {
  USDC:   { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6  },
  USDT:   { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6  },
  DAI:    { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
  WETH:   { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  WBTC:   { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8  },
  AAVE:   { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 },
  LINK:   { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
};

// ============ ABIs ============
const POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)"
];

const LIQUIDATION_BOT_ABI = [
  "function owner() external view returns (address)",
  "function executeLiquidation(address collateralAsset, address debtAsset, address borrower, uint256 debtToCover, bool useQuickSwap) external",
  "function estimateLiquidationProfit(address collateralAsset, address debtAsset, uint256 debtToCover, bool useQuickSwap) external view returns (uint256 estimatedProfit, bool isProfitable)"
];

// ============ SUBGRAPH QUERY ============
// Get top 500 active borrowers sorted by debt size
const BORROWERS_QUERY = `
{
  positions(
    first: 500
    where: { debt_gt: "0" }
    orderBy: debt
    orderDirection: desc
  ) {
    user
    debt
  }
}
`;

// ============ BOT ============
class LiquidationBot {
  constructor(rpcUrl, privateKey, liquidationBotAddress) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet   = new ethers.Wallet(privateKey, this.provider);

    this.pool         = new ethers.Contract(AAVE_POOL, POOL_ABI, this.provider);
    this.dataProvider = new ethers.Contract(AAVE_DATA_PROVIDER, DATA_PROVIDER_ABI, this.provider);
    this.botContract  = new ethers.Contract(liquidationBotAddress, LIQUIDATION_BOT_ABI, this.wallet);

    this.borrowerList    = [];     // unique borrowers from subgraph
    this.lastSubgraphFetch = 0;
    this.gasPrice        = 0n;
    this.lastBlock       = 0;
    this.totalProfitByToken = new Map();
    this.txCount         = 0;
    this.errorCount      = 0;

    this.updateGasPrice();
    setInterval(() => this.updateGasPrice(), 30000);
  }

  async updateGasPrice() {
    try {
      const feeData = await this.provider.getFeeData();
      this.gasPrice = feeData.gasPrice || 0n;
      console.log(`⛽ Gas: ${ethers.formatUnits(this.gasPrice, "gwei")} Gwei`);
    } catch (e) {
      console.error("Gas error:", e.message);
    }
  }

  // ============ FETCH BORROWERS FROM SUBGRAPH ============
  async fetchBorrowers() {
    try {
      const response = await fetch(SUBGRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: BORROWERS_QUERY })
      });

      const json = await response.json();

      if (json.errors) {
        console.error("Subgraph error:", json.errors[0].message);
        return [];
      }

      // Deduplicate users (same user may have multiple positions)
      const uniqueUsers = [...new Set((json.data?.positions || []).map(p => p.user))];
      console.log(`📊 Subgraph: ${uniqueUsers.length} unique borrowers fetched`);
      return uniqueUsers;

    } catch (e) {
      console.error("Subgraph fetch failed:", e.message);
      return [];
    }
  }

  // ============ CHECK HEALTH ON-CHAIN ============
  async checkHealthFactor(user) {
    try {
      const data = await this.pool.getUserAccountData(user);
      return {
        healthFactor:   data.healthFactor,
        isLiquidatable: data.healthFactor > 0n && data.healthFactor < ethers.parseEther("1"),
        totalDebt:      data.totalDebtBase
      };
    } catch {
      return null;
    }
  }

  // ============ FIND BEST LIQUIDATION PARAMS ============
  async findBestParams(borrower) {
    const tokenList  = Object.values(TOKENS);
    let bestOpp      = null;
    let bestProfit   = 0n;

    for (const debtToken of tokenList) {
      for (const collToken of tokenList) {
        if (debtToken.address === collToken.address) continue;

        try {
          const debtReserveData = await this.dataProvider.getUserReserveData(
            debtToken.address, borrower
          );

          const totalDebt = debtReserveData.currentVariableDebt + debtReserveData.currentStableDebt;
          if (totalDebt === 0n) continue;

          const collateralReserveData = await this.dataProvider.getUserReserveData(
            collToken.address, borrower
          );

          if (
            collateralReserveData.currentATokenBalance === 0n ||
            !collateralReserveData.usageAsCollateralEnabled
          ) {
            continue;
          }

          const debtToCover = totalDebt / 2n;
          if (debtToCover === 0n) continue;

          const [profitQS, isProfitableQS] = await this.botContract.estimateLiquidationProfit(
            collToken.address, debtToken.address, debtToCover, true
          );

          const [profitSS, isProfitableSS] = await this.botContract.estimateLiquidationProfit(
            collToken.address, debtToken.address, debtToCover, false
          );

          const bestHere = profitQS > profitSS ? profitQS : profitSS;
          const useQS    = profitQS >= profitSS;

          if ((isProfitableQS || isProfitableSS) && bestHere > bestProfit) {
            bestProfit = bestHere;
            bestOpp = {
              borrower,
              collateralAsset:  collToken.address,
              debtAsset:        debtToken.address,
              debtToCover,
              useQuickSwap:     useQS,
              estimatedProfit:  bestHere,
              profitDecimals:   debtToken.decimals,
              debtSymbol:       this.sym(debtToken.address),
              collateralSymbol: this.sym(collToken.address)
            };
          }
        } catch { /* skip */ }
      }
    }

    return bestOpp;
  }

  // ============ EXECUTE ============
  async executeLiquidation(opp) {
    try {
      console.log(`\n🔥 Liquidating ${opp.borrower.slice(0, 10)}...`);
      console.log(`   Debt: ${opp.debtSymbol} | Collateral: ${opp.collateralSymbol}`);
      console.log(`   DEX: ${opp.useQuickSwap ? "QuickSwap" : "SushiSwap"}`);
      console.log(`   Est. profit: ${this.formatAmount(opp.estimatedProfit, opp.profitDecimals, opp.debtSymbol)}`);

      const gasEst = await this.botContract.executeLiquidation.estimateGas(
        opp.collateralAsset, opp.debtAsset, opp.borrower, opp.debtToCover, opp.useQuickSwap
      );

      const tx = await this.botContract.executeLiquidation(
        opp.collateralAsset, opp.debtAsset, opp.borrower, opp.debtToCover, opp.useQuickSwap,
        { gasLimit: (gasEst * 130n) / 100n, gasPrice: this.gasPrice }
      );

      console.log(`   Tx: ${tx.hash}`);

      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 90000))
      ]);

      console.log(`✅ Done! Gas: ${receipt.gasUsed}`);
      this.txCount++;

      const previousProfit = this.totalProfitByToken.get(opp.debtSymbol) || 0n;
      const totalForToken = previousProfit + opp.estimatedProfit;
      this.totalProfitByToken.set(opp.debtSymbol, totalForToken);

      console.log(`📊 Liquidations: ${this.txCount} | ${opp.debtSymbol} profit: ${this.formatAmount(totalForToken, opp.profitDecimals, opp.debtSymbol)}`);

    } catch (e) {
      this.errorCount++;
      console.error(`❌ Failed: ${e.message}`);
    }
  }

  // ============ MONITOR ============
  async monitorOpportunities() {
    console.log("👀 Liquidation bot started (Hybrid mode)");
    console.log(`   Wallet   : ${this.wallet.address}`);
    console.log(`   Contract : ${await this.botContract.getAddress()}`);
    console.log(`   Strategy : Subgraph → borrower list, On-chain → health check\n`);

    const owner = await this.botContract.owner();
    if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) {
      console.error(`❌ Wallet is not LiquidationBot owner. Owner: ${owner}`);
      process.exit(1);
    }

    if (!GRAPH_API_KEY) {
      console.error("❌ GRAPH_API_KEY missing in .env");
      process.exit(1);
    }

    // Initial fetch
    this.borrowerList = await this.fetchBorrowers();
    this.lastSubgraphFetch = Date.now();

    this.provider.on("block", async (blockNumber) => {
      if (blockNumber <= this.lastBlock) return;
      this.lastBlock = blockNumber;

      // Refresh borrower list every 5 minutes
      if (Date.now() - this.lastSubgraphFetch > 300000) {
        this.borrowerList = await this.fetchBorrowers();
        this.lastSubgraphFetch = Date.now();
      }

      console.log(`📦 Block ${blockNumber} | Checking ${this.borrowerList.length} borrowers`);

      if (this.borrowerList.length === 0) return;

      // Check each borrower's health factor on-chain (parallel)
      let atRisk = [];

      const checks = this.borrowerList.map(async (user) => {
        const h = await this.checkHealthFactor(user);
        if (h && h.isLiquidatable) {
          atRisk.push({ user, healthFactor: h.healthFactor });
        }
      });

      await Promise.all(checks);

      if (atRisk.length === 0) {
        console.log("   No at-risk positions");
        return;
      }

      console.log(`⚠️  ${atRisk.length} at-risk borrowers found!`);

      // Sort by lowest HF
      atRisk.sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));

      // Find best opportunity
      let bestOpp    = null;
      let bestProfit = 0n;

      for (const { user, healthFactor } of atRisk) {
        const hf = (Number(healthFactor) / 1e18).toFixed(4);
        console.log(`   Checking ${user.slice(0, 10)}... HF: ${hf}`);

        const opp = await this.findBestParams(user);
        if (opp && opp.estimatedProfit > bestProfit) {
          bestProfit = opp.estimatedProfit;
          bestOpp    = opp;
        }
      }

      if (bestOpp) {
        console.log(`💰 Best opportunity! Profit: ${this.formatAmount(bestOpp.estimatedProfit, bestOpp.profitDecimals, bestOpp.debtSymbol)}`);
        await this.executeLiquidation(bestOpp);
      } else {
        console.log("   At-risk positions found but none profitable");
      }
    });
  }

  sym(address) {
    for (const [s, t] of Object.entries(TOKENS)) {
      if (t.address.toLowerCase() === address.toLowerCase()) return s;
    }
    return address.slice(0, 6);
  }

  formatAmount(amount, decimals, symbol) {
    return `${ethers.formatUnits(amount, decimals)} ${symbol}`;
  }

  stop() {
    this.provider.removeAllListeners();
    console.log(`\n🛑 Stopped | Liquidations: ${this.txCount} | Errors: ${this.errorCount}`);
  }
}

// ============ MAIN ============
async function main() {
  const { POLYGON_RPC_URL, PRIVATE_KEY, LIQUIDATION_BOT_ADDRESS } = process.env;

  if (!PRIVATE_KEY || !LIQUIDATION_BOT_ADDRESS) {
    console.error("❌ Missing PRIVATE_KEY or LIQUIDATION_BOT_ADDRESS in .env");
    process.exit(1);
  }

  if (!GRAPH_API_KEY) {
    console.error("❌ Missing GRAPH_API_KEY in .env");
    process.exit(1);
  }

  const bot = new LiquidationBot(
    POLYGON_RPC_URL || "https://polygon-rpc.com/",
    PRIVATE_KEY,
    LIQUIDATION_BOT_ADDRESS
  );

  process.on("SIGINT", () => { bot.stop(); process.exit(0); });
  await bot.monitorOpportunities();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { LiquidationBot };
