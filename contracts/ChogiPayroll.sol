// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   ╔════════════════════════════════════════════════════════════════════════╗
   ║  ChogiPayroll · stake $CHOGI (or any whitelisted Monad token)         ║
   ║  Earn $CHOGI rewards · share-of-pool only · no inflation              ║
   ║                                                                        ║
   ║  CHOGI MADE HERSELF CTO. SHE RUNS PAYROLL.                            ║
   ║                                                                        ║
   ║  HOW IT WORKS                                                          ║
   ║  ──────────                                                            ║
   ║  Reward pool grows from FOUR streams. None of them mint $CHOGI.       ║
   ║                                                                        ║
   ║   1. STAKE FEE                                                         ║
   ║      Every stake (any token) costs a flat 10,000 $CHOGI fee.           ║
   ║      The fee goes straight into the reward pool. Bootstraps day one.   ║
   ║                                                                        ║
   ║   2. PATRON DONATIONS                                                  ║
   ║      Anyone can call donate(amount). No return — just a permanent     ║
   ║      rank. INVESTOR → BENEFACTOR → BOARD MEMBER → FOUNDER.            ║
   ║                                                                        ║
   ║   3. SWAP-FEE SKIM                                                     ║
   ║      ChogiSwapBurner routes part of its 1% buy/sell fee here.         ║
   ║      Set on the burner via setPayroll().                              ║
   ║                                                                        ║
   ║   4. EARLY-TERMINATION FEE + FORFEITED REWARDS                        ║
   ║      Resign early? You forfeit pending rewards (recycled to staying   ║
   ║      staff) AND pay a linear-decay fee on principal.                  ║
   ║      Fee splits 30% burn / 70% recycle to remaining payroll.          ║
   ║                                                                        ║
   ║  COMMIT TIERS                                                          ║
   ║  ────────────                                                          ║
   ║   STAFF    ·  30d lock · 15% max term fee                              ║
   ║   EXEC     ·  60d lock · 20% max term fee                              ║
   ║   PARTNER  ·  90d lock · 25% max term fee                              ║
   ║   C-SUITE  · 180d lock · 30% max term fee                              ║
   ║                                                                        ║
   ║   No multipliers. Pure share-of-pool, weighted by stake amount.       ║
   ║   Length affects ONLY: the cliff timing and the early-term fee.       ║
   ║                                                                        ║
   ║  VESTING CLIFF: 90% of commit period.                                 ║
   ║   Pre-cliff: weight is in the pool but rewards are LOCKED.            ║
   ║   Post-cliff: rewards become claimable.                               ║
   ║   Resign pre-cliff = forfeit accrued rewards.                         ║
   ║                                                                        ║
   ║  MULTI-TOKEN                                                           ║
   ║  ──────────                                                            ║
   ║   Owner can whitelist any Monad ERC-20 with a `weightPerWei` ratio.   ║
   ║   1 CHOGI = 1e18 weight. Set other tokens by owner judgment.          ║
   ║   Non-CHOGI term fees go to a "stranded" balance the owner can sweep. ║
   ║                                                                        ║
   ║  Built by King Petty for $CHOGI · Monad mainnet                        ║
   ╚════════════════════════════════════════════════════════════════════════╝
*/

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC721Like {
    function balanceOf(address owner) external view returns (uint256);
}

contract ChogiPayroll {
    // ─── constants ──────────────────────────────────────────────
    IERC20  public constant CHOGI = IERC20(0x5E1b1A14c8758104B8560514e94ab8320e587777);
    address public constant DEAD  = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant STAKE_FEE     = 10_000 * 1e18;   // 10K CHOGI
    uint16  public constant CLIFF_BPS     = 9000;             // vest at 90%
    uint16  public constant TERM_BURN_BPS = 3000;             // 30% of fee burns
    uint256 public constant ACC_PRECISION = 1e30;

    // tier configuration — fixed at deploy
    uint32[4] public commitDays = [uint32(30), 60, 90, 180];
    uint16[4] public maxTermBps = [uint16(1500), 2000, 2500, 3000]; // 15-30%

    // ─── state ──────────────────────────────────────────────────
    address public owner;
    address public swapBurner;
    address public labSubjectsNft;   // optional boost source (display + future)
    bool    public paused;

    uint256 public totalWeighted;
    uint256 public accRewardPerWeight;
    uint256 private _pendingPreStake;

    uint256 public totalStakeFees;
    uint256 public totalDonated;
    uint256 public totalSwapFees;
    uint256 public totalTermFeesRecycled;
    uint256 public totalTermFeesBurned;
    uint256 public totalForfeited;
    uint256 public totalRewardsPaid;

    struct Asset {
        bool      accepted;
        uint128   weightPerWei;     // 1e18 = 1:1 with CHOGI
        uint256   totalDeposited;
        uint256   strandedFees;
    }
    mapping(address => Asset) public assets;
    address[] public assetList;

    struct Position {
        address  token;
        uint128  amount;
        uint128  weight;
        uint64   startTime;
        uint8    tier;
        uint8    active;
        uint256  rewardDebt;
    }
    mapping(address => Position[]) public positions;

    // patron leaderboard (cumulative donations)
    mapping(address => uint256) public lifetimeDonated;
    address[] private _patronList;
    mapping(address => bool) private _isPatron;

    // ─── events ─────────────────────────────────────────────────
    event Staked(
        address indexed user, uint256 indexed posIdx,
        address indexed token, uint256 amount, uint256 weight, uint8 tier, uint256 fee
    );
    event Unstaked(
        address indexed user, uint256 indexed posIdx,
        uint256 returned, uint256 termFee, uint256 reward, bool vested
    );
    event Claimed(address indexed user, uint256 indexed posIdx, uint256 reward);
    event Donated(address indexed patron, uint256 amount, uint256 lifetime);
    event SwapFeeReceived(uint256 amount);
    event TermFeeApplied(address indexed token, uint256 fee, uint256 forfeitedRewards);
    event AssetUpdated(address indexed token, uint128 weightPerWei, bool accepted);
    event StrandedFeesSwept(address indexed token, address indexed to, uint256 amount);
    event PausedUpdated(bool paused);
    event ConfigUpdated();
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── errors ─────────────────────────────────────────────────
    error NotOwner();
    error Paused();
    error BadTier();
    error TokenNotAccepted();
    error WeightTooLow();
    error NoPosition();
    error AlreadyClosed();
    error NotVested();
    error TransferFailed();
    error Reentrant();
    error NotBurner();
    error ZeroAmount();
    error ZeroAddress();
    error ChogiSweepBlocked();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier whenLive()  { if (paused) revert Paused(); _; }

    uint8 private _entered = 1;
    modifier nonReentrant() {
        if (_entered == 2) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        // CHOGI is accepted by default at 1:1 weight
        assets[address(CHOGI)] = Asset({
            accepted: true,
            weightPerWei: 1e18,
            totalDeposited: 0,
            strandedFees: 0
        });
        assetList.push(address(CHOGI));
        emit AssetUpdated(address(CHOGI), 1e18, true);
    }

    // ════════════════════════════════════════════════════════════
    // STAKE  (any whitelisted token + 10K CHOGI fee)
    // ════════════════════════════════════════════════════════════
    function stake(address token, uint256 amount, uint8 tier)
        external nonReentrant whenLive returns (uint256 posIdx)
    {
        if (tier > 3) revert BadTier();
        if (amount == 0) revert ZeroAmount();
        Asset storage a = assets[token];
        if (!a.accepted) revert TokenNotAccepted();

        // 1) collect 10K CHOGI fee
        if (!CHOGI.transferFrom(msg.sender, address(this), STAKE_FEE))
            revert TransferFailed();
        totalStakeFees += STAKE_FEE;

        // 2) collect stake amount in chosen token
        if (token == address(CHOGI)) {
            if (!CHOGI.transferFrom(msg.sender, address(this), amount))
                revert TransferFailed();
        } else {
            if (!IERC20(token).transferFrom(msg.sender, address(this), amount))
                revert TransferFailed();
        }
        a.totalDeposited += amount;

        // 3) compute weight (CHOGI-equivalent units)
        uint256 weight = (amount * uint256(a.weightPerWei)) / 1e18;
        if (weight == 0) revert WeightTooLow();

        totalWeighted += weight;

        // 4) fold the 10K fee + any pre-stake donations into accumulator NOW,
        //    so this fresh staker doesn't get them (they pay them).
        uint256 toFold = STAKE_FEE + _pendingPreStake;
        _pendingPreStake = 0;
        accRewardPerWeight += (toFold * ACC_PRECISION) / totalWeighted;

        // 5) anchor debt at post-fold accumulator
        uint256 debt = (accRewardPerWeight * weight) / ACC_PRECISION;

        positions[msg.sender].push(Position({
            token:      token,
            amount:     uint128(amount),
            weight:     uint128(weight),
            startTime:  uint64(block.timestamp),
            tier:       tier,
            active:     1,
            rewardDebt: debt
        }));
        posIdx = positions[msg.sender].length - 1;

        emit Staked(msg.sender, posIdx, token, amount, weight, tier, STAKE_FEE);
    }

    // ════════════════════════════════════════════════════════════
    // UNSTAKE (resign)
    // ════════════════════════════════════════════════════════════
    function unstake(uint256 posIdx)
        external nonReentrant
        returns (uint256 returned, uint256 termFee, uint256 reward)
    {
        Position storage p = positions[msg.sender][posIdx];
        if (p.active == 0) revert AlreadyClosed();
        if (p.amount == 0) revert NoPosition();

        address token = p.token;
        uint256 weighted = uint256(p.weight);
        uint256 amount   = uint256(p.amount);

        uint256 lockSec  = uint256(commitDays[p.tier]) * 1 days;
        uint256 cliffSec = (lockSec * CLIFF_BPS) / 10000;
        uint256 elapsed  = block.timestamp - uint256(p.startTime);
        bool vested = elapsed >= cliffSec;

        // 1) pending share = pool share since last debt anchor
        uint256 base = (accRewardPerWeight * weighted) / ACC_PRECISION;
        uint256 pending = base > p.rewardDebt ? (base - p.rewardDebt) : 0;

        // 2) early-term fee on principal (linear decay max → 0 at lock-end)
        if (elapsed < lockSec) {
            uint256 remaining = lockSec - elapsed;
            uint256 maxBps    = uint256(maxTermBps[p.tier]);
            uint256 feeBps    = (maxBps * remaining) / lockSec;
            termFee = (amount * feeBps) / 10000;
        }
        returned = amount - termFee;

        // 3) close position
        p.active = 0;
        totalWeighted -= weighted;
        assets[token].totalDeposited -= amount;

        // 4) vested vs not
        if (vested) {
            reward = pending;
        } else {
            // forfeit — recycle pending into pool so remaining staff get it
            if (pending > 0) {
                totalForfeited += pending;
                _addToPool(pending);
            }
        }

        // 5) handle term fee on principal
        if (termFee > 0) {
            if (token == address(CHOGI)) {
                uint256 toBurn    = (termFee * TERM_BURN_BPS) / 10000;
                uint256 toRecycle = termFee - toBurn;
                if (toBurn > 0) {
                    if (!CHOGI.transfer(DEAD, toBurn)) revert TransferFailed();
                    totalTermFeesBurned += toBurn;
                }
                if (toRecycle > 0) {
                    totalTermFeesRecycled += toRecycle;
                    _addToPool(toRecycle);
                }
            } else {
                // non-CHOGI: stranded balance, owner sweeps & manually contributes
                assets[token].strandedFees += termFee;
            }
            emit TermFeeApplied(token, termFee, vested ? 0 : pending);
        }

        // 6) payouts
        if (reward > 0) {
            if (!CHOGI.transfer(msg.sender, reward)) revert TransferFailed();
            totalRewardsPaid += reward;
        }
        if (returned > 0) {
            if (token == address(CHOGI)) {
                if (!CHOGI.transfer(msg.sender, returned)) revert TransferFailed();
            } else {
                if (!IERC20(token).transfer(msg.sender, returned)) revert TransferFailed();
            }
        }

        emit Unstaked(msg.sender, posIdx, returned, termFee, reward, vested);
    }

    // ════════════════════════════════════════════════════════════
    // CLAIM (cash paycheck — only after cliff)
    // ════════════════════════════════════════════════════════════
    function claim(uint256 posIdx) external nonReentrant returns (uint256 reward) {
        Position storage p = positions[msg.sender][posIdx];
        if (p.active == 0) revert AlreadyClosed();

        uint256 lockSec  = uint256(commitDays[p.tier]) * 1 days;
        uint256 cliffSec = (lockSec * CLIFF_BPS) / 10000;
        uint256 elapsed  = block.timestamp - uint256(p.startTime);
        if (elapsed < cliffSec) revert NotVested();

        uint256 base = (accRewardPerWeight * uint256(p.weight)) / ACC_PRECISION;
        reward = base > p.rewardDebt ? (base - p.rewardDebt) : 0;
        p.rewardDebt = base;

        if (reward > 0) {
            if (!CHOGI.transfer(msg.sender, reward)) revert TransferFailed();
            totalRewardsPaid += reward;
        }
        emit Claimed(msg.sender, posIdx, reward);
    }

    // ════════════════════════════════════════════════════════════
    // FUEL THE PAYROLL — donate or swap-fee skim
    // ════════════════════════════════════════════════════════════
    function donate(uint256 amount) external nonReentrant whenLive {
        if (amount == 0) revert ZeroAmount();
        if (!CHOGI.transferFrom(msg.sender, address(this), amount))
            revert TransferFailed();

        if (!_isPatron[msg.sender]) {
            _isPatron[msg.sender] = true;
            _patronList.push(msg.sender);
        }
        lifetimeDonated[msg.sender] += amount;
        totalDonated += amount;

        _addToPool(amount);
        emit Donated(msg.sender, amount, lifetimeDonated[msg.sender]);
    }

    function notifySwapFee(uint256 amount) external nonReentrant {
        if (msg.sender != swapBurner) revert NotBurner();
        if (amount == 0) return;
        totalSwapFees += amount;
        _addToPool(amount);
        emit SwapFeeReceived(amount);
    }

    function _addToPool(uint256 amount) internal {
        if (amount == 0) return;
        if (totalWeighted == 0) {
            _pendingPreStake += amount;
            return;
        }
        accRewardPerWeight += (amount * ACC_PRECISION) / totalWeighted;
    }

    // ════════════════════════════════════════════════════════════
    // VIEWS
    // ════════════════════════════════════════════════════════════
    function quoteUnstake(address user, uint256 posIdx) external view returns (
        uint256 returned, uint256 termFee, uint256 reward, bool vested, uint256 secondsToCliff
    ) {
        Position memory p = positions[user][posIdx];
        if (p.active == 0) return (0, 0, 0, false, 0);

        uint256 lockSec  = uint256(commitDays[p.tier]) * 1 days;
        uint256 cliffSec = (lockSec * CLIFF_BPS) / 10000;
        uint256 elapsed  = block.timestamp - uint256(p.startTime);
        vested = elapsed >= cliffSec;
        secondsToCliff = elapsed >= cliffSec ? 0 : (cliffSec - elapsed);

        uint256 base = (accRewardPerWeight * uint256(p.weight)) / ACC_PRECISION;
        uint256 pending = base > p.rewardDebt ? (base - p.rewardDebt) : 0;
        // surface the would-be reward only if vested
        reward = vested ? pending : 0;

        if (elapsed < lockSec) {
            uint256 remaining = lockSec - elapsed;
            uint256 maxBps    = uint256(maxTermBps[p.tier]);
            uint256 feeBps    = (maxBps * remaining) / lockSec;
            termFee = (uint256(p.amount) * feeBps) / 10000;
        }
        returned = uint256(p.amount) - termFee;
    }

    function pendingReward(address user, uint256 posIdx)
        external view returns (uint256 reward, bool vested)
    {
        Position memory p = positions[user][posIdx];
        if (p.active == 0) return (0, false);

        uint256 lockSec  = uint256(commitDays[p.tier]) * 1 days;
        uint256 cliffSec = (lockSec * CLIFF_BPS) / 10000;
        vested = (block.timestamp - uint256(p.startTime)) >= cliffSec;

        uint256 base = (accRewardPerWeight * uint256(p.weight)) / ACC_PRECISION;
        reward = base > p.rewardDebt ? (base - p.rewardDebt) : 0;
    }

    function positionsOf(address user) external view returns (Position[] memory) {
        return positions[user];
    }
    function positionCount(address user) external view returns (uint256) {
        return positions[user].length;
    }

    function poolMeter() external view returns (uint256 floatBalance, uint256 weighted) {
        // float = CHOGI in contract minus CHOGI principal currently staked
        uint256 chogiPrincipal = assets[address(CHOGI)].totalDeposited;
        uint256 bal = CHOGI.balanceOf(address(this));
        floatBalance = bal > chogiPrincipal ? bal - chogiPrincipal : 0;
        weighted = totalWeighted;
    }

    function patronCount() external view returns (uint256) { return _patronList.length; }
    function patronAt(uint256 i) external view returns (address) { return _patronList[i]; }
    function patronTier(address user) public view returns (uint8) {
        uint256 d = lifetimeDonated[user] / 1e18;
        if (d >= 100_000_000) return 4; // FOUNDER
        if (d >=  10_000_000) return 3; // BOARD
        if (d >=   1_000_000) return 2; // BENEFACTOR
        if (d >=     100_000) return 1; // INVESTOR
        return 0;
    }
    function assetCount() external view returns (uint256) { return assetList.length; }

    // ════════════════════════════════════════════════════════════
    // ADMIN
    // ════════════════════════════════════════════════════════════
    function whitelistAsset(address token, uint128 weightPerWei) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        Asset storage a = assets[token];
        if (!a.accepted) {
            assetList.push(token);
        }
        a.accepted = true;
        a.weightPerWei = weightPerWei;
        emit AssetUpdated(token, weightPerWei, true);
    }

    function delistAsset(address token) external onlyOwner {
        // existing positions in this token still work; just no new stakes
        if (token == address(CHOGI)) revert ChogiSweepBlocked(); // CHOGI always on
        assets[token].accepted = false;
        emit AssetUpdated(token, assets[token].weightPerWei, false);
    }

    function sweepStrandedFees(address token, address to) external onlyOwner {
        if (token == address(CHOGI)) revert ChogiSweepBlocked();
        if (to == address(0)) revert ZeroAddress();
        uint256 amt = assets[token].strandedFees;
        if (amt > 0) {
            assets[token].strandedFees = 0;
            if (!IERC20(token).transfer(to, amt)) revert TransferFailed();
            emit StrandedFeesSwept(token, to, amt);
        }
    }

    function setSwapBurner(address b) external onlyOwner {
        swapBurner = b;
        emit ConfigUpdated();
    }
    function setLabSubjectsNft(address n) external onlyOwner {
        labSubjectsNft = n;
        emit ConfigUpdated();
    }
    function setPaused(bool v) external onlyOwner {
        paused = v;
        emit PausedUpdated(v);
    }
    function transferOwnership(address n) external onlyOwner {
        if (n == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, n);
        owner = n;
    }

    /// Owner cannot pull principal. Sweep restricted to non-CHOGI tokens
    /// accidentally sent here (NOT staked-token deposits — those are tracked
    /// in `assets[token].totalDeposited` and live in the contract for stakers).
    function sweepLooseTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(CHOGI)) revert ChogiSweepBlocked();
        if (to == address(0)) revert ZeroAddress();
        // only allow sweeping the *excess* over what's tracked as deposited+stranded
        Asset memory a = assets[token];
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 reserved = a.totalDeposited + a.strandedFees;
        require(bal >= reserved + amount, "would touch user funds");
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}
