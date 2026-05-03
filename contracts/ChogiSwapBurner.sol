// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   ╔════════════════════════════════════════════════════════════════════════╗
   ║  ChogiSwapBurner · MON ↔ CHOGI w/ atomic burn                         ║
   ║                                                                        ║
   ║  Wraps SwapRouter02 (Uniswap V3 fork on Monad). Every swap routed      ║
   ║  through this contract automatically burns a configurable % of $CHOGI  ║
   ║  to the dead address — buy direction skims output CHOGI, sell direction║
   ║  skims input CHOGI before swap. Atomic, single tx, gas-cheap.         ║
   ║                                                                        ║
   ║  Default burn: 100 bps = 1.00%. Max: 1000 bps = 10%.                  ║
   ║                                                                        ║
   ║  Public counters: totalBurned, burnedByWallet. Read these for          ║
   ║  marketing copy + chogi.xyz/swap meter.                               ║
   ║                                                                        ║
   ║  No upgrade. No proxy. No admin keys for fund movement. Owner only     ║
   ║  controls burnBps (capped) and ownership transfer.                     ║
   ╚════════════════════════════════════════════════════════════════════════╝
*/

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IWMON {
    function withdraw(uint256) external;
    function deposit() external payable;
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

contract ChogiSwapBurner {
    // ─── constants ──────────────────────────────────────────────
    address public constant CHOGI  = 0x5E1b1A14c8758104B8560514e94ab8320e587777;
    address public constant WMON   = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address public constant ROUTER = 0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900;
    address public constant DEAD   = 0x000000000000000000000000000000000000dEaD;

    uint16 public constant MAX_BURN_BPS = 1000; // 10%

    // ─── state ──────────────────────────────────────────────────
    address public owner;
    uint16  public burnBps   = 100;            // 1.00%
    uint256 public totalBurned;
    mapping(address => uint256) public burnedByWallet;
    mapping(address => uint256) public swapsByWallet;

    // ─── events ─────────────────────────────────────────────────
    event SwapAndBurn(
        address indexed user,
        bool    indexed isBuy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 burned,
        uint24  fee
    );
    event BurnBpsUpdated(uint16 oldBps, uint16 newBps);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── errors ─────────────────────────────────────────────────
    error NotOwner();
    error BurnTooHigh();
    error SlippageExceeded();
    error TransferFailed();
    error ZeroAmount();
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        // pre-approve router for CHOGI so it can pull from us during sells
        IERC20(CHOGI).approve(ROUTER, type(uint256).max);
    }

    // ─── BUY: native MON → CHOGI ────────────────────────────────
    function buyChogiAndBurn(uint24 fee, uint256 minOutToUser)
        external payable returns (uint256 toUser)
    {
        if (msg.value == 0) revert ZeroAmount();

        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn:  WMON,
            tokenOut: CHOGI,
            fee:      fee,
            recipient: address(this),
            amountIn: msg.value,
            amountOutMinimum: 0,                 // checked after burn skim
            sqrtPriceLimitX96: 0
        });

        uint256 received = ISwapRouter02(ROUTER).exactInputSingle{value: msg.value}(params);

        uint256 burnAmt = (received * burnBps) / 10000;
        toUser = received - burnAmt;

        if (toUser < minOutToUser) revert SlippageExceeded();

        if (burnAmt > 0) {
            _safeTransferChogi(DEAD, burnAmt);
            totalBurned                += burnAmt;
            burnedByWallet[msg.sender] += burnAmt;
        }
        _safeTransferChogi(msg.sender, toUser);
        swapsByWallet[msg.sender]++;

        emit SwapAndBurn(msg.sender, true, msg.value, toUser, burnAmt, fee);
    }

    // ─── SELL: CHOGI → native MON ───────────────────────────────
    function sellChogiAndBurn(uint256 amountIn, uint24 fee, uint256 minOutToUser)
        external returns (uint256 monOut)
    {
        if (amountIn == 0) revert ZeroAmount();

        // pull from user (requires prior approval of this contract)
        if (!IERC20(CHOGI).transferFrom(msg.sender, address(this), amountIn))
            revert TransferFailed();

        uint256 burnAmt = (amountIn * burnBps) / 10000;
        uint256 swapAmt = amountIn - burnAmt;

        if (burnAmt > 0) {
            _safeTransferChogi(DEAD, burnAmt);
            totalBurned                += burnAmt;
            burnedByWallet[msg.sender] += burnAmt;
        }

        // swap remaining CHOGI → WMON to this contract
        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn:  CHOGI,
            tokenOut: WMON,
            fee:      fee,
            recipient: address(this),
            amountIn: swapAmt,
            amountOutMinimum: minOutToUser,
            sqrtPriceLimitX96: 0
        });
        uint256 wmonOut = ISwapRouter02(ROUTER).exactInputSingle(params);

        // unwrap WMON → native MON, forward to user
        IWMON(WMON).withdraw(wmonOut);
        (bool ok, ) = msg.sender.call{value: wmonOut}("");
        if (!ok) revert TransferFailed();

        swapsByWallet[msg.sender]++;
        monOut = wmonOut;

        emit SwapAndBurn(msg.sender, false, amountIn, monOut, burnAmt, fee);
    }

    // ─── views ──────────────────────────────────────────────────
    function quote(bool isBuy, uint256 expectedOut)
        external view returns (uint256 toUser, uint256 burned)
    {
        if (isBuy) {
            burned = (expectedOut * burnBps) / 10000;
            toUser = expectedOut - burned;
        } else {
            // for sells, "expectedOut" is the WMON output BEFORE skim
            // burn happens on input, so output to user = full quoted output of (amountIn * (1 - burnBps))
            // caller should pass quoted MON out for amountIn*(1-burnBps/10000)
            toUser = expectedOut;
            burned = 0; // burn was already accounted on input side
        }
    }

    function stats() external view returns (
        uint16  currentBurnBps,
        uint256 lifetimeBurned
    ) {
        return (burnBps, totalBurned);
    }

    // ─── admin ──────────────────────────────────────────────────
    function setBurnBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BURN_BPS) revert BurnTooHigh();
        emit BurnBpsUpdated(burnBps, bps);
        burnBps = bps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Re-approve router if allowance ever runs low (no risk: only sets
    /// approval on a hardcoded router; can't redirect anywhere).
    function refreshRouterApproval() external {
        IERC20(CHOGI).approve(ROUTER, type(uint256).max);
    }

    // ─── plumbing ───────────────────────────────────────────────
    function _safeTransferChogi(address to, uint256 amount) private {
        if (!IERC20(CHOGI).transfer(to, amount)) revert TransferFailed();
    }

    /// @notice receives MON from WMON.withdraw during sells
    receive() external payable {}
}
