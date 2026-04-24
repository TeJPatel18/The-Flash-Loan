const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "MATIC");

  console.log("\nDeploying LiquidationBot...");

  const LiquidationBot = await ethers.getContractFactory("LiquidationBot");
  const bot = await LiquidationBot.deploy();

  await bot.waitForDeployment();
  const address = await bot.getAddress();

  console.log("✅ LiquidationBot deployed to:", address);

  console.log("\n=== Next Steps ===");
  console.log("1. Add to bot/.env:");
  console.log("   LIQUIDATION_BOT_ADDRESS=" + address);
  console.log("2. Run liquidation bot:");
  console.log("   node bot/liquidation-bot.js");
  console.log("3. Verify on PolygonScan:");
  console.log(`   npx hardhat verify --network polygon ${address}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
