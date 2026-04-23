const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "MATIC");

  if (balance < ethers.parseEther("0.1")) {
    console.warn("⚠️  Low balance! Need at least 0.1 MATIC for deployment.");
  }

  // ============ POLYGON MAINNET ADDRESSES ============
  const FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32"; // QuickSwap Factory
  const ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap Router
  const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC on Polygon
  const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC
  const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"; // WETH on Polygon
  const DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"; // DAI on Polygon

  // Chainlink Oracles on Polygon
  const ORACLE_USDC = "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7"; // USDC/USD
  const ORACLE_WETH = "0xF9680D99D6C9589e2a93a78A04A279e509205945"; // ETH/USD
  const ORACLE_DAI = "0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D"; // DAI/USD
  const ORACLE_MATIC = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0"; // MATIC/USD

  // Fee recipient = your deployer wallet (change to multisig later)
  const FEE_RECIPIENT = deployer.address;

  // ============ DEPLOY ============
  console.log("\nDeploying FlashLoanPolygon...");

  const FlashLoanPolygon = await ethers.getContractFactory("FlashLoanPolygon");
  const flashLoan = await FlashLoanPolygon.deploy(
    FACTORY,
    ROUTER,
    USDC,
    WMATIC,
    WETH,
    DAI,
    ORACLE_USDC,   // default oracle for USDC set in constructor
    FEE_RECIPIENT
  );

  // ✅ ethers v6 syntax
  await flashLoan.waitForDeployment();
  const contractAddress = await flashLoan.getAddress();

  console.log("✅ FlashLoanPolygon deployed to:", contractAddress);

  // ============ SET ORACLES FOR OTHER TOKENS ============
  console.log("\nSetting oracles for WETH, DAI, WMATIC...");

  const tx1 = await flashLoan.setTokenOracle(WETH, ORACLE_WETH);
  await tx1.wait();
  console.log("✅ WETH oracle set");

  const tx2 = await flashLoan.setTokenOracle(DAI, ORACLE_DAI);
  await tx2.wait();
  console.log("✅ DAI oracle set");

  const tx3 = await flashLoan.setTokenOracle(WMATIC, ORACLE_MATIC);
  await tx3.wait();
  console.log("✅ WMATIC oracle set");

  // ============ VERIFY DEPLOYMENT ============
  console.log("\n=== Deployment Verification ===");
  console.log("Factory  :", await flashLoan.factory());
  console.log("Router   :", await flashLoan.router());
  console.log("USDC     :", await flashLoan.USDC());
  console.log("WMATIC   :", await flashLoan.WMATIC());
  console.log("WETH     :", await flashLoan.WETH());
  console.log("DAI      :", await flashLoan.DAI());
  console.log("Fee Recip:", await flashLoan.feeRecipient());
  console.log("Owner    :", await flashLoan.owner());

  console.log("\n=== Initial State ===");
  console.log("Protocol Fee (bps)    :", (await flashLoan.protocolFeeBps()).toString());
  console.log("Circuit Breaker Active:", await flashLoan.circuitBreakerActive());

  const [used, max, resetTime] = await flashLoan.getDailyVolumeUsage();
  console.log("Daily Volume Used     :", used.toString());
  console.log("Daily Volume Max      :", max.toString());

  // ============ SUMMARY ============
  console.log("\n=== Summary ===");
  console.log("✅ Contract deployed:", contractAddress);
  console.log("✅ All 4 oracles set (USDC, WETH, DAI, WMATIC)");
  console.log("✅ Risk configs initialized");
  console.log("✅ Circuit breaker ready");

  console.log("\n=== Next Steps ===");
  console.log("1. Save contract address:", contractAddress);
  console.log("2. Add it to bot/.env as FLASH_LOAN_ADDRESS");
  console.log("3. Test on Amoy testnet first before mainnet");
  console.log("4. Verify contract on PolygonScan:");
  console.log(`   npx hardhat verify --network polygon ${contractAddress} ${FACTORY} ${ROUTER} ${USDC} ${WMATIC} ${WETH} ${DAI} ${ORACLE_USDC} ${FEE_RECIPIENT}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
