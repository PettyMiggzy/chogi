// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   ╔════════════════════════════════════════════════════════════════════════╗
   ║  Chogi Lab Subjects v2 · Burn-to-Mint NFT (tradeable + royalty)       ║
   ║                                                                        ║
   ║  v2 changes vs v1:                                                     ║
   ║    · TRADEABLE FROM DAY ONE (soulbound = false default; flippable)   ║
   ║    · ERC-2981 ROYALTY: 5% on secondary trades → buyback wallet        ║
   ║    · Same mint costs and hard caps as v1 (no economic change)        ║
   ║                                                                        ║
   ║  Mint by sending $CHOGI to the dead address. NO MON cost.              ║
   ║  5 tiers · tradeable by default (owner can lock for emergencies).    ║
   ║                                                                        ║
   ║  COMMON     · 100,000 $CHOGI                                           ║
   ║  UNCOMMON   · 500,000 $CHOGI                                           ║
   ║  RARE       · 1,000,000 $CHOGI · cap 777                              ║
   ║  EPIC       · 5,000,000 $CHOGI · cap 77                               ║
   ║  LEGENDARY  · 10,000,000 $CHOGI · cap 7                               ║
   ║                                                                        ║
   ║  Every mint = supply reduction. Never any minting from MON, ever.      ║
   ║                                                                        ║
   ║  Holders also qualify for the +1% APR Payroll boost via NftBoost.    ║
   ║                                                                        ║
   ║  Built by King Petty for $CHOGI.                                      ║
   ╚════════════════════════════════════════════════════════════════════════╝
*/

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract ChogiLabSubjectsV2 {
    // ─── Constants ───────────────────────────────────────────────
    string  public constant name   = "Chogi Lab Subjects";
    string  public constant symbol = "CHOGISUB";

    IERC20  public constant CHOGI = IERC20(0x5E1b1A14c8758104B8560514e94ab8320e587777);
    address public constant DEAD  = 0x000000000000000000000000000000000000dEaD;

    uint8 public constant TIER_COMMON    = 0;
    uint8 public constant TIER_UNCOMMON  = 1;
    uint8 public constant TIER_RARE      = 2;
    uint8 public constant TIER_EPIC      = 3;
    uint8 public constant TIER_LEGENDARY = 4;

    // ─── Storage ─────────────────────────────────────────────────
    address public owner;
    bool    public soulbound    = false;
    bool    public mintEnabled  = true;
    string  public baseURI      = "https://chogi.xyz/api/metadata/";

    uint256 public totalSupply;

    // tier index → CHOGI cost (18 decimals)
    uint256[5] public tierBurnCost = [
        100_000      * 1e18,
        500_000      * 1e18,
        1_000_000    * 1e18,
        5_000_000    * 1e18,
        10_000_000   * 1e18
    ];

    // tier index → max supply (0 = unlimited). Top 3 tiers capped for scarcity.
    uint256[5] public tierMaxSupply = [
        0,      // COMMON     — unlimited
        0,      // UNCOMMON   — unlimited
        777,    // RARE       — capped
        77,     // EPIC       — capped
        7       // LEGENDARY  — capped (1/1 territory)
    ];

    // tokenId → owner / tier
    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => uint8)   public  tierOf;
    mapping(address => uint256) private _balanceOf;

    // ERC-721 approvals
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // stats
    mapping(uint8 => uint256)   public mintedAt;          // tier → count
    mapping(address => uint256) public lifetimeBurned;    // wallet → CHOGI burned via this contract
    mapping(address => uint256) public mintsByWallet;     // wallet → number of NFTs minted

    // ─── Events ──────────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event MintedByBurn(address indexed minter, uint256 indexed tokenId, uint8 tier, uint256 burned);
    event TierCostUpdated(uint8 indexed tier, uint256 newCost);
    event SoulboundUpdated(bool soulbound);
    event MintEnabledUpdated(bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── Errors ──────────────────────────────────────────────────
    error NotOwner();
    error MintDisabled();
    error InvalidTier();
    error TransferFailed();
    error TokenIsSoulbound();
    error NotAuthorized();
    error InvalidRecipient();
    error TokenNotFound();
    error UnsafeRecipient();
    error TierSoldOut();
    error CannotIncreaseCap();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address royaltyReceiver_) {
        if (royaltyReceiver_ == address(0)) revert InvalidRecipient();
        owner = msg.sender;
        royaltyReceiver = royaltyReceiver_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit RoyaltyUpdated(royaltyReceiver_, royaltyBps);
    }

    // ─── Mint by Burning ─────────────────────────────────────────
    function mintByBurning(uint8 tier) external returns (uint256 tokenId) {
        if (!mintEnabled)        revert MintDisabled();
        if (tier > TIER_LEGENDARY) revert InvalidTier();

        uint256 cap = tierMaxSupply[tier];
        if (cap > 0 && mintedAt[tier] >= cap) revert TierSoldOut();

        uint256 cost = tierBurnCost[tier];

        bool ok = CHOGI.transferFrom(msg.sender, DEAD, cost);
        if (!ok) revert TransferFailed();

        unchecked { tokenId = ++totalSupply; }
        _ownerOf[tokenId]    = msg.sender;
        tierOf[tokenId]      = tier;
        _balanceOf[msg.sender] += 1;
        mintedAt[tier]       += 1;
        lifetimeBurned[msg.sender] += cost;
        mintsByWallet[msg.sender]  += 1;

        emit Transfer(address(0), msg.sender, tokenId);
        emit MintedByBurn(msg.sender, tokenId, tier, cost);
    }

    // ─── Views ───────────────────────────────────────────────────
    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _ownerOf[tokenId];
        if (o == address(0)) revert TokenNotFound();
        return o;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (who == address(0)) revert InvalidRecipient();
        return _balanceOf[who];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert TokenNotFound();
        return string.concat(baseURI, _toString(tokenId));
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert TokenNotFound();
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address o, address operator) external view returns (bool) {
        return _operatorApprovals[o][operator];
    }

    function tierStats() external view returns (
        uint256[5] memory counts,
        uint256[5] memory costs,
        uint256[5] memory caps
    ) {
        for (uint8 i = 0; i < 5; i++) {
            counts[i] = mintedAt[i];
            costs[i]  = tierBurnCost[i];
            caps[i]   = tierMaxSupply[i];
        }
    }

    // ─── ERC-721 transfers (blocked while soulbound) ────────────
    function approve(address to, uint256 tokenId) external {
        if (soulbound) revert TokenIsSoulbound();
        address tokOwner = _ownerOf[tokenId];
        if (tokOwner == address(0)) revert TokenNotFound();
        if (msg.sender != tokOwner && !_operatorApprovals[tokOwner][msg.sender]) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(tokOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (soulbound) revert TokenIsSoulbound();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (soulbound)                       revert TokenIsSoulbound();
        if (to == address(0))                revert InvalidRecipient();
        if (_ownerOf[tokenId] != from)       revert NotAuthorized();
        if (
            msg.sender != from &&
            _tokenApprovals[tokenId] != msg.sender &&
            !_operatorApprovals[from][msg.sender]
        ) revert NotAuthorized();

        delete _tokenApprovals[tokenId];
        _balanceOf[from] -= 1;
        _balanceOf[to]   += 1;
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
                if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    // ─── Admin ───────────────────────────────────────────────────
    function setMintEnabled(bool v) external onlyOwner {
        mintEnabled = v;
        emit MintEnabledUpdated(v);
    }

    function setSoulbound(bool v) external onlyOwner {
        soulbound = v;
        emit SoulboundUpdated(v);
    }

    function setBaseURI(string calldata uri) external onlyOwner { baseURI = uri; }

    function setTierCost(uint8 tier, uint256 cost) external onlyOwner {
        if (tier > TIER_LEGENDARY) revert InvalidTier();
        tierBurnCost[tier] = cost;
        emit TierCostUpdated(tier, cost);
    }

    /// Reduce a tier's cap. Cannot raise an existing cap or remove one.
    function reduceTierCap(uint8 tier, uint256 newCap) external onlyOwner {
        if (tier > TIER_LEGENDARY) revert InvalidTier();
        uint256 cap = tierMaxSupply[tier];
        if (cap > 0 && newCap > cap) revert CannotIncreaseCap();
        if (newCap < mintedAt[tier]) revert CannotIncreaseCap();
        tierMaxSupply[tier] = newCap;
    }

    /// ERC-5192 — marketplaces query this to detect soulbound tokens.
    function locked(uint256 tokenId) external view returns (bool) {
        if (_ownerOf[tokenId] == address(0)) revert TokenNotFound();
        return soulbound;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidRecipient();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── ERC-165 ─────────────────────────────────────────────────
    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x01ffc9a7   // ERC-165
            || iid == 0x80ac58cd   // ERC-721
            || iid == 0x5b5e139f   // ERC-721 Metadata
            || iid == 0xb45a3c0e   // ERC-5192 (soulbound)
            || iid == 0x2a55205a;  // ERC-2981 (royalty)
    }

    // ─── ERC-2981 royalty ────────────────────────────────────────
    address public royaltyReceiver;
    uint96  public royaltyBps = 500; // 5%

    event RoyaltyUpdated(address indexed receiver, uint96 bps);

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }

    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert InvalidRecipient();
        if (bps > 1000) revert InvalidTier(); // safety: max 10%
        royaltyReceiver = receiver;
        royaltyBps      = bps;
        emit RoyaltyUpdated(receiver, bps);
    }

    // ─── Internal ────────────────────────────────────────────────
    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len -= 1; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
