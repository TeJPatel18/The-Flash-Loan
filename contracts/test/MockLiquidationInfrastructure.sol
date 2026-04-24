// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFlashLoanSimpleReceiverMock {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract MockAaveV3Pool {
    using SafeERC20 for IERC20;

    uint256 public premiumBps = 5;
    mapping(bytes32 => uint256) public liquidationCollateralOut;

    event MockFlashLoanRepaid(address indexed asset, uint256 amount, uint256 premium);
    event MockLiquidation(address indexed borrower, address collateralAsset, address debtAsset, uint256 debtCovered);

    function setPremiumBps(uint256 newPremiumBps) external {
        premiumBps = newPremiumBps;
    }

    function setLiquidationResult(address collateralAsset, address debtAsset, uint256 collateralOut) external {
        liquidationCollateralOut[_key(collateralAsset, debtAsset)] = collateralOut;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 premium = (amount * premiumBps) / 10000;

        IERC20(asset).safeTransfer(receiverAddress, amount);

        bool success = IFlashLoanSimpleReceiverMock(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            msg.sender,
            params
        );
        require(success, "CALLBACK_FAILED");

        IERC20(asset).safeTransferFrom(receiverAddress, address(this), amount + premium);
        emit MockFlashLoanRepaid(asset, amount, premium);
    }

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address borrower,
        uint256 debtToCover,
        bool
    ) external {
        uint256 collateralOut = liquidationCollateralOut[_key(collateralAsset, debtAsset)];
        require(collateralOut > 0, "NO_COLLATERAL_OUT");

        IERC20(debtAsset).safeTransferFrom(msg.sender, address(this), debtToCover);
        IERC20(collateralAsset).safeTransfer(msg.sender, collateralOut);

        emit MockLiquidation(borrower, collateralAsset, debtAsset, debtToCover);
    }

    function getUserAccountData(address) external pure returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    ) {
        return (0, 0, 0, 0, 0, 0);
    }

    function _key(address collateralAsset, address debtAsset) private pure returns (bytes32) {
        return keccak256(abi.encode(collateralAsset, debtAsset));
    }
}

contract MockLiquidationDexFactory {
    mapping(address => mapping(address => address)) public getPair;

    function setPair(address tokenA, address tokenB, address pair) external {
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}

contract MockLiquidationDexRouter {
    using SafeERC20 for IERC20;

    mapping(bytes32 => uint256) public amountOuts;

    function setAmountOut(address tokenIn, address tokenOut, uint256 amountOut) external {
        amountOuts[_key(tokenIn, tokenOut)] = amountOut;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        require(path.length == 2, "INVALID_PATH");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOuts[_key(path[0], path[1])];
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "EXPIRED");
        require(path.length == 2, "INVALID_PATH");

        uint256 amountOut = amountOuts[_key(path[0], path[1])];
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function _key(address tokenIn, address tokenOut) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn, tokenOut));
    }
}
