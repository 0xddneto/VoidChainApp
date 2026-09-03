// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VoidChainDao, IVoidChainAppRuntime} from "./VoidChainDao.sol";

interface IRuntimeDaoRegistry {
    function registerDao(uint256 tokenId, address dao) external;
}

/// @title VoidChainDaoFactory
/// @notice Gives every chain a DAO of its own.
///
/// @dev    WHY CLONES.
///
///         Each chain having its own DAO means its own address and its own
///         storage — a bug or a griefed proposal on one chain does not reach the
///         other 1,110, and a chain can be pointed at a different governor
///         without the protocol's permission. Deploying the full contract 1,111
///         times would post the same bytecode 1,111 times to the parent chain's
///         data layer, which is what makes that expensive.
///
///         A minimal proxy is 45 bytes that delegate to one shared
///         implementation. The address is the chain's own, the storage is the
///         chain's own, and the code is written down once.
///
///         WHY THE ADDRESS IS DETERMINISTIC.
///
///         `cloneDeterministic` derives the address from the tokenId, so a
///         chain's DAO can be computed before it exists and cannot be
///         front-run: nobody can occupy chain #7's address and register
///         themselves as its DAO, because that address is only reachable
///         through this contract with that salt.
contract VoidChainDaoFactory {
    /// @notice The contract every clone delegates to.
    address public immutable implementation;

    /// @notice The runtime the DAOs command, and the registry they appear in.
    IRuntimeDaoRegistry public immutable runtime;

    /// @notice The token voters lock while their vote is counted.
    IERC20 public immutable voidToken;

    uint256 public constant TOTAL_CHAINS = 1111;

    mapping(uint256 tokenId => address) public daoOf;

    event DaoCreated(uint256 indexed tokenId, address dao);

    error ZeroAddress();
    error NoSuchChain(uint256 tokenId);
    error AlreadyCreated(uint256 tokenId, address dao);

    constructor(IVoidChainAppRuntime runtime_, IERC20 voidToken_) {
        if (address(runtime_) == address(0) || address(voidToken_) == address(0)) revert ZeroAddress();
        runtime = IRuntimeDaoRegistry(address(runtime_));
        voidToken = voidToken_;

        VoidChainDao master = new VoidChainDao();
        // The master copy is bound to a chain that cannot exist, so nobody can
        // claim it and point it at a real one. Clones are unaffected: they carry
        // their own storage and start unbound.
        master.initialise(type(uint256).max, runtime_, voidToken_);
        implementation = address(master);
    }

    /// @notice Creates the DAO for one chain. Open to anyone, once per chain.
    ///
    /// @dev    Open because the address is derived from the tokenId and the DAO
    ///         is bound to that chain on creation — whoever calls it chooses
    ///         nothing and gains nothing, they only pay the gas for a contract
    ///         that was always going to exist at that address.
    function create(uint256 tokenId) external returns (address dao) {
        if (tokenId == 0 || tokenId > TOTAL_CHAINS) revert NoSuchChain(tokenId);
        address existing = daoOf[tokenId];
        if (existing != address(0)) revert AlreadyCreated(tokenId, existing);

        dao = Clones.cloneDeterministic(implementation, bytes32(tokenId));
        VoidChainDao(dao).initialise(tokenId, IVoidChainAppRuntime(address(runtime)), voidToken);

        daoOf[tokenId] = dao;
        runtime.registerDao(tokenId, dao);

        emit DaoCreated(tokenId, dao);
    }

    /// @notice Creates a run of DAOs in one transaction.
    ///
    /// @dev    Only for standing the collection up: 1,111 separate transactions
    ///         would pay 1,111 base costs to do the same work. A chain already
    ///         created is skipped rather than reverting, so a batch that
    ///         overlaps a previous one still goes through — otherwise a single
    ///         retry after a dropped transaction would have to be reconstructed
    ///         by hand.
    function createMany(uint256 from, uint256 to) external {
        if (from == 0 || to > TOTAL_CHAINS || from > to) revert NoSuchChain(from);
        for (uint256 id = from; id <= to; ++id) {
            if (daoOf[id] != address(0)) continue;

            address dao = Clones.cloneDeterministic(implementation, bytes32(id));
            VoidChainDao(dao).initialise(id, IVoidChainAppRuntime(address(runtime)), voidToken);

            daoOf[id] = dao;
            runtime.registerDao(id, dao);

            emit DaoCreated(id, dao);
        }
    }

    /// @notice Where a chain's DAO will live, before it is created.
    function predict(uint256 tokenId) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, bytes32(tokenId), address(this));
    }
}
