// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface IHook {
    function claimVault() external view returns (address);
    function poolAssets(bytes32) external view returns (address, address, bool);
    function poolRecipients(bytes32) external view returns (address, address, address, address);
    function utilityLiability(bytes32) external view returns (uint256);
    function utilityRedeemed(bytes32) external view returns (uint256);
}
interface IVault {
    function redeem(bytes32, uint8, uint256) external;
}
interface IRouter {
    function execute(bytes calldata, bytes[] calldata, uint256) external payable;
}
interface IV2 {
    function WETH() external view returns (address);
    function factory() external view returns (address);
    function addLiquidityETH(
        address,
        uint256,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (uint256, uint256, uint256);
}
interface IFactory {
    function getPair(address, address) external view returns (address);
}
/// @notice Single-launch native-ETH utility receiver. Snapshot publisher is trusted for holder weights.
contract UtilityEngine {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    struct Epoch {
        uint256 createdBlock;
        uint256 snapshotBlock;
        bytes32 snapshotHash;
        uint256 ethBudget;
        uint256 lpBudget;
        bytes32 root;
        uint256 ethPaid;
        uint256 lpPaid;
    }
    address public owner;
    address public publisher;
    address public pendingOwner;
    address public keeper;
    address public treasury;
    IHook public immutable hook;
    IVault public immutable vault;
    IRouter public immutable router;
    IV2 public immutable v2;
    bool public immutable sixField;
    address public token;
    address public pair;
    bytes32 public poolId;
    bool public paused = true;
    bool private locked;
    uint16 public burnBps = 4000;
    uint16 public rewardBps = 3000;
    uint16 public liquidityBps = 3000;
    uint16 public treasuryLpBps = 2000;
    uint256 public reservedETH;
    uint256 public reservedLP;
    uint256 public epochCount;
    uint256 public lastProcessedAt;
    uint256 public totalProcessed;
    uint256 public totalBurned;
    uint256 public totalLpMinted;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public paid;
    mapping(address => uint256) public deferredETH;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    event Processed(
        uint256 indexed epoch,
        uint256 snapshotBlock,
        uint256 ethIn,
        uint256 tokensBurned,
        uint256 lpMinted,
        uint256 ethRewards,
        uint256 holderLP
    );
    event RootPublished(uint256 indexed epoch, bytes32 root);
    event Paid(
        uint256 indexed epoch,
        address indexed holder,
        uint256 ethAmount,
        uint256 lpAmount,
        bool ethDeferred
    );
    event AllocationsSet(uint16 burn, uint16 rewards, uint16 liquidity, uint16 treasuryLP);
    modifier onlyOwner() {
        require(msg.sender == owner, 'owner');
        _;
    }
    modifier guard() {
        require(!locked, 'reentrant');
        locked = true;
        _;
        locked = false;
    }
    constructor(
        address owner_,
        address keeper_,
        address treasury_,
        address hook_,
        address router_,
        address v2_,
        bool six_
    ) {
        require(owner_ != address(0) && keeper_ != address(0) && treasury_ != address(0), 'zero');
        require(hook_.code.length > 0 && router_.code.length > 0 && v2_.code.length > 0, 'code');
        owner = owner_;
        publisher = owner_;
        keeper = keeper_;
        treasury = treasury_;
        hook = IHook(hook_);
        vault = IVault(IHook(hook_).claimVault());
        router = IRouter(router_);
        v2 = IV2(v2_);
        sixField = six_;
        require(address(vault).code.length > 0 && v2.WETH().code.length > 0, 'wiring');
    }
    receive() external payable {}
    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), 'zero');
        pendingOwner = next;
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, 'pending');
        owner = msg.sender;
        pendingOwner = address(0);
    }
    function setPublisher(address next) external onlyOwner {
        require(next != address(0), 'zero');
        publisher = next;
    }
    function setKeeper(address next) external onlyOwner {
        require(next != address(0), 'zero');
        keeper = next;
    }
    function setPaused(bool value) external onlyOwner {
        paused = value;
    }
    function setAllocations(uint16 b, uint16 r, uint16 l, uint16 t) external onlyOwner {
        require(uint256(b) + r + l == 10000 && t <= 10000, 'allocation');
        burnBps = b;
        rewardBps = r;
        liquidityBps = l;
        treasuryLpBps = t;
        emit AllocationsSet(b, r, l, t);
    }
    // Deploy receiver before launch; bind once after launch has registered it.
    function bind(address token_, bytes32 id) external onlyOwner {
        require(token == address(0) && token_.code.length > 0, 'bound/token');
        (address actual, address quote, bool first) = hook.poolAssets(id);
        (, , , address recipient) = hook.poolRecipients(id);
        require(
            actual == token_ && quote == address(0) && first && recipient == address(this),
            'native utility required'
        );
        require(
            id == keccak256(abi.encode(PoolKey(address(0), token_, 0, 60, address(hook)))),
            'pool key'
        );
        token = token_;
        poolId = id;
    }
    function pendingFees() public view returns (uint256) {
        return
            token == address(0) ? 0 : hook.utilityLiability(poolId) - hook.utilityRedeemed(poolId);
    }
    function availableETH() public view returns (uint256) {
        return address(this).balance - reservedETH;
    }
    function collect() public guard {
        require(token != address(0), 'unbound');
        uint256 n = pendingFees();
        if (n > 0) vault.redeem(poolId, 3, n);
    }
    // Keeper supplies independently checked min-outs and a recent finalized snapshot.
    function process(
        uint256 amount,
        uint128 minBuyOut,
        uint256 minTokenLP,
        uint256 minEthLP,
        uint256 minLP,
        uint256 deadline,
        uint256 snapshot
    ) external guard {
        require(msg.sender == keeper && !paused && token != address(0), 'inactive');
        require(block.timestamp >= lastProcessedAt + 600, 'cadence');
        require(deadline >= block.timestamp && deadline <= block.timestamp + 300, 'deadline');
        require(snapshot < block.number && blockhash(snapshot) != bytes32(0), 'snapshot');
        require(amount > 0 && amount <= availableETH(), 'budget');
        uint256 burn = (amount * burnBps) / 10000;
        uint256 liquidity = (amount * liquidityBps) / 10000;
        uint256 reward = amount - burn - liquidity;
        uint256 buy = burn + liquidity / 2;
        uint256 bought;
        if (buy > 0) {
            require(minBuyOut > 0 && buy <= type(uint128).max, 'min buy');
            bought = _buy(uint128(buy), minBuyOut, deadline);
        }
        uint256 burned = buy == 0 ? 0 : (bought * burn) / buy;
        if (burned > 0) _send(token, DEAD, burned);
        uint256 minted;
        if (liquidity > 0) {
            require(minTokenLP > 0 && minEthLP > 0 && minLP > 0, 'min lp');
            uint256 desired = IERC20(token).balanceOf(address(this));
            require(IERC20(token).approve(address(v2), desired), 'approve');
            (, , minted) = v2.addLiquidityETH{value: liquidity - liquidity / 2}(
                token,
                desired,
                minTokenLP,
                minEthLP,
                address(this),
                deadline
            );
            require(IERC20(token).approve(address(v2), 0), 'reset');
            require(minted >= minLP, 'lp slippage');
            address resolved = IFactory(v2.factory()).getPair(token, v2.WETH());
            require(resolved != address(0) && (pair == address(0) || pair == resolved), 'pair');
            pair = resolved;
        }
        uint256 treasuryLP = (minted * treasuryLpBps) / 10000;
        if (treasuryLP > 0) _send(pair, treasury, treasuryLP);
        uint256 holderLP = minted - treasuryLP;
        reservedETH += reward;
        reservedLP += holderLP;
        uint256 e = ++epochCount;
        epochs[e] = Epoch(
            block.number,
            snapshot,
            blockhash(snapshot),
            reward,
            holderLP,
            bytes32(0),
            0,
            0
        );
        lastProcessedAt = block.timestamp;
        totalProcessed += amount;
        totalBurned += burned;
        totalLpMinted += minted;
        emit Processed(e, snapshot, amount, burned, minted, reward, holderLP);
    }
    function _buy(uint128 amount, uint128 minimum, uint256 deadline) private returns (uint256) {
        PoolKey memory key = PoolKey(address(0), token, 0, 60, address(hook));
        bytes[] memory p = new bytes[](3);
        p[0] =
            sixField
                ? abi.encode(key, true, amount, minimum, uint256(0), bytes(''))
                : abi.encode(key, true, amount, minimum, bytes(''));
        p[1] = abi.encode(address(0), uint256(0), true);
        p[2] = abi.encode(token, address(this), uint256(0));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(hex'060b0e', p);
        inputs[1] = abi.encode(address(0), address(1), uint256(0));
        uint256 before_ = IERC20(token).balanceOf(address(this));
        router.execute{value: amount}(hex'1004', inputs, deadline);
        uint256 out = IERC20(token).balanceOf(address(this)) - before_;
        require(out >= minimum, 'buy slippage');
        return out;
    }
    function publishRoot(uint256 e, bytes32 root) external {
        require(msg.sender == publisher, 'publisher');
        Epoch storage x = epochs[e];
        require(e > 0 && e <= epochCount && x.root == bytes32(0) && root != bytes32(0), 'epoch');
        x.root = root;
        emit RootPublished(e, root);
    }
    function leaf(
        uint256 e,
        address holder,
        uint256 ethAmount,
        uint256 lpAmount
    ) public view returns (bytes32) {
        return
            keccak256(
                bytes.concat(
                    keccak256(
                        abi.encode(block.chainid, address(this), e, holder, ethAmount, lpAmount)
                    )
                )
            );
    }
    struct Payment {
        uint256 epoch;
        address holder;
        uint256 ethAmount;
        uint256 lpAmount;
        bytes32[] proof;
    }
    function payBatch(Payment[] calldata payments) external guard {
        require(payments.length > 0 && payments.length <= 50, 'batch size');
        for (uint256 i; i < payments.length; i++) {
            Payment calldata p = payments[i];
            if (!paid[p.epoch][p.holder]) _pay(p.epoch, p.holder, p.ethAmount, p.lpAmount, p.proof);
        }
    }
    function pay(
        uint256 e,
        address holder,
        uint256 ethAmount,
        uint256 lpAmount,
        bytes32[] calldata proof
    ) external guard {
        _pay(e, holder, ethAmount, lpAmount, proof);
    }
    function _pay(
        uint256 e,
        address holder,
        uint256 ethAmount,
        uint256 lpAmount,
        bytes32[] calldata proof
    ) private {
        Epoch storage x = epochs[e];
        require(!paid[e][holder] && holder != address(0) && x.root != bytes32(0), 'paid/root');
        bytes32 h = leaf(e, holder, ethAmount, lpAmount);
        for (uint256 i; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        require(h == x.root, 'proof');
        require(
            x.ethPaid + ethAmount <= x.ethBudget && x.lpPaid + lpAmount <= x.lpBudget,
            'budget'
        );
        paid[e][holder] = true;
        x.ethPaid += ethAmount;
        x.lpPaid += lpAmount;
        bool deferred;
        if (ethAmount > 0) {
            (bool ok, ) = holder.call{value: ethAmount, gas: 30000}('');
            if (ok) reservedETH -= ethAmount;
            else {
                deferredETH[holder] += ethAmount;
                deferred = true;
            }
        }
        if (lpAmount > 0) {
            reservedLP -= lpAmount;
            _send(pair, holder, lpAmount);
        }
        emit Paid(e, holder, ethAmount, lpAmount, deferred);
    }
    function withdrawDeferred(address payable to) external guard {
        uint256 n = deferredETH[msg.sender];
        require(n > 0 && to != address(0), 'empty');
        deferredETH[msg.sender] = 0;
        reservedETH -= n;
        (bool ok, ) = to.call{value: n}('');
        require(ok, 'send');
    }
    function _send(address asset, address to, uint256 n) private {
        require(IERC20(asset).transfer(to, n), 'transfer');
    }
}
