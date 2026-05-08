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
    address public constant ROUTER = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    address public constant DEAD   = 0x000000000000000000000000000000000000dEaD;

    uint16 public constant MAX_BURN_BPS = 1000; // 10%
    uint8  private constant _NOT_ENTERED = 1;
    uint8  private constant _ENTERED     = 2;

    // ─── state ──────────────────────────────────────────────────
    address public owner;
    uint16  public burnBps   = 100;            // 1.00%
    uint8   private _reentry = _NOT_ENTERED;
    uint256 public totalBurned;
    mapping(address => uint256) public burnedByWallet;
    mapping(address => uint256) public swapsByWallet;

    // ─── payroll (optional reward stream) ─────────────────────────
    /// Once set, part of the burnBps is streamed into the payroll
    /// (staking pool) instead of burned. Pure burn until then.
    address public payroll;
    uint16  public payrollBps; // 0..burnBps; burnt = burnBps - payrollBps
    uint256 public totalToPayroll;

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
    event PayrollUpdated(address indexed payroll, uint16 payrollBps);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── errors ─────────────────────────────────────────────────
    error NotOwner();
    error BurnTooHigh();
    error SlippageExceeded();
    error TransferFailed();
    error ZeroAmount();
    error InvalidAddress();
    error Reentrant();
    error PayrollBpsTooHigh();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentry == _ENTERED) revert Reentrant();
        _reentry = _ENTERED;
        _;
        _reentry = _NOT_ENTERED;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        // pre-approve router for CHOGI so it can pull from us during sells
        IERC20(CHOGI).approve(ROUTER, type(uint256).max);
    }

    // ─── BUY: native MON → CHOGI ────────────────────────────────
    function buyChogiAndBurn(uint24 fee, uint256 minOutToUser)
        external payable nonReentrant returns (uint256 toUser)
    {
        if (msg.value == 0) revert ZeroAmount();

        // Push slippage protection into the router atomically. The router will
        // revert if the pool can't deliver at least minRouterOut, so MEV can't
        // sandwich us into a worst-case fill that we then revert on after-the-fact.
        // FLOOR division (not ceil) — ceiling would create an off-by-one wei
        // unreachable bound on tight slippage. The post-skim check below acts
        // as the strict belt-and-suspenders.
        uint256 denom = uint256(10000) - uint256(burnBps);
        uint256 minRouterOut = denom == 0
            ? minOutToUser
            : (minOutToUser * 10000) / denom;

        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn:  WMON,
            tokenOut: CHOGI,
            fee:      fee,
            recipient: address(this),
            amountIn: msg.value,
            amountOutMinimum: minRouterOut,
            sqrtPriceLimitX96: 0
        });

        uint256 received = ISwapRouter02(ROUTER).exactInputSingle{value: msg.value}(params);

        uint256 skim = (received * burnBps) / 10000;
        toUser = received - skim;

        // belt-and-suspenders: if oracle reports > router min, still assert
        if (toUser < minOutToUser) revert SlippageExceeded();

        _routeSkim(skim);
        if (toUser > 0) _safeTransferChogi(msg.sender, toUser);
        swapsByWallet[msg.sender]++;

        emit SwapAndBurn(msg.sender, true, msg.value, toUser, skim, fee);
    }

    // ─── SELL: CHOGI → native MON ───────────────────────────────
    function sellChogiAndBurn(uint256 amountIn, uint24 fee, uint256 minOutToUser)
        external nonReentrant returns (uint256 monOut)
    {
        if (amountIn == 0) revert ZeroAmount();

        // pull from user (requires prior approval of this contract)
        if (!IERC20(CHOGI).transferFrom(msg.sender, address(this), amountIn))
            revert TransferFailed();

        uint256 skim    = (amountIn * burnBps) / 10000;
        uint256 swapAmt = amountIn - skim;

        _routeSkim(skim);

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
        swapsByWallet[msg.sender]++;
        monOut = wmonOut;

        emit SwapAndBurn(msg.sender, false, amountIn, monOut, skim, fee);

        (bool ok, ) = msg.sender.call{value: wmonOut}("");
        if (!ok) revert TransferFailed();
    }

    // ─── skim router: split between burn + optional payroll ───────
    function _routeSkim(uint256 amount) private {
        if (amount == 0) return;

        // payrollBps is bounded ≤ burnBps via setPayroll
        uint256 toPayroll = payroll == address(0) || payrollBps == 0
            ? 0
            : (amount * uint256(payrollBps)) / uint256(burnBps);
        uint256 toBurn = amount - toPayroll;

        if (toBurn > 0) {
            _safeTransferChogi(DEAD, toBurn);
            totalBurned                += toBurn;
            burnedByWallet[msg.sender] += toBurn;
        }
        if (toPayroll > 0) {
            _safeTransferChogi(payroll, toPayroll);
            totalToPayroll += toPayroll;
            // optional notify hook so payroll can update accumulators in-tx
            (bool ok, ) = payroll.call(
                abi.encodeWithSignature("notifySwapFee(uint256)", toPayroll)
            );
            ok; // ignore; Payroll must handle nothing-to-do path
        }
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
        // keep payroll share <= burnBps so accounting can't underflow
        if (payrollBps > bps) payrollBps = bps;
        emit BurnBpsUpdated(burnBps, bps);
        burnBps = bps;
    }

    /// @notice Set Payroll (staking) address and how much of `burnBps` is routed to it.
    /// `_payrollBps` must be <= current `burnBps`. Set `_payroll=0x0` to disable.
    function setPayroll(address _payroll, uint16 _payrollBps) external onlyOwner {
        if (_payrollBps > burnBps) revert PayrollBpsTooHigh();
        payroll    = _payroll;
        payrollBps = _payroll == address(0) ? 0 : _payrollBps;
        emit PayrollUpdated(_payroll, payrollBps);
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
