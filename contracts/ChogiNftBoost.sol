// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   ╔════════════════════════════════════════════════════════════════════════╗
   ║  ChogiNftBoost · +1% APR loyalty boost for Chogi NFT holders          ║
   ║                                                                        ║
   ║  Hold ANY Chogi-ecosystem NFT + stake $CHOGI in Payroll              ║
   ║  → earn an extra 1% APR on your stake, paid from a dedicated pool.   ║
   ║                                                                        ║
   ║  HOW IT WORKS                                                          ║
   ║  ──────────                                                            ║
   ║   1. Side contract — purely additive. Existing Payroll stakers who   ║
   ║      don't hold a Chogi NFT see ZERO change.                          ║
   ║   2. Reads stakes via Payroll.positionsOf() (read-only).             ║
   ║   3. Counts only ACTIVE $CHOGI positions (matches holder-check).     ║
   ║   4. Reads NFT ownership across all whitelisted Chogi collections    ║
   ║      (Lab Subjects v1, v2, Pets, etc — owner can add more).         ║
   ║   5. If user holds ≥1 NFT → boost rate = 1% APR on their CHOGI       ║
   ║      stake. Otherwise zero.                                           ║
   ║   6. Bonded pets (settable via Pet contract) → 1.5% APR instead.     ║
   ║   7. Accrual is per-second; user calls claim() to harvest.           ║
   ║                                                                        ║
   ║  POOL FUNDING                                                          ║
   ║  ────────────                                                          ║
   ║   - Direct deposits: anyone can fund(amount) to add to the pool.     ║
   ║   - Mint cost redirects: ChogiPets/LabSubjects can route a slice    ║
   ║     of mint cost here (via fundFromMint, called by trusted minters). ║
   ║   - When pool empties, claims revert. No silent failures.            ║
   ║                                                                        ║
   ║  Built by King Petty for $CHOGI.                                      ║
   ╚════════════════════════════════════════════════════════════════════════╝
*/

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC721 {
    function balanceOf(address) external view returns (uint256);
}

interface IPayroll {
    // positionsOf returns Position[] memory — match deployed signature 0xf867d46b
    // We read it raw via low-level call to avoid Position struct ABI coupling.
}

interface IBondable {
    // Returns true if the wallet owns at least one bonded NFT in this collection.
    function hasBondedNftFor(address wallet) external view returns (bool);
}

contract ChogiNftBoost {
    // ─── Constants ───────────────────────────────────────────────
    IERC20  public constant CHOGI   = IERC20(0x5E1b1A14c8758104B8560514e94ab8320e587777);
    address public constant PAYROLL = 0x062E18beceF54077E6325B415aB74522d64D3af7;

    // Standard rate: 1% APR. Bonded rate: 1.5% APR.
    // Stored as basis points × 1e18 for precision (10000 bps = 100%).
    uint256 public standardRateBps = 100;   // 1.00%
    uint256 public bondedRateBps   = 150;   // 1.50%

    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant BPS_DENOM        = 10_000;

    // ─── Storage ─────────────────────────────────────────────────
    address public owner;
    bool    public paused;

    // NFT collections that count toward boost eligibility.
    // Owner can add (e.g. Pet NFT v2, partner drops) without redeploy.
    address[] public boostNfts;
    mapping(address => bool) public isBoostNft;
    mapping(address => bool) public isBondable;       // contract supports hasBondedNftFor()

    // Per-wallet accrual state. Each claim resets to now.
    mapping(address => uint256) public lastAccrualAt;

    // Trusted minters allowed to call fundFromMint() to deposit a portion
    // of mint cost directly to the pool.
    mapping(address => bool) public trustedMinters;

    // ─── Events ──────────────────────────────────────────────────
    event Claimed(address indexed wallet, uint256 amount);
    event Funded(address indexed from, uint256 amount, string source);
    event NftAdded(address indexed nft, bool bondable);
    event NftRemoved(address indexed nft);
    event RatesUpdated(uint256 standardBps, uint256 bondedBps);
    event MinterUpdated(address indexed minter, bool trusted);
    event PausedSet(bool paused);
    event OwnerTransferred(address indexed previous, address indexed next);

    // ─── Modifiers ───────────────────────────────────────────────
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier whenLive()  { require(!paused, "paused"); _; }

    constructor() {
        owner = msg.sender;
        lastAccrualAt[address(0)] = block.timestamp; // sentinel
    }

    // ─── Owner config ────────────────────────────────────────────
    function addBoostNft(address nft, bool bondable_) external onlyOwner {
        require(nft != address(0), "zero addr");
        require(!isBoostNft[nft], "already added");
        isBoostNft[nft] = true;
        isBondable[nft] = bondable_;
        boostNfts.push(nft);
        emit NftAdded(nft, bondable_);
    }

    function removeBoostNft(address nft) external onlyOwner {
        require(isBoostNft[nft], "not in list");
        isBoostNft[nft] = false;
        isBondable[nft] = false;
        // Compact array (gas: only on removal, infrequent)
        for (uint256 i = 0; i < boostNfts.length; i++) {
            if (boostNfts[i] == nft) {
                boostNfts[i] = boostNfts[boostNfts.length - 1];
                boostNfts.pop();
                break;
            }
        }
        emit NftRemoved(nft);
    }

    function setRates(uint256 standardBps, uint256 bondedBps) external onlyOwner {
        require(standardBps <= 2000 && bondedBps <= 3000, "rate too high"); // safety: max 20%/30%
        require(bondedBps >= standardBps, "bonded must be >= standard");
        standardRateBps = standardBps;
        bondedRateBps   = bondedBps;
        emit RatesUpdated(standardBps, bondedBps);
    }

    function setTrustedMinter(address minter, bool trusted) external onlyOwner {
        trustedMinters[minter] = trusted;
        emit MinterUpdated(minter, trusted);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "zero");
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    // Emergency: owner can sweep stuck tokens (NOT $CHOGI from the pool —
    // that protects user accruals). Useful if someone mis-sends a token.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(CHOGI), "use withdrawPool for CHOGI");
        IERC20(token).transfer(to, amount);
    }

    // Allows owner to wind down the pool (e.g. before redeploy). Emits a
    // visible event so users know.
    event PoolWithdrawn(address indexed to, uint256 amount);
    function withdrawPool(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero to");
        CHOGI.transfer(to, amount);
        emit PoolWithdrawn(to, amount);
    }

    // ─── Pool funding ────────────────────────────────────────────
    // Anyone can top up the pool. Tracked for transparency.
    function fund(uint256 amount) external {
        require(amount > 0, "zero amount");
        require(CHOGI.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit Funded(msg.sender, amount, "direct");
    }

    // Trusted minters call this to redirect a slice of mint cost into the pool.
    function fundFromMint(address from, uint256 amount, string calldata source) external {
        require(trustedMinters[msg.sender], "not trusted minter");
        require(amount > 0, "zero amount");
        require(CHOGI.transferFrom(from, address(this), amount), "transferFrom failed");
        emit Funded(from, amount, source);
    }

    // ─── Eligibility checks ──────────────────────────────────────
    /// @notice Total active $CHOGI a wallet has staked in Payroll.
    /// @dev    Reads positionsOf(address) on Payroll. Sums positions where
    ///         token == CHOGI && active == 1 (matches holder-check.js).
    function payrollChogiStakeOf(address wallet) public view returns (uint256 total) {
        // selector for positionsOf(address) = 0xf867d46b
        (bool ok, bytes memory data) = PAYROLL.staticcall(
            abi.encodeWithSelector(0xf867d46b, wallet)
        );
        if (!ok || data.length < 64) return 0;

        // Decode Position[] memory. Each Position struct = 7 fields × 32 bytes.
        // Layout assumed per holder-check.js — token at offset 0, amount at
        // offset 32, active at offset 192 (7th field).
        // Standard ABI: dynamic array → [offset][length][...elements...]
        assembly {
            // data layout: [32: offset to array][32: array length][positions...]
            let arrPtr := add(data, 32)             // skip length prefix added by Solidity
            let off    := mload(arrPtr)             // offset (relative) to array start
            let lenPtr := add(arrPtr, off)
            let len    := mload(lenPtr)
            let base   := add(lenPtr, 32)           // first element starts here
            let stride := mul(7, 32)                // 7 fields × 32 bytes per struct
            let chogiAddr := 0x5E1b1A14c8758104B8560514e94ab8320e587777

            for { let i := 0 } lt(i, len) { i := add(i, 1) } {
                let p      := add(base, mul(i, stride))
                let tok    := mload(p)              // field 0: token address
                let amt    := mload(add(p, 32))     // field 1: amount
                let active := mload(add(p, 192))    // field 6: active flag
                if and(eq(tok, chogiAddr), eq(active, 1)) {
                    total := add(total, amt)
                }
            }
        }
    }

    /// @notice True if wallet owns at least one boost-eligible NFT.
    function ownsAnyBoostNft(address wallet) public view returns (bool) {
        uint256 n = boostNfts.length;
        for (uint256 i = 0; i < n; i++) {
            address nft = boostNfts[i];
            try IERC721(nft).balanceOf(wallet) returns (uint256 bal) {
                if (bal > 0) return true;
            } catch { /* skip if NFT contract reverts */ }
        }
        return false;
    }

    /// @notice True if wallet owns at least one BONDED NFT in any bondable collection.
    function ownsBondedNft(address wallet) public view returns (bool) {
        uint256 n = boostNfts.length;
        for (uint256 i = 0; i < n; i++) {
            address nft = boostNfts[i];
            if (!isBondable[nft]) continue;
            try IBondable(nft).hasBondedNftFor(wallet) returns (bool bonded) {
                if (bonded) return true;
            } catch { /* skip */ }
        }
        return false;
    }

    /// @notice The active boost rate (bps APR) for a wallet right now.
    function effectiveRateBps(address wallet) public view returns (uint256) {
        if (!ownsAnyBoostNft(wallet)) return 0;
        if (ownsBondedNft(wallet))     return bondedRateBps;
        return standardRateBps;
    }

    // ─── Accrual & claim ─────────────────────────────────────────
    /// @notice Pending boost rewards a wallet can claim right now.
    /// @dev    pending = stake × rateBps × secondsElapsed / (BPS_DENOM × SECONDS_PER_YEAR)
    function pending(address wallet) public view returns (uint256) {
        uint256 rateBps = effectiveRateBps(wallet);
        if (rateBps == 0) return 0;

        uint256 stake = payrollChogiStakeOf(wallet);
        if (stake == 0) return 0;

        uint256 last = lastAccrualAt[wallet];
        if (last == 0) return 0; // first interaction sets the clock; nothing accrued yet
        uint256 elapsed = block.timestamp - last;
        if (elapsed == 0) return 0;

        return (stake * rateBps * elapsed) / (BPS_DENOM * SECONDS_PER_YEAR);
    }

    /// @notice Anyone can call to start accruing for a wallet (sets the clock).
    /// @dev    Required first interaction — without this, pending() returns 0.
    ///         Idempotent: re-calling resets the clock to now (which forfeits
    ///         any unclaimed accrual, so users typically claim() instead).
    function startAccrual() external {
        lastAccrualAt[msg.sender] = block.timestamp;
    }

    /// @notice Harvest pending boost rewards.
    function claim() external whenLive {
        uint256 amount = pending(msg.sender);
        require(amount > 0, "nothing to claim");
        require(CHOGI.balanceOf(address(this)) >= amount, "pool empty");
        lastAccrualAt[msg.sender] = block.timestamp;
        require(CHOGI.transfer(msg.sender, amount), "transfer failed");
        emit Claimed(msg.sender, amount);
    }

    // ─── Views (frontend convenience) ────────────────────────────
    function poolBalance() external view returns (uint256) {
        return CHOGI.balanceOf(address(this));
    }

    function boostNftCount() external view returns (uint256) {
        return boostNfts.length;
    }

    /// @notice Snapshot of everything the frontend needs in one call.
    function snapshot(address wallet) external view returns (
        uint256 stake,
        bool    hasNft,
        bool    hasBonded,
        uint256 rateBps,
        uint256 pendingNow,
        uint256 lastAt,
        uint256 pool
    ) {
        stake      = payrollChogiStakeOf(wallet);
        hasNft     = ownsAnyBoostNft(wallet);
        hasBonded  = ownsBondedNft(wallet);
        rateBps    = effectiveRateBps(wallet);
        pendingNow = pending(wallet);
        lastAt     = lastAccrualAt[wallet];
        pool       = CHOGI.balanceOf(address(this));
    }
}
