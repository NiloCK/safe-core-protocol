// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.18;
import {ISafeProtocolRegistry} from "./interfaces/Registry.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Enum} from "./common/Enum.sol";
import {ISafeProtocolFunctionHandler, ISafeProtocolHooks, ISafeProtocolPlugin} from "./interfaces/Modules.sol";
import {MODULE_TYPE_PLUGIN, MODULE_TYPE_HOOKS, MODULE_TYPE_FUNCTION_HANDLER} from "./common/Constants.sol";

contract SafeProtocolRegistry is ISafeProtocolRegistry, Ownable2Step {
    mapping(address => ModuleInfo) public listedModules;

    struct ModuleInfo {
        uint64 listedAt;
        uint64 flaggedAt;
        uint8 moduleTypes;
    }

    error CannotFlagModule(address module);
    error CannotAddModule(address module, uint8 moduleTypes);
    error ModuleDoesNotSupportExpectedInterfaceId(address module, bytes4 expectedInterfaceId);

    event ModuleAdded(address indexed module);
    event ModuleFlagged(address indexed module);

    constructor(address initialOwner) {
        _transferOwnership(initialOwner);
    }

    /**
     * @notice This function returns information about a module
     * @param module Address of the module to be checked
     * @return listedAt Timestamp of listing the module. This value will be 0 if not listed.
     * @return flaggedAt Timestamp of falgging the module. This value will be 0 if not flagged.
     */
    function check(address module, bytes32 data) external view returns (uint64 listedAt, uint64 flaggedAt) {
        ModuleInfo memory moduleInfo = listedModules[module];
        listedAt = moduleInfo.listedAt;
        flaggedAt = moduleInfo.flaggedAt;

        // If moduleType is not permitted, return 0 for listedAt and flaggedAt.
        if (moduleInfo.moduleTypes & uint8(uint256(data)) == 0) {
            listedAt = 0;
            flaggedAt = 0;
        }
    }

    /**
     * @notice Allows only owner to add a module. A module can be any address including zero address for now.
     *         This function does not permit adding a module twice. This function validates if module supports expected interfaceId.
     * @param module Address of the module
     * @param moduleTypes uint8 indicating the types of module
     */
    function addModule(address module, uint8 moduleTypes) external virtual onlyOwner {
        _addModule(module, moduleTypes);
    }

    function _addModule(address module, uint8 moduleTypes) internal {
        ModuleInfo memory moduleInfo = listedModules[module];

        // Check if module is already listed or if moduleTypes is greater than 8.
        // Maximum allowed value of moduleTypes is 7. i.e. 2^0 (Plugin) + 2^1 (Function Handler) + 2^2 (Hooks)
        if (moduleInfo.listedAt != 0 || moduleTypes > 7) {
            revert CannotAddModule(module, moduleTypes);
        }

        // Check if module supports expected interface
        if (
            moduleTypes & MODULE_TYPE_HOOKS == MODULE_TYPE_HOOKS && !IERC165(module).supportsInterface(type(ISafeProtocolHooks).interfaceId)
        ) {
            revert ModuleDoesNotSupportExpectedInterfaceId(module, type(ISafeProtocolHooks).interfaceId);
        }

        if (
            moduleTypes & MODULE_TYPE_PLUGIN == MODULE_TYPE_PLUGIN &&
            !IERC165(module).supportsInterface(type(ISafeProtocolPlugin).interfaceId)
        ) {
            revert ModuleDoesNotSupportExpectedInterfaceId(module, type(ISafeProtocolPlugin).interfaceId);
        }

        if (
            moduleTypes & MODULE_TYPE_FUNCTION_HANDLER == MODULE_TYPE_FUNCTION_HANDLER &&
            !IERC165(module).supportsInterface(type(ISafeProtocolFunctionHandler).interfaceId)
        ) {
            revert ModuleDoesNotSupportExpectedInterfaceId(module, type(ISafeProtocolFunctionHandler).interfaceId);
        }

        listedModules[module] = ModuleInfo(uint64(block.timestamp), 0, moduleTypes);
        emit ModuleAdded(module);
    }

    /**
     * @notice Allows only owner to flad a module. Only previously added module can be flagged.
     *         This function does not permit flagging a module twice.
     *         A module can be any address including zero address for now.
     * @param module Address of the module
     */
    function flagModule(address module) external onlyOwner {
        ModuleInfo memory moduleInfo = listedModules[module];

        if (moduleInfo.listedAt == 0 || moduleInfo.flaggedAt != 0) {
            revert CannotFlagModule(module);
        }

        listedModules[module] = ModuleInfo(moduleInfo.listedAt, uint64(block.timestamp), moduleInfo.moduleTypes);
        emit ModuleFlagged(module);
    }

    function supportsInterface(bytes4 interfaceId) external view override returns (bool) {
        return interfaceId == type(ISafeProtocolRegistry).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
