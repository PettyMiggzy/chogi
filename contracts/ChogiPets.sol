// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   ╔════════════════════════════════════════════════════════════════════════╗
   ║  ChogiPets · ERC-721 NFT for the Chogi pet ecosystem                  ║
   ║                                                                        ║
   ║  Tradeable from day one. 5% ERC-2981 royalty to buyback wallet.       ║
   ║  Owner-flippable soulbound switch for emergency containment.          ║
   ║                                                                        ║
   ║  MINT PATHS                                                            ║
   ║  ──────────                                                            ║
   ║   1. STANDARD MINT — burn $CHOGI to mint. Cost set by backend in     ║
   ║      EIP-712 permit. Default 100,000 $CHOGI per pet (configurable    ║
   ║      per-mint). Slice routes to NftBoost pool for boost rewards.    ║
   ║   2. SNAPSHOT CLAIM — existing hatched users (snapshot at deploy)    ║
   ║      get a free mint via signed permit (cost=0).                     ║
   ║                                                                        ║
   ║  BONDED TRAIT                                                          ║
   ║  ────────────                                                          ║
   ║   Set via setBonded() with a signed permit when the off-chain care   ║
   ║   tracker (Supabase) confirms a 30+ day care streak. Bonded is per   ║
   ║   PET (sticks with NFT through transfers — pet history matters).    ║
   ║   Bonded pets earn 1.5% APR boost (vs 1% standard) via NftBoost.    ║
   ║                                                                        ║
   ║  TRAITS                                                                ║
   ║  ──────                                                                ║
   ║   Frozen on-chain at mint: { tier, hatchedAt, generation, traitHash }║
   ║   Bonded flag mutable (one-way: never un-bonded).                    ║
   ║                                                                        ║
   ║  Built by King Petty for $CHOGI.                                      ║
   ╚════════════════════════════════════════════════════════════════════════╝
*/

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
}
interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}
interface INftBoost {
    function fundFromMint(address from, uint256 amount, string calldata source) external;
}

contract ChogiPets {
    // ─── Constants ───────────────────────────────────────────────
    string  public constant name   = "Chogi Pets";
    string  public constant symbol = "CHOGIPET";
    IERC20  public constant CHOGI  = IERC20(0x5E1b1A14c8758104B8560514e94ab8320e587777);
    address public constant DEAD   = 0x000000000000000000000000000000000000dEaD;

    // ─── Storage ─────────────────────────────────────────────────
    address public owner;
    address public signer;                         // backend EIP-712 signer
    address public nftBoost;                       // ChogiNftBoost contract (receives mint slice)
    address public royaltyReceiver;                // buyback wallet
    uint96  public royaltyBps      = 500;          // 5%
    bool    public soulbound       = false;        // tradeable by default; owner can flip
    bool    public mintEnabled     = true;
    string  public baseURI         = "https://chogi.xyz/api/metadata/pet/";

    // What % of mint cost flows to the NftBoost pool (rest goes to dead).
    // Default 20% to pool, 80% burned. Owner adjustable.
    uint256 public boostPoolBps    = 2000;

    uint256 public totalSupply;

    struct Pet {
        uint8   tier;          // rarity tier (project-defined)
        uint8   generation;    // 0 = genesis, 1 = first breed, etc.
        uint64  hatchedAt;     // block timestamp at mint
        bool    bonded;        // care streak hit 30+ days
        bytes32 traitHash;     // off-chain trait derivation seed
    }
    mapping(uint256 => Pet) public pets;

    // ERC-721 storage
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _opApproval;

    // Replay protection for permits
    mapping(bytes32 => bool) public usedDigests;

    // EIP-712 domain (computed once, cached)
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant MINT_TYPEHASH = keccak256(
        "Mint(address to,uint8 tier,uint8 generation,bytes32 traitHash,uint256 mintCost,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant BOND_TYPEHASH = keccak256(
        "Bond(uint256 tokenId,uint256 nonce,uint256 deadline)"
    );

    // ─── Events ──────────────────────────────────────────────────
    // ERC-721
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    // Project-specific
    event PetMinted(uint256 indexed tokenId, address indexed to, uint8 tier, uint256 mintCost);
    event PetBonded(uint256 indexed tokenId);
    event SoulboundFlipped(bool soulbound);
    event SignerSet(address indexed signer);
    event RoyaltySet(address indexed receiver, uint96 bps);
    event NftBoostSet(address indexed boost);
    event BoostPoolBpsSet(uint256 bps);
    event MintEnabledSet(bool enabled);
    event BaseURISet(string uri);
    event OwnerTransferred(address indexed previous, address indexed next);

    // ─── Modifiers ───────────────────────────────────────────────
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address signer_, address royaltyReceiver_) {
        require(signer_ != address(0), "zero signer");
        require(royaltyReceiver_ != address(0), "zero royalty");
        owner           = msg.sender;
        signer          = signer_;
        royaltyReceiver = royaltyReceiver_;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("ChogiPets")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    // ─── Mint via signed permit ──────────────────────────────────
    /// @param to         recipient (typically msg.sender)
    /// @param tier       rarity tier set by backend
    /// @param generation 0 = genesis, 1 = first breed, etc.
    /// @param traitHash  off-chain trait derivation seed
    /// @param mintCost   $CHOGI cost in wei (0 = free claim for snapshot users)
    /// @param nonce      unique-per-permit (backend supplies)
    /// @param deadline   unix timestamp after which permit invalid
    /// @param signature  EIP-712 signature from `signer`
    function mintWithPermit(
        address to,
        uint8   tier,
        uint8   generation,
        bytes32 traitHash,
        uint256 mintCost,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 tokenId) {
        require(mintEnabled, "mint disabled");
        require(block.timestamp <= deadline, "permit expired");
        require(to != address(0), "zero to");

        bytes32 structHash = keccak256(abi.encode(
            MINT_TYPEHASH, to, tier, generation, traitHash, mintCost, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(!usedDigests[digest], "permit used");
        usedDigests[digest] = true;

        require(_recover(digest, signature) == signer, "bad signature");

        // Charge mint cost (skip if free claim)
        if (mintCost > 0) {
            uint256 toPool = (mintCost * boostPoolBps) / 10_000;
            uint256 toBurn = mintCost - toPool;
            if (toBurn > 0) {
                require(CHOGI.transferFrom(msg.sender, DEAD, toBurn), "burn xfer failed");
            }
            if (toPool > 0 && nftBoost != address(0)) {
                // Trusted-minter callback: contract must be set as trusted on NftBoost.
                INftBoost(nftBoost).fundFromMint(msg.sender, toPool, "pet-mint");
            } else if (toPool > 0) {
                // Boost not set yet — burn the entire amount instead of stranding it.
                require(CHOGI.transferFrom(msg.sender, DEAD, toPool), "burn xfer failed");
            }
        }

        // Mint
        tokenId = ++totalSupply;
        pets[tokenId] = Pet({
            tier:        tier,
            generation:  generation,
            hatchedAt:   uint64(block.timestamp),
            bonded:      false,
            traitHash:   traitHash
        });
        _mint(to, tokenId);
        emit PetMinted(tokenId, to, tier, mintCost);
    }

    // ─── Set bonded via signed permit ────────────────────────────
    /// @notice Mark a pet bonded (one-way) when off-chain care tracker confirms
    ///         the wallet has cared for this pet 30+ consecutive days.
    /// @dev    Permit must be signed by `signer`. Anyone can submit (gas paid
    ///         by submitter; typically the pet owner themself).
    function setBonded(
        uint256 tokenId,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(_ownerOf[tokenId] != address(0), "no pet");
        require(!pets[tokenId].bonded, "already bonded");
        require(block.timestamp <= deadline, "permit expired");

        bytes32 structHash = keccak256(abi.encode(BOND_TYPEHASH, tokenId, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(!usedDigests[digest], "permit used");
        usedDigests[digest] = true;

        require(_recover(digest, signature) == signer, "bad signature");

        pets[tokenId].bonded = true;
        emit PetBonded(tokenId);
    }

    // ─── Bondable hook for ChogiNftBoost ─────────────────────────
    /// @notice True if wallet owns at least one bonded pet. Used by NftBoost.
    function hasBondedNftFor(address wallet) external view returns (bool) {
        if (_balanceOf[wallet] == 0) return false;
        // Linear scan is acceptable: pets are minted sequentially, and the
        // boost contract calls this read-only off the user's claim path.
        // Caller can move logic to events/snapshots if scan ever gets heavy.
        uint256 supply = totalSupply;
        for (uint256 i = 1; i <= supply; i++) {
            if (_ownerOf[i] == wallet && pets[i].bonded) return true;
        }
        return false;
    }

    // ─── ERC-721 core ────────────────────────────────────────────
    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _ownerOf[tokenId];
        require(o != address(0), "no token");
    }
    function balanceOf(address a) external view returns (uint256) {
        require(a != address(0), "zero addr");
        return _balanceOf[a];
    }
    function getApproved(uint256 tokenId) external view returns (address) {
        require(_ownerOf[tokenId] != address(0), "no token");
        return _approved[tokenId];
    }
    function isApprovedForAll(address ownerAddr, address operator) public view returns (bool) {
        return _opApproval[ownerAddr][operator];
    }
    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        require(msg.sender == o || _opApproval[o][msg.sender], "not authorized");
        _approved[tokenId] = to;
        emit Approval(o, to, tokenId);
    }
    function setApprovalForAll(address operator, bool approved) external {
        _opApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }
    function transferFrom(address from, address to, uint256 tokenId) public {
        require(!soulbound, "soulbound");
        _transfer(from, to, tokenId);
    }
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) ==
                IERC721Receiver.onERC721Received.selector,
                "non ERC721Receiver"
            );
        }
    }
    function _transfer(address from, address to, uint256 tokenId) internal {
        require(to != address(0), "zero to");
        require(_ownerOf[tokenId] == from, "not owner");
        require(
            msg.sender == from ||
            _approved[tokenId] == msg.sender ||
            _opApproval[from][msg.sender],
            "not authorized"
        );
        delete _approved[tokenId];
        unchecked { _balanceOf[from] -= 1; _balanceOf[to] += 1; }
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
    function _mint(address to, uint256 tokenId) internal {
        require(_ownerOf[tokenId] == address(0), "exists");
        unchecked { _balanceOf[to] += 1; }
        _ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_ownerOf[tokenId] != address(0), "no token");
        return string(abi.encodePacked(baseURI, _toString(tokenId)));
    }

    // ─── ERC-2981 royalty ────────────────────────────────────────
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }

    // ─── ERC-165 ─────────────────────────────────────────────────
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return
            id == 0x01ffc9a7 || // ERC-165
            id == 0x80ac58cd || // ERC-721
            id == 0x5b5e139f || // ERC-721 metadata
            id == 0x2a55205a;   // ERC-2981
    }

    // ─── Owner config ────────────────────────────────────────────
    function setSigner(address s) external onlyOwner {
        require(s != address(0), "zero");
        signer = s;
        emit SignerSet(s);
    }
    function setRoyalty(address r, uint96 bps) external onlyOwner {
        require(r != address(0), "zero");
        require(bps <= 1000, "max 10%");
        royaltyReceiver = r;
        royaltyBps      = bps;
        emit RoyaltySet(r, bps);
    }
    function setNftBoost(address b) external onlyOwner {
        nftBoost = b;
        emit NftBoostSet(b);
    }
    function setBoostPoolBps(uint256 bps) external onlyOwner {
        require(bps <= 10_000, "max 100%");
        boostPoolBps = bps;
        emit BoostPoolBpsSet(bps);
    }
    function flipSoulbound(bool s) external onlyOwner {
        soulbound = s;
        emit SoulboundFlipped(s);
    }
    function setMintEnabled(bool e) external onlyOwner {
        mintEnabled = e;
        emit MintEnabledSet(e);
    }
    function setBaseURI(string calldata uri) external onlyOwner {
        baseURI = uri;
        emit BaseURISet(uri);
    }
    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "zero");
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    // ─── Internal helpers ────────────────────────────────────────
    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, s);
    }
    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len--; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
