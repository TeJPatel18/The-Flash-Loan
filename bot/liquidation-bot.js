const { ethers } = require("ethers");
require("dotenv").config();

// ============ AAVE V3 POLYGON ============
const AAVE_POOL          = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AAVE_DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";
const AAVE_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

// ============ DEXES ============
const QUICKSWAP_ROUTER  = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const QUICKSWAP_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const SUSHISWAP_ROUTER  = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const SUSHISWAP_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

const GRAPH_API_KEY = process.env.GRAPH_API_KEY || "";
const SUBGRAPH_URL  = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/FBVyahKnFFc1b6E7CpRHK59whHta3AkLCAgqfpReXAvK`;
const CLOSE_FACTOR_HF_THRESHOLD = ethers.parseEther("0.95");
const BPS = 10000n;

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

const BORROWER_FETCH_LIMIT = Math.min(Math.max(numberEnv("BORROWER_FETCH_LIMIT", 500), 1), 1000);
const SCAN_INTERVAL_MS = Math.max(numberEnv("SCAN_INTERVAL_SECONDS", 30), 5) * 1000;
const UNPROFITABLE_COOLDOWN_MS = Math.max(numberEnv("UNPROFITABLE_COOLDOWN_SECONDS", 900), 30) * 1000;

// ============ TOKENS ============
const TOKENS = {
  USDCe:  { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6  },
  USDC:   { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6  },
  USDT:   { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6  },
  DAI:    { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
  WETH:   { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  WBTC:   { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8  },
  AAVE:   { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 },
  LINK:   { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
};

const TOKEN_KEYS = Object.fromEntries(Object.keys(TOKENS).map((key) => [key.toUpperCase(), key]));

function tokenListFromEnv(name, fallback) {
  return (process.env[name] || fallback)
    .split(",")
    .map((symbol) => TOKEN_KEYS[symbol.trim().toUpperCase()])
    .filter(Boolean)
    .map((symbol) => ({ symbol, ...TOKENS[symbol] }));
}

const DEBT_TOKENS = tokenListFromEnv("DEBT_TOKENS", "USDCe,USDC,USDT,DAI");
const COLLATERAL_TOKENS = tokenListFromEnv("COLLATERAL_TOKENS", "WBTC,WETH,WMATIC,AAVE,LINK,DAI,USDCe,USDC,USDT");

// ============ ABIs ============
const POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const ADDRESSES_PROVIDER_ABI = [
  "function getPriceOracle() external view returns (address)"
];

const PRICE_ORACLE_ABI = [
  "function BASE_CURRENCY_UNIT() external view returns (uint256)",
  "function getAssetPrice(address asset) external view returns (uint256)"
];

const DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)"
];

const LIQUIDATION_BOT_ABI = [
  "function owner() external view returns (address)",
  "function executeLiquidation(address collateralAsset, address debtAsset, address borrower, uint256 debtToCover, bool useQuickSwap) external",
  "function estimateLiquidationProfit(address collateralAsset, address debtAsset, uint256 debtToCover, bool useQuickSwap) external view returns (uint256 estimatedProfit, bool isProfitable)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

const ERROR_SELECTORS = {
  "0xb629b0e4": "Aave MustNotLeaveDust: liquidation would leave a dust-sized debt balance",
  "0xd719ab69": "LiquidationBot PairNotFound",
  "0xa5adf0af": "LiquidationBot NotProfitable",
  "0xf13b7f34": "LiquidationBot InvalidFlashLoanAsset",
  "0xb27a27bf": "LiquidationBot NotAavePool",
  "0x118cdaa7": "OwnableUnauthorizedAccount",
  "0x5274afe7": "SafeERC20FailedOperation"
};

// ============ SUBGRAPH QUERY ============
// Get active borrowers sorted by debt size
const BORROWERS_QUERY = `
{
  positions(
    first: ${BORROWER_FETCH_LIMIT}
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
    this.addressesProvider = new ethers.Contract(AAVE_ADDRESSES_PROVIDER, ADDRESSES_PROVIDER_ABI, this.provider);
    this.priceOracle  = null;
    this.baseCurrencyUnit = 100000000n;
    this.baseCurrencyDecimals = 8;
    this.botContract  = new ethers.Contract(liquidationBotAddress, LIQUIDATION_BOT_ABI, this.wallet);
    this.dexes = {
      quickswap: {
        name: "QuickSwap",
        router: new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, this.provider),
        factory: new ethers.Contract(QUICKSWAP_FACTORY, FACTORY_ABI, this.provider),
        useQuickSwap: true
      },
      sushiswap: {
        name: "SushiSwap",
        router: new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, this.provider),
        factory: new ethers.Contract(SUSHISWAP_FACTORY, FACTORY_ABI, this.provider),
        useQuickSwap: false
      }
    };

    this.borrowerList    = [];     // unique borrowers from subgraph
    this.lastSubgraphFetch = 0;
    this.gasPrice        = 0n;
    this.lastBlock       = 0;
    this.isScanning      = false;
    this.lastScanStartedAt = 0;
    this.borrowerCooldowns = new Map();
    this.totalProfitByToken = new Map();
    this.txCount         = 0;
    this.errorCount      = 0;
    this.minDebtToCoverUsd = process.env.MIN_DEBT_TO_COVER_USD || "10";
    this.minLeftoverDebtUsd = process.env.MIN_LEFTOVER_DEBT_USD || "1";
    this.minNetProfitUsd = process.env.MIN_NET_PROFIT_USD || "0.25";
    this.estimateBufferBps = BigInt(process.env.LIQUIDATION_ESTIMATE_BUFFER_BPS || "9500");
    this.minDebtToCoverBase = 0n;
    this.minLeftoverDebtBase = 0n;
    this.minNetProfitBase = 0n;

    this.updateGasPrice();
    setInterval(() => this.updateGasPrice(), 30000);
  }

  async initialize() {
    const oracleAddress = await this.addressesProvider.getPriceOracle();
    this.priceOracle = new ethers.Contract(oracleAddress, PRICE_ORACLE_ABI, this.provider);

    try {
      this.baseCurrencyUnit = await this.priceOracle.BASE_CURRENCY_UNIT();
      this.baseCurrencyDecimals = this.decimalsFromUnit(this.baseCurrencyUnit);
    } catch {
      this.baseCurrencyUnit = 100000000n;
      this.baseCurrencyDecimals = 8;
    }

    this.minDebtToCoverBase = ethers.parseUnits(this.minDebtToCoverUsd, this.baseCurrencyDecimals);
    this.minLeftoverDebtBase = ethers.parseUnits(this.minLeftoverDebtUsd, this.baseCurrencyDecimals);
    this.minNetProfitBase = ethers.parseUnits(this.minNetProfitUsd, this.baseCurrencyDecimals);

    console.log(`   Aave oracle: ${oracleAddress}`);
    console.log(`   Min debt to cover: ${this.minDebtToCoverUsd} USD | Min net profit: ${this.minNetProfitUsd} USD`);
    console.log(`   Borrowers: ${BORROWER_FETCH_LIMIT} | Scan interval: ${SCAN_INTERVAL_MS / 1000}s | Cooldown: ${UNPROFITABLE_COOLDOWN_MS / 1000}s`);
    console.log(`   Debt tokens: ${DEBT_TOKENS.map((t) => t.symbol).join(", ")} | Collateral tokens: ${COLLATERAL_TOKENS.map((t) => t.symbol).join(", ")}`);
  }

  decimalsFromUnit(unit) {
    const text = unit.toString();
    return /^10*$/.test(text) ? text.length - 1 : 8;
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

  borrowerKey(user) {
    return user.toLowerCase();
  }

  isBorrowerCoolingDown(user) {
    const key = this.borrowerKey(user);
    const until = this.borrowerCooldowns.get(key) || 0;

    if (until <= Date.now()) {
      this.borrowerCooldowns.delete(key);
      return false;
    }

    return true;
  }

  cooldownBorrower(user, reason) {
    this.borrowerCooldowns.set(this.borrowerKey(user), Date.now() + UNPROFITABLE_COOLDOWN_MS);
    console.log(`   Cooling down ${user.slice(0, 10)}... (${reason})`);
  }

  async valueInBase(asset, amount, decimals) {
    const price = await this.priceOracle.getAssetPrice(asset);
    return (amount * price) / (10n ** BigInt(decimals));
  }

  async estimateCollateralReceived(collToken, debtToken, debtToCover) {
    const [collateralConfig, debtPrice, collateralPrice] = await Promise.all([
      this.dataProvider.getReserveConfigurationData(collToken.address),
      this.priceOracle.getAssetPrice(debtToken.address),
      this.priceOracle.getAssetPrice(collToken.address)
    ]);

    if (!collateralConfig.isActive || collateralConfig.isFrozen || !collateralConfig.usageAsCollateralEnabled) {
      return 0n;
    }

    const liquidationBonus = BigInt(collateralConfig.liquidationBonus);
    const rawCollateral = (
      debtToCover *
      debtPrice *
      liquidationBonus *
      (10n ** BigInt(collToken.decimals))
    ) / (
      (10n ** BigInt(debtToken.decimals)) *
      collateralPrice *
      BPS
    );

    return (rawCollateral * this.estimateBufferBps) / BPS;
  }

  async quoteDex(dex, collToken, debtToken, collateralAmount) {
    if (collateralAmount === 0n) return 0n;

    const pair = await dex.factory.getPair(collToken.address, debtToken.address);
    if (pair === ethers.ZeroAddress) return 0n;

    try {
      const amounts = await dex.router.getAmountsOut(collateralAmount, [collToken.address, debtToken.address]);
      return amounts[amounts.length - 1];
    } catch {
      return 0n;
    }
  }

  async estimateLiquidationRoute(collToken, debtToken, debtToCover, dex) {
    const collateralAmount = await this.estimateCollateralReceived(collToken, debtToken, debtToCover);
    const debtOut = await this.quoteDex(dex, collToken, debtToken, collateralAmount);
    const flashFee = (debtToCover * 5n) / BPS;
    const repayAmount = debtToCover + flashFee;

    if (debtOut <= repayAmount) return null;

    const estimatedProfit = debtOut - repayAmount;
    const estimatedProfitBase = await this.valueInBase(debtToken.address, estimatedProfit, debtToken.decimals);

    if (estimatedProfitBase < this.minNetProfitBase) return null;

    return {
      useQuickSwap: dex.useQuickSwap,
      dexName: dex.name,
      estimatedProfit,
      estimatedProfitBase,
      collateralAmount
    };
  }

  // ============ FIND BEST LIQUIDATION PARAMS ============
  async findBestParams(borrower, healthFactor) {
    let bestOpp      = null;
    let bestProfit   = 0n;

    for (const debtToken of DEBT_TOKENS) {
      for (const collToken of COLLATERAL_TOKENS) {
        if (debtToken.address === collToken.address) continue;

        try {
          const debtReserveData = await this.dataProvider.getUserReserveData(
            debtToken.address, borrower
          );

          const totalDebt = debtReserveData.currentVariableDebt + debtReserveData.currentStableDebt;
          if (totalDebt === 0n) continue;

          const closeFactorBps = healthFactor < CLOSE_FACTOR_HF_THRESHOLD ? BPS : 5000n;
          const debtToCover = (totalDebt * closeFactorBps) / BPS;
          if (debtToCover === 0n) continue;

          const debtToCoverBase = await this.valueInBase(debtToken.address, debtToCover, debtToken.decimals);
          if (debtToCoverBase < this.minDebtToCoverBase) continue;

          const remainingDebt = totalDebt - debtToCover;
          if (remainingDebt > 0n) {
            const remainingDebtBase = await this.valueInBase(debtToken.address, remainingDebt, debtToken.decimals);
            if (remainingDebtBase < this.minLeftoverDebtBase) continue;
          }

          const collateralReserveData = await this.dataProvider.getUserReserveData(
            collToken.address, borrower
          );

          if (
            collateralReserveData.currentATokenBalance === 0n ||
            !collateralReserveData.usageAsCollateralEnabled
          ) {
            continue;
          }

          const [quickSwapOpp, sushiSwapOpp] = await Promise.all([
            this.estimateLiquidationRoute(collToken, debtToken, debtToCover, this.dexes.quickswap),
            this.estimateLiquidationRoute(collToken, debtToken, debtToCover, this.dexes.sushiswap)
          ]);

          const bestHere = [quickSwapOpp, sushiSwapOpp]
            .filter(Boolean)
            .sort((a, b) => (a.estimatedProfitBase > b.estimatedProfitBase ? -1 : 1))[0];

          if (bestHere && bestHere.estimatedProfitBase > bestProfit) {
            bestProfit = bestHere.estimatedProfitBase;
            bestOpp = {
              borrower,
              collateralAsset:  collToken.address,
              debtAsset:        debtToken.address,
              debtToCover,
              useQuickSwap:     bestHere.useQuickSwap,
              dexName:          bestHere.dexName,
              estimatedProfit:  bestHere.estimatedProfit,
              estimatedProfitBase: bestHere.estimatedProfitBase,
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
      console.log(`   DEX: ${opp.dexName}`);
      console.log(`   Est. profit: ${this.formatAmount(opp.estimatedProfit, opp.profitDecimals, opp.debtSymbol)}`);

      const gasEst = await this.botContract.executeLiquidation.estimateGas(
        opp.collateralAsset, opp.debtAsset, opp.borrower, opp.debtToCover, opp.useQuickSwap
      );

      const gasCostBase = await this.estimateGasCostBase(gasEst);
      if (opp.estimatedProfitBase <= gasCostBase + this.minNetProfitBase) {
        console.log(`   Skipped: profit after gas is below ${this.minNetProfitUsd} USD`);
        this.cooldownBorrower(opp.borrower, "profit after gas too low");
        return false;
      }

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

      return true;

    } catch (e) {
      this.errorCount++;
      console.error(`❌ Failed: ${this.describeError(e)}`);
      this.cooldownBorrower(opp.borrower, "execution failed");
      return false;
    }
  }

  async estimateGasCostBase(gasEst) {
    if (!this.gasPrice) return 0n;

    const maticPrice = await this.priceOracle.getAssetPrice(TOKENS.WMATIC.address);
    const gasWei = (gasEst * this.gasPrice * 130n) / 100n;
    return (gasWei * maticPrice) / (10n ** 18n);
  }

  describeError(e) {
    const data = e?.data || e?.info?.error?.data || e?.error?.data || e?.revert?.data;
    const selector = typeof data === "string" ? data.slice(0, 10).toLowerCase() : "";
    const decoded = ERROR_SELECTORS[selector];

    if (decoded) {
      return `${decoded} (${selector})`;
    }

    return e.shortMessage || e.message;
  }

  // ============ MONITOR ============
  async monitorOpportunities() {
    if (!this.priceOracle) {
      await this.initialize();
    }

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

      if (Date.now() - this.lastScanStartedAt < SCAN_INTERVAL_MS) return;

      if (this.isScanning) {
        return;
      }

      this.isScanning = true;
      this.lastScanStartedAt = Date.now();

      try {
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

      const cooldownCount = atRisk.filter(({ user }) => this.isBorrowerCoolingDown(user)).length;
      atRisk = atRisk.filter(({ user }) => !this.isBorrowerCoolingDown(user));

      if (cooldownCount > 0) {
        console.log(`   Skipped ${cooldownCount} cooling-down borrower(s)`);
      }

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

        const opp = await this.findBestParams(user, healthFactor);
        if (opp && opp.estimatedProfitBase > bestProfit) {
          bestProfit = opp.estimatedProfitBase;
          bestOpp    = opp;
        } else if (!opp) {
          this.cooldownBorrower(user, "no profitable route");
        }
      }

      if (bestOpp) {
        console.log(`💰 Best opportunity! Profit: ${this.formatAmount(bestOpp.estimatedProfit, bestOpp.profitDecimals, bestOpp.debtSymbol)}`);
        await this.executeLiquidation(bestOpp);
      } else {
        console.log("   At-risk positions found but none profitable");
      }
      } catch (e) {
        this.errorCount++;
        console.error(`❌ Scan failed: ${this.describeError(e)}`);
      } finally {
        this.isScanning = false;
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
