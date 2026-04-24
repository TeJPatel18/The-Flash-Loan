// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Factory.sol";

// ============ AAVE V3 INTERFACES ============

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title LiquidationBot
 * @dev Liquidates undercollateralized Aave V3 positions using flash loans
 * Flow: Flash loan debt token → liquidate position → receive collateral → swap to debt token → repay
 */
contract LiquidationBot is IFlashLoanSimpleReceiver, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ============ CONSTANTS ============
    // Aave V3 Pool on Polygon Mainnet
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    // QuickSwap on Polygon
    address public constant QUICKSWAP_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    address public constant QUICKSWAP_FACTORY = 0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32;

    // SushiSwap on Polygon
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address public constant SUSHISWAP_FACTORY = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;

    uint256 private constant BASIS_POINTS = 10000;
    uint256 private constant MIN_PROFIT_THRESHOLD = 1e4; // Min profit before executing

    // ============ EVENTS ============
    event LiquidationExecuted(
        address indexed borrower,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profit
    );
    event EmergencyWithdraw(address token, uint256 amount);

    // ============ ERRORS ============
    error NotAavePool();
    error NotProfitable();
    error InvalidAddress();
    error PairNotFound();
    error InvalidFlashLoanAsset();

    constructor() Ownable(msg.sender) {}

    // ============ MAIN ENTRY — called by bot ============

    /**
     * @dev Initiate liquidation using Aave flash loan
     * @param collateralAsset Token used as collateral by borrower
     * @param debtAsset Token borrowed by borrower (we pay this)
     * @param borrower Address of undercollateralized user
     * @param debtToCover Amount of debt to repay (use type(uint256).max for max)
     * @param useQuickSwap true = QuickSwap, false = SushiSwap for collateral→debt swap
     */
    function executeLiquidation(
        address collateralAsset,
        address debtAsset,
        address borrower,
        uint256 debtToCover,
        bool useQuickSwap
    ) external nonReentrant whenNotPaused onlyOwner {
        require(collateralAsset != address(0), "Invalid collateral");
        require(debtAsset != address(0), "Invalid debt");
        require(borrower != address(0), "Invalid borrower");
        require(debtToCover > 0, "Invalid amount");

        // Encode params for callback
        bytes memory params = abi.encode(
            collateralAsset,
            debtAsset,
            borrower,
            debtToCover,
            useQuickSwap
        );

        // Flash loan the debt token from Aave
        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            debtAsset,
            debtToCover,
            params,
            0
        );
    }

    // ============ AAVE FLASH LOAN CALLBACK ============

    /**
     * @dev Called by Aave after flash loan is sent
     * Must repay amount + premium by end of function
     */
    function executeOperation(
        address asset,         // debt token we borrowed
        uint256 amount,        // amount borrowed
        uint256 premium,       // Aave fee (0.05%)
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Only Aave pool can call this
        if (msg.sender != AAVE_POOL) revert NotAavePool();
        if (initiator != address(this)) revert NotAavePool();

        (
            address collateralAsset,
            address debtAsset,
            address borrower,
            uint256 debtToCover,
            bool useQuickSwap
        ) = abi.decode(params, (address, address, address, uint256, bool));

        if (asset != debtAsset || amount != debtToCover) revert InvalidFlashLoanAsset();

        uint256 repayAmount = amount + premium;

        // Step 1 — Approve Aave to spend debt token for liquidation
        IERC20(debtAsset).forceApprove(AAVE_POOL, debtToCover);

        // Step 2 — Liquidate the borrower
        // We pay debtToCover, receive collateralAsset + 5% bonus
        uint256 collateralBefore = IERC20(collateralAsset).balanceOf(address(this));

        IPool(AAVE_POOL).liquidationCall(
            collateralAsset,
            debtAsset,
            borrower,
            debtToCover,
            false  // receive underlying token, not aToken
        );

        uint256 collateralReceived = IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
        require(collateralReceived > 0, "No collateral received");

        // Step 3 — Swap collateral back to debt token
        uint256 debtTokenReceived = _swapToDebtToken(
            collateralAsset,
            debtAsset,
            collateralReceived,
            repayAmount,
            useQuickSwap
        );

        // Step 4 — Check profit
        if (debtTokenReceived < repayAmount) revert NotProfitable();
        uint256 profit = debtTokenReceived - repayAmount;

        // Step 5 — Approve Aave to pull repayAmount
        IERC20(asset).forceApprove(AAVE_POOL, repayAmount);

        // Step 6 — Send profit to owner
        if (profit > 0) {
            IERC20(asset).safeTransfer(owner(), profit);
        }

        emit LiquidationExecuted(
            borrower,
            collateralAsset,
            debtAsset,
            debtToCover,
            collateralReceived,
            profit
        );

        return true;
    }

    // ============ INTERNAL — swap collateral to debt token ============

    function _swapToDebtToken(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 minOut,
        bool useQuickSwap
    ) private returns (uint256) {
        address routerAddr = useQuickSwap ? QUICKSWAP_ROUTER : SUSHISWAP_ROUTER;
        address factoryAddr = useQuickSwap ? QUICKSWAP_FACTORY : SUSHISWAP_FACTORY;
        if (IUniswapV2Factory(factoryAddr).getPair(collateralAsset, debtAsset) == address(0)) {
            revert PairNotFound();
        }

        IUniswapV2Router02 swapRouter = IUniswapV2Router02(routerAddr);

        address[] memory path = new address[](2);
        path[0] = collateralAsset;
        path[1] = debtAsset;

        IERC20(collateralAsset).forceApprove(routerAddr, collateralAmount);

        uint256 balanceBefore = IERC20(debtAsset).balanceOf(address(this));

        swapRouter.swapExactTokensForTokens(
            collateralAmount,
            minOut,
            path,
            address(this),
            block.timestamp + 300
        );

        return IERC20(debtAsset).balanceOf(address(this)) - balanceBefore;
    }

    // ============ VIEW — simulate profit before executing ============

    /**
     * @dev Estimate profit from liquidation before executing
     * @return estimatedProfit Expected profit in debt token units
     * @return isProfitable True if worth executing
     */
    function estimateLiquidationProfit(
        address collateralAsset,
        address debtAsset,
        uint256 debtToCover,
        bool useQuickSwap
    ) external view returns (uint256 estimatedProfit, bool isProfitable) {
        // Aave flash loan fee = 0.05%
        uint256 flashFee    = (debtToCover * 5) / 10000;
        uint256 repayAmount = debtToCover + flashFee;

        // Aave liquidation bonus = 5% (varies by asset, using 5% as base)
        uint256 collateralReceived = (debtToCover * 10500) / 10000;

        // Estimate swap output
        address routerAddr = useQuickSwap ? QUICKSWAP_ROUTER : SUSHISWAP_ROUTER;
        address factoryAddr = useQuickSwap ? QUICKSWAP_FACTORY : SUSHISWAP_FACTORY;
        if (IUniswapV2Factory(factoryAddr).getPair(collateralAsset, debtAsset) == address(0)) {
            return (0, false);
        }

        IUniswapV2Router02 swapRouter = IUniswapV2Router02(routerAddr);

        address[] memory path = new address[](2);
        path[0] = collateralAsset;
        path[1] = debtAsset;

        try swapRouter.getAmountsOut(collateralReceived, path) returns (uint256[] memory amounts) {
            uint256 debtTokenOut = amounts[1];
            if (debtTokenOut > repayAmount) {
                estimatedProfit = debtTokenOut - repayAmount;
                isProfitable = estimatedProfit > MIN_PROFIT_THRESHOLD;
            }
        } catch {
            estimatedProfit = 0;
            isProfitable = false;
        }
    }

    // ============ ADMIN ============

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function emergencyWithdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "No balance");
        IERC20(token).safeTransfer(owner(), bal);
        emit EmergencyWithdraw(token, bal);
    }

    function withdrawMatic() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }

    receive() external payable {}
}
