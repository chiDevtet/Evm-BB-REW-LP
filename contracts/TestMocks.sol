// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import './UtilityEngine.sol';
// TEST ONLY: Anvil has no ArbOS. Offset separates L2 height from the EVM opcode
// in regression tests; zero offset adapts real fork headers to the ArbSys ABI.
contract TestArbSys {
    uint256 public offset;
    bool public zeroHash;
    function configure(uint256 value, bool zero) external {
        offset = value;
        zeroHash = zero;
    }
    function arbBlockNumber() external view returns (uint256) {
        return block.number + offset;
    }
    function arbBlockHash(uint256 number) external view returns (bytes32) {
        uint256 current = block.number + offset;
        require(number < current && current - number <= 256, 'invalid arb block');
        return zeroHash ? bytes32(0) : blockhash(number - offset);
    }
}
contract MockToken {
    string public symbol = 'TEST';
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 n) external {
        totalSupply += n;
        balanceOf[to] += n;
        emit Transfer(address(0), to, n);
    }
    function transfer(address to, uint256 n) external returns (bool) {
        _transfer(msg.sender, to, n);
        return true;
    }
    function approve(address s, uint256 n) external returns (bool) {
        allowance[msg.sender][s] = n;
        return true;
    }
    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        allowance[from][msg.sender] -= n;
        _transfer(from, to, n);
        return true;
    }
    function _transfer(address from, address to, uint256 n) private {
        balanceOf[from] -= n;
        balanceOf[to] += n;
        emit Transfer(from, to, n);
    }
}
contract MockHook {
    address public claimVault;
    address public token;
    address public recipient;
    address public quote;
    address public poolManager = address(0x1234);
    mapping(bytes32 => uint256) public utilityLiability;
    mapping(bytes32 => uint256) public utilityRedeemed;
    function configure(address v, address t, address r, address q) external {
        claimVault = v;
        token = t;
        recipient = r;
        quote = q;
    }
    function poolAssets(bytes32) external view returns (address, address, bool) {
        return (token, quote, true);
    }
    function poolRecipients(bytes32) external view returns (address, address, address, address) {
        return (address(0), address(0), address(0), recipient);
    }
    function accrue(bytes32 id, uint256 n) external {
        utilityLiability[id] += n;
    }
    function redeem(bytes32 id, uint256 n) external {
        require(msg.sender == claimVault);
        utilityRedeemed[id] += n;
    }
}
contract MockVault {
    MockHook public hook;
    constructor(MockHook h) {
        hook = h;
    }
    receive() external payable {}
    function redeem(bytes32 id, uint8 bucket, uint256 n) external {
        require(bucket == 3 && msg.sender == hook.recipient());
        hook.redeem(id, n);
        (bool ok, ) = msg.sender.call{value: n}('');
        require(ok);
    }
}
contract MockRouter {
    MockToken public token;
    uint256 public multiplier = 1000;
    constructor(MockToken t) {
        token = t;
    }
    function setMultiplier(uint256 n) external {
        multiplier = n;
    }
    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        token.mint(msg.sender, msg.value * multiplier);
    }
}
contract MockV2 {
    address public WETH;
    address public factory;
    MockToken public lp;
    constructor(address w) {
        WETH = w;
        factory = address(this);
        lp = new MockToken();
    }
    function getPair(address, address) external view returns (address) {
        return address(lp);
    }
    function addLiquidityETH(
        address token,
        uint256 desired,
        uint256 minT,
        uint256 minE,
        address to,
        uint256 deadline
    ) external payable returns (uint256, uint256, uint256) {
        require(block.timestamp <= deadline && desired >= minT && msg.value >= minE);
        MockToken(token).transferFrom(msg.sender, address(this), desired);
        lp.mint(to, msg.value);
        return (desired, msg.value, msg.value);
    }
}
contract RejectETH {
    receive() external payable {
        revert();
    }
    function withdraw(UtilityEngine e, address payable to) external {
        e.withdrawDeferred(to);
    }
}
contract RecoveryReceiver {
    UtilityEngine public engine;
    bool public reentered;
    function configure(UtilityEngine value) external {
        engine = value;
    }
    function accept() external {
        engine.acceptOwnership();
    }
    function recover(uint256 amount) external {
        engine.emergencyWithdrawETH(payable(address(this)), amount);
    }
    receive() external payable {
        (reentered, ) = address(engine).call(
            abi.encodeCall(engine.emergencyWithdrawETH, (payable(address(this)), 1))
        );
    }
}
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 n) external {
        balanceOf[to] += n;
    }
    function transfer(address to, uint256 n) external {
        balanceOf[msg.sender] -= n;
        balanceOf[to] += n;
    }
}
contract FalseReturnToken {
    function balanceOf(address) external pure returns (uint256) {
        return 100;
    }
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}
