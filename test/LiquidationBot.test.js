const { expect } = require("chai");
const { ethers } = require("hardhat");

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const QUICKSWAP_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const SUSHISWAP_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

async function installMockAt(contractName, targetAddress) {
  const Factory = await ethers.getContractFactory(contractName);
  const deployed = await Factory.deploy();
  await deployed.waitForDeployment();

  const code = await ethers.provider.getCode(await deployed.getAddress());
  await ethers.provider.send("hardhat_setCode", [targetAddress, code]);

  return ethers.getContractAt(contractName, targetAddress);
}

describe("LiquidationBot", function () {
  let owner, borrower, attacker;
  let debtToken, collateralToken;
  let liquidationBot;
  let aavePool, quickswapFactory, quickswapRouter, sushiswapFactory, sushiswapRouter;

  const debtToCover = ethers.parseEther("100");
  const premium = (debtToCover * 5n) / 10000n;
  const repayAmount = debtToCover + premium;
  const collateralOut = ethers.parseEther("200");
  const profit = ethers.parseEther("10");

  beforeEach(async function () {
    [owner, borrower, attacker] = await ethers.getSigners();

    aavePool = await installMockAt("MockAaveV3Pool", AAVE_POOL);
    quickswapFactory = await installMockAt("MockLiquidationDexFactory", QUICKSWAP_FACTORY);
    quickswapRouter = await installMockAt("MockLiquidationDexRouter", QUICKSWAP_ROUTER);
    sushiswapFactory = await installMockAt("MockLiquidationDexFactory", SUSHISWAP_FACTORY);
    sushiswapRouter = await installMockAt("MockLiquidationDexRouter", SUSHISWAP_ROUTER);

    await aavePool.setPremiumBps(5);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    debtToken = await MockERC20.deploy("Debt Token", "DEBT");
    collateralToken = await MockERC20.deploy("Collateral Token", "COLL");
    await debtToken.waitForDeployment();
    await collateralToken.waitForDeployment();

    await debtToken.mint(AAVE_POOL, ethers.parseEther("1000000"));
    await collateralToken.mint(AAVE_POOL, ethers.parseEther("1000000"));
    await debtToken.mint(QUICKSWAP_ROUTER, ethers.parseEther("1000000"));
    await debtToken.mint(SUSHISWAP_ROUTER, ethers.parseEther("1000000"));

    await aavePool.setLiquidationResult(collateralToken.target, debtToken.target, collateralOut);
    await quickswapFactory.setPair(collateralToken.target, debtToken.target, owner.address);
    await sushiswapFactory.setPair(collateralToken.target, debtToken.target, owner.address);
    await quickswapRouter.setAmountOut(collateralToken.target, debtToken.target, repayAmount + profit);
    await sushiswapRouter.setAmountOut(collateralToken.target, debtToken.target, repayAmount + profit);

    const LiquidationBot = await ethers.getContractFactory("LiquidationBot");
    liquidationBot = await LiquidationBot.deploy();
    await liquidationBot.waitForDeployment();
  });

  it("takes a flash loan, liquidates, repays Aave, and sends profit to the owner", async function () {
    const ownerBalanceBefore = await debtToken.balanceOf(owner.address);

    await expect(
      liquidationBot.executeLiquidation(
        collateralToken.target,
        debtToken.target,
        borrower.address,
        debtToCover,
        true
      )
    )
      .to.emit(liquidationBot, "LiquidationExecuted")
      .withArgs(
        borrower.address,
        collateralToken.target,
        debtToken.target,
        debtToCover,
        collateralOut,
        profit
      );

    expect(await debtToken.balanceOf(owner.address)).to.equal(ownerBalanceBefore + profit);
    expect(await debtToken.balanceOf(liquidationBot.target)).to.equal(0n);
    expect(await collateralToken.balanceOf(liquidationBot.target)).to.equal(0n);
    expect(await debtToken.balanceOf(AAVE_POOL)).to.equal(ethers.parseEther("1000000") + debtToCover + premium);
  });

  it("only lets the contract owner start liquidations", async function () {
    await expect(
      liquidationBot.connect(attacker).executeLiquidation(
        collateralToken.target,
        debtToken.target,
        borrower.address,
        debtToCover,
        true
      )
    )
      .to.be.revertedWithCustomError(liquidationBot, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
  });

  it("reverts before execution when the selected DEX has no direct pair", async function () {
    await quickswapFactory.setPair(collateralToken.target, debtToken.target, ethers.ZeroAddress);

    await expect(
      liquidationBot.executeLiquidation(
        collateralToken.target,
        debtToken.target,
        borrower.address,
        debtToCover,
        true
      )
    ).to.be.revertedWithCustomError(liquidationBot, "PairNotFound");
  });

  it("reverts when the collateral swap cannot cover repayment", async function () {
    await quickswapRouter.setAmountOut(collateralToken.target, debtToken.target, repayAmount - 1n);

    await expect(
      liquidationBot.executeLiquidation(
        collateralToken.target,
        debtToken.target,
        borrower.address,
        debtToCover,
        true
      )
    ).to.be.revertedWith("INSUFFICIENT_OUTPUT_AMOUNT");
  });

  it("rejects direct callback calls from non-Aave addresses", async function () {
    await expect(
      liquidationBot.executeOperation(
        debtToken.target,
        debtToCover,
        premium,
        liquidationBot.target,
        "0x"
      )
    ).to.be.revertedWithCustomError(liquidationBot, "NotAavePool");
  });

  it("returns no estimated profit when the selected DEX pair is missing", async function () {
    await quickswapFactory.setPair(collateralToken.target, debtToken.target, ethers.ZeroAddress);

    const [estimatedProfit, isProfitable] = await liquidationBot.estimateLiquidationProfit(
      collateralToken.target,
      debtToken.target,
      debtToCover,
      true
    );

    expect(estimatedProfit).to.equal(0n);
    expect(isProfitable).to.equal(false);
  });
});
